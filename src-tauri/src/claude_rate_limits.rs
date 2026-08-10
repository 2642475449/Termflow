use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const FIVE_HOUR_WINDOW_MINUTES: u32 = 300;
const SEVEN_DAY_WINDOW_MINUTES: u32 = 10_080;
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
    limits: ClaudeRateLimits,
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

#[derive(Default)]
pub struct ClaudeRateLimitStore {
    sessions: Mutex<HashMap<String, ClaudeRateLimits>>,
}

impl ClaudeRateLimitStore {
    fn update(&self, session_id: &str, limits: ClaudeRateLimits) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if !sessions.contains_key(session_id) && sessions.len() >= MAX_CACHED_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, limits)| limits.updated_at)
                .map(|(session_id, _)| session_id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(session_id.to_string(), limits);
    }

    fn get(&self, session_id: &str) -> Option<ClaudeRateLimits> {
        self.sessions.lock().ok()?.get(session_id).cloned()
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
    store.update(&payload.session_id, limits.clone());
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
    session_id: String,
    store: State<'_, Arc<ClaudeRateLimitStore>>,
) -> ClaudeRateLimits {
    store.get(&session_id).unwrap_or_else(|| ClaudeRateLimits {
        session: None,
        weekly: None,
        updated_at: now_ms(),
        error: None,
        status: "unavailable".to_string(),
    })
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
