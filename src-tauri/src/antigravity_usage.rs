use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SNAPSHOT_NAME: &str = "antigravity-usage.json";

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaWindow {
    pub id: String,
    pub scope: String,
    pub window: String,
    pub remaining_percent: f64,
    pub reset_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AntigravityUsageSnapshot {
    windows: Vec<AntigravityQuotaWindow>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityUsage {
    pub windows: Vec<AntigravityQuotaWindow>,
    pub updated_at: i64,
    pub error: Option<String>,
    pub status: String,
}

use crate::usage_cache::{
    file_revision, fingerprint, query_cached, SharedUsageCache, UsageResponse, UsageSnapshot,
};
use std::sync::OnceLock;
use tauri::Emitter;

impl UsageSnapshot for AntigravityUsage {
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

#[tauri::command]
pub async fn get_antigravity_usage(
    app: tauri::AppHandle,
    force_refresh: Option<bool>,
) -> Result<UsageResponse<AntigravityUsage>, String> {
    let requested_at = now_ms();
    let result = tauri::async_runtime::spawn_blocking(move || {
        static CACHE: OnceLock<SharedUsageCache<AntigravityUsage>> = OnceLock::new();
        let path = snapshot_path();
        let key = fingerprint(path.as_ref().ok());
        let revision = path
            .as_ref()
            .map(|path| file_revision(path))
            .unwrap_or_default();
        query_cached(
            CACHE.get_or_init(Default::default),
            key,
            revision,
            requested_at,
            force_refresh.unwrap_or(false),
            || {
                Ok(match path {
                    Ok(path) => read_snapshot(&path),
                    Err(error) => result("unavailable", Some(error), Vec::new(), now_ms()),
                })
            },
        )
    })
    .await
    .map_err(|error| format!("Antigravity usage task failed: {error}"))?;
    if let Ok(value) = &result {
        let _ = app.emit("antigravity-usage-updated", value);
    }
    result
}

fn snapshot_path() -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or("无法读取用户主目录")?;
    Ok(home
        .join(".termflow")
        .join("agent-hooks")
        .join(SNAPSHOT_NAME))
}

fn read_snapshot(path: &Path) -> AntigravityUsage {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return result(
                "unavailable",
                Some("Start an Antigravity session to collect quota".into()),
                Vec::new(),
                now_ms(),
            );
        }
        Err(error) => {
            return result(
                "error",
                Some(format!(
                    "Failed to read Antigravity quota snapshot: {error}"
                )),
                Vec::new(),
                now_ms(),
            )
        }
    };
    let snapshot: AntigravityUsageSnapshot = match serde_json::from_str(&text) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return result(
                "error",
                Some(format!("Invalid Antigravity quota snapshot: {error}")),
                Vec::new(),
                now_ms(),
            )
        }
    };
    let mut windows = snapshot
        .windows
        .into_iter()
        .filter(|item| {
            item.remaining_percent.is_finite()
                && (0.0..=100.0).contains(&item.remaining_percent)
                && !item.id.is_empty()
                && item.id.len() <= 64
                && item
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
                && !item.scope.is_empty()
                && item.scope.len() <= 64
                && item.scope.chars().all(|character| !character.is_control())
                && !item.window.is_empty()
                && item.window.len() <= 24
                && item
                    .window
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && item
                    .reset_description
                    .as_ref()
                    .is_none_or(|reset| reset.len() <= 64)
        })
        .take(32)
        .collect::<Vec<_>>();
    windows.sort_by_key(|item| {
        let group = match item.scope.as_str() {
            "Gemini" => 0,
            "Claude and GPT" => 1,
            _ => 2,
        };
        let period = match item.window.as_str() {
            "session" => 0,
            "weekly" => 1,
            _ => 2,
        };
        (group, item.scope.clone(), period, item.id.clone())
    });
    windows.dedup_by(|left, right| left.id == right.id);
    if windows.is_empty() {
        return result(
            "unavailable",
            Some("Antigravity has not reported quota yet".into()),
            windows,
            snapshot.updated_at,
        );
    }
    result("ok", None, windows, snapshot.updated_at)
}

fn result(
    status: &str,
    error: Option<String>,
    windows: Vec<AntigravityQuotaWindow>,
    updated_at: i64,
) -> AntigravityUsage {
    AntigravityUsage {
        windows,
        updated_at,
        error,
        status: status.to_string(),
    }
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
    fn malformed_snapshot_retains_success_and_new_file_recovers_during_backoff() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join(SNAPSHOT_NAME);
        let valid = r#"{"windows":[{"id":"weekly","scope":"Gemini","window":"weekly","remainingPercent":0,"resetDescription":null}],"updatedAt":1234}"#;
        fs::write(&path, valid).expect("snapshot");
        let cache = SharedUsageCache::default();
        let requested = now_ms();
        query_cached(&cache, 1, file_revision(&path), requested, false, || {
            Ok(read_snapshot(&path))
        })
        .expect("initial");
        fs::write(&path, "invalid").expect("invalid snapshot");
        let failed = query_cached(
            &cache,
            1,
            file_revision(&path),
            requested + 1,
            false,
            || Ok(read_snapshot(&path)),
        )
        .expect("retained");
        assert_eq!(failed.snapshot.windows[0].remaining_percent, 0.0);
        assert_eq!(failed.snapshot.updated_at, 1234);
        assert_eq!(failed.snapshot.status, "error");
        fs::write(&path, valid.replace("1234", "56789")).expect("new snapshot");
        let recovered = query_cached(
            &cache,
            1,
            file_revision(&path),
            requested + 2,
            false,
            || Ok(read_snapshot(&path)),
        )
        .expect("recovered");
        assert_eq!(recovered.snapshot.status, "ok");
        assert_eq!(recovered.snapshot.updated_at, 56789);
    }

    #[test]
    fn reads_and_orders_sanitized_statusline_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SNAPSHOT_NAME);
        fs::write(&path, r#"{"windows":[{"id":"3p-weekly","scope":"Claude and GPT","window":"weekly","remainingPercent":41,"resetDescription":"2026-09-10T07:50:32Z"},{"id":"gemini-5h","scope":"Gemini","window":"session","remainingPercent":98.25,"resetDescription":null}],"updatedAt":1234}"#).unwrap();
        let usage = read_snapshot(&path);
        assert_eq!(usage.status, "ok");
        assert_eq!(usage.updated_at, 1234);
        assert_eq!(usage.windows[0].id, "gemini-5h");
        assert_eq!(usage.windows[1].id, "3p-weekly");
    }

    #[test]
    fn rejects_invalid_and_out_of_range_buckets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SNAPSHOT_NAME);
        fs::write(&path, r#"{"windows":[{"id":"bad bucket","scope":"Gemini","window":"weekly","remainingPercent":50,"resetDescription":null},{"id":"gemini-weekly","scope":"Gemini","window":"weekly","remainingPercent":101,"resetDescription":null}],"updatedAt":1234}"#).unwrap();
        assert_eq!(read_snapshot(&path).status, "unavailable");
    }

    #[test]
    fn accepts_separate_argon_weekly_bucket() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SNAPSHOT_NAME);
        fs::write(&path, r#"{"windows":[{"id":"argon-weekly","scope":"Argon","window":"weekly","remainingPercent":56.04,"resetDescription":"2026-10-23T03:47:23Z"}],"updatedAt":1234}"#).unwrap();
        let usage = read_snapshot(&path);
        assert_eq!(usage.status, "ok");
        assert_eq!(usage.windows[0].remaining_percent, 56.04);
    }

    #[test]
    fn accepts_future_quota_bucket_without_a_code_change() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SNAPSHOT_NAME);
        fs::write(&path, r#"{"windows":[{"id":"new-model-monthly","scope":"new model","window":"monthly","remainingPercent":72,"resetDescription":null}],"updatedAt":1234}"#).unwrap();
        let usage = read_snapshot(&path);
        assert_eq!(usage.status, "ok");
        assert_eq!(usage.windows[0].id, "new-model-monthly");
    }

    #[test]
    fn missing_snapshot_is_non_interactive_unavailable_state() {
        let directory = tempfile::tempdir().unwrap();
        let usage = read_snapshot(&directory.path().join(SNAPSHOT_NAME));
        assert_eq!(usage.status, "unavailable");
        assert!(usage.windows.is_empty());
    }
}
