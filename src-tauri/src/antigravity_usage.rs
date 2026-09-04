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

#[tauri::command]
pub async fn get_antigravity_usage() -> Result<AntigravityUsage, String> {
    tauri::async_runtime::spawn_blocking(|| match snapshot_path() {
        Ok(path) => read_snapshot(&path),
        Err(error) => result("unavailable", Some(error), Vec::new(), now_ms()),
    })
    .await
    .map_err(|error| format!("Antigravity usage task failed: {error}"))
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
                && matches!(
                    item.id.as_str(),
                    "gemini-5h" | "gemini-weekly" | "3p-5h" | "3p-weekly"
                )
        })
        .collect::<Vec<_>>();
    windows.sort_by_key(|item| {
        (
            if item.scope == "Gemini" { 0 } else { 1 },
            if item.window == "session" { 0 } else { 1 },
        )
    });
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
    fn rejects_unknown_and_out_of_range_buckets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SNAPSHOT_NAME);
        fs::write(&path, r#"{"windows":[{"id":"future-bucket","scope":"Gemini","window":"weekly","remainingPercent":50,"resetDescription":null},{"id":"gemini-weekly","scope":"Gemini","window":"weekly","remainingPercent":101,"resetDescription":null}],"updatedAt":1234}"#).unwrap();
        assert_eq!(read_snapshot(&path).status, "unavailable");
    }

    #[test]
    fn missing_snapshot_is_non_interactive_unavailable_state() {
        let directory = tempfile::tempdir().unwrap();
        let usage = read_snapshot(&directory.path().join(SNAPSHOT_NAME));
        assert_eq!(usage.status, "unavailable");
        assert!(usage.windows.is_empty());
    }
}
