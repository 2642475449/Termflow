use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const FIVE_HOUR_WINDOW_MINUTES: u32 = 300;
const SEVEN_DAY_WINDOW_MINUTES: u32 = 10_080;
use crate::usage_cache::{UsageCache, UsageResponse, UsageSnapshot};

const MAX_CACHED_SESSIONS: usize = 2_048;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    pub reset_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRateLimits {
    pub session: Option<ClaudeRateLimitWindow>,
    pub weekly: Option<ClaudeRateLimitWindow>,
    pub updated_at: i64,
    pub error: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeRateLimitsUpdate {
    session_id: String,
    #[serde(flatten)]
    limits: UsageResponse<ClaudeRateLimits>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatusLineRateLimits {
    session_id: String,
    five_hour: Option<ClaudeStatusLineWindow>,
    seven_day: Option<ClaudeStatusLineWindow>,
    updated_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatusLineWindow {
    used_percent: f64,
    resets_at: Option<i64>,
}

impl UsageSnapshot for ClaudeRateLimits {
    fn status(&self) -> &str {
        &self.status
    }
    fn with_failure(&self, failure: Self) -> Self {
        Self {
            status: failure.status,
            error: failure.error,
            ..self.clone()
        }
    }
}

#[derive(Default)]
pub struct ClaudeRateLimitStore {
    sessions: Mutex<HashMap<String, UsageCache<ClaudeRateLimits>>>,
}

impl ClaudeRateLimitStore {
    fn update(
        &self,
        session_id: &str,
        limits: ClaudeRateLimits,
    ) -> Result<UsageResponse<ClaudeRateLimits>, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Claude usage cache lock poisoned".to_string())?;
        if !sessions.contains_key(session_id) && sessions.len() >= MAX_CACHED_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, entry)| entry.attempted_at)
                .map(|(id, _)| id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        let entry = sessions.entry(session_id.into()).or_default();
        let value = entry.update(limits, now_ms());
        Ok(entry.response(value))
    }

    fn query(
        &self,
        session_id: &str,
        force: bool,
        requested_at: i64,
    ) -> Result<UsageResponse<ClaudeRateLimits>, String> {
        // Hook 推送已直接更新缓存；这里只读本地数据，不发起远程查询。
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Claude usage cache lock poisoned".to_string())?;
        if let Some(entry) = sessions.get_mut(session_id) {
            if let Some(value) = entry.cached(requested_at, now_ms(), force) {
                return Ok(entry.response(value));
            }
            if let Some(value) = entry.value.clone() {
                let value = entry.update(value, now_ms());
                return Ok(entry.response(value));
            }
        }
        drop(sessions);
        self.update(
            session_id,
            ClaudeRateLimits {
                session: None,
                weekly: None,
                updated_at: 0,
                error: None,
                status: "unavailable".into(),
            },
        )
    }
}

pub fn ingest_status_line_rate_limits(
    app: &AppHandle,
    store: &Arc<ClaudeRateLimitStore>,
    body: &str,
) -> Result<(), String> {
    let payload = serde_json::from_str::<ClaudeStatusLineRateLimits>(body)
        .map_err(|error| format!("invalid Claude rate-limit payload: {error}"))?;
    if !is_safe_session_id(&payload.session_id) {
        return Err("invalid Claude rate-limit session ID".to_string());
    }

    let session = payload
        .five_hour
        .and_then(|window| map_window(window, FIVE_HOUR_WINDOW_MINUTES));
    let weekly = payload
        .seven_day
        .and_then(|window| map_window(window, SEVEN_DAY_WINDOW_MINUTES));
    let has_data = session.is_some() || weekly.is_some();
    let limits = ClaudeRateLimits {
        session,
        weekly,
        updated_at: payload.updated_at.unwrap_or_else(now_ms),
        error: None,
        status: if has_data { "ok" } else { "unavailable" }.to_string(),
    };
    let limits = store.update(&payload.session_id, limits)?;
    let _ = app.emit(
        "claude-rate-limits-update",
        ClaudeRateLimitsUpdate {
            session_id: payload.session_id,
            limits,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn get_claude_rate_limits(
    app: AppHandle,
    session_id: String,
    force_refresh: Option<bool>,
    store: State<'_, Arc<ClaudeRateLimitStore>>,
) -> Result<UsageResponse<ClaudeRateLimits>, String> {
    if !is_safe_session_id(&session_id) {
        return Err("invalid Claude rate-limit session ID".into());
    }
    let limits = store.query(&session_id, force_refresh.unwrap_or(false), now_ms())?;
    let _ = app.emit(
        "claude-rate-limits-update",
        ClaudeRateLimitsUpdate {
            session_id,
            limits: limits.clone(),
        },
    );
    Ok(limits)
}

fn map_window(
    window: ClaudeStatusLineWindow,
    window_minutes: u32,
) -> Option<ClaudeRateLimitWindow> {
    if !window.used_percent.is_finite() {
        return None;
    }
    Some(ClaudeRateLimitWindow {
        used_percent: window.used_percent.clamp(0.0, 100.0),
        window_minutes,
        resets_at: window
            .resets_at
            .filter(|timestamp| *timestamp > 0)
            .map(|timestamp| {
                if timestamp < 10_000_000_000 {
                    timestamp * 1000
                } else {
                    timestamp
                }
            }),
        reset_description: None,
    })
}

fn is_safe_session_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_updates_recover_paused_queries_and_keep_success_when_empty() {
        let store = ClaudeRateLimitStore::default();
        let missing = store.query("one", false, now_ms()).expect("missing");
        assert_eq!(missing.next_retry_at, None);
        let success = ClaudeRateLimits {
            session: Some(ClaudeRateLimitWindow {
                used_percent: 20.0,
                window_minutes: 300,
                resets_at: None,
                reset_description: None,
            }),
            weekly: None,
            updated_at: 1234,
            error: None,
            status: "ok".into(),
        };
        store.update("one", success).expect("push");
        let value = store.query("one", false, now_ms()).expect("cached");
        assert_eq!(value.snapshot.updated_at, 1234);
        assert!(value.snapshot.session.is_some());
        assert!(value.next_retry_at.is_some());
        let retained = store
            .update(
                "one",
                ClaudeRateLimits {
                    session: None,
                    weekly: None,
                    updated_at: 9999,
                    error: None,
                    status: "unavailable".into(),
                },
            )
            .expect("empty push");
        assert_eq!(retained.snapshot.updated_at, 1234);
        assert!(retained.snapshot.session.is_some());
        assert_eq!(retained.snapshot.status, "unavailable");
        assert_eq!(retained.next_retry_at, None);
        assert!(store
            .query("two", false, now_ms())
            .expect("other session")
            .snapshot
            .session
            .is_none());
    }

    #[test]
    fn maps_official_status_line_windows_to_termflow_windows() {
        let window = map_window(
            ClaudeStatusLineWindow {
                used_percent: 41.2,
                resets_at: Some(1_738_857_600),
            },
            SEVEN_DAY_WINDOW_MINUTES,
        )
        .unwrap();

        assert_eq!(window.used_percent, 41.2);
        assert_eq!(window.window_minutes, 10_080);
        assert_eq!(window.resets_at, Some(1_738_857_600_000));
    }

    #[test]
    fn clamps_invalid_percentages_and_rejects_non_finite_values() {
        assert_eq!(
            map_window(
                ClaudeStatusLineWindow {
                    used_percent: 140.0,
                    resets_at: None,
                },
                FIVE_HOUR_WINDOW_MINUTES,
            )
            .unwrap()
            .used_percent,
            100.0
        );
        assert!(map_window(
            ClaudeStatusLineWindow {
                used_percent: f64::NAN,
                resets_at: None,
            },
            FIVE_HOUR_WINDOW_MINUTES,
        )
        .is_none());
    }

    #[test]
    fn accepts_only_bounded_opaque_session_ids() {
        assert!(is_safe_session_id("397d2f86-744f-4f02-b7ec-123456789abc"));
        assert!(!is_safe_session_id("../../credentials"));
        assert!(!is_safe_session_id(""));
    }
}
