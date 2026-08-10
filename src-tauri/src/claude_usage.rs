use crate::pty::PtyManager;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Weak;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const TRANSCRIPT_POLL_INTERVAL_MS: u64 = 650;
const DEFAULT_CLAUDE_CONTEXT_WINDOW: u64 = 200_000;
const ONE_MILLION_CONTEXT_WINDOW: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageUpdatePayload {
    pub session_id: String,
    pub used_tokens: u64,
    pub context_window: Option<u64>,
    pub usage_ratio: Option<f64>,
    pub model: Option<String>,
    pub usage_source: String,
    pub context_window_source: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
struct UsageSnapshot {
    used_tokens: u64,
    context_window: Option<u64>,
    model: Option<String>,
    usage_source: String,
    context_window_source: String,
}

#[derive(Debug, Clone)]
struct WindowResolution {
    model: Option<String>,
    context_window: Option<u64>,
    context_window_source: String,
}

#[derive(Debug, Clone)]
struct TelemetrySessionInfo {
    model: Option<String>,
    betas: Option<String>,
}

pub fn spawn_usage_monitor(
    manager: Weak<PtyManager>,
    app: AppHandle,
    session_id: String,
    project_path: String,
) {
    thread::spawn(move || {
        let mut transcript_path: Option<PathBuf> = None;
        let mut read_offset = 0_u64;
        let mut pending = String::new();
        let mut last_emitted: Option<UsageSnapshot> = None;
        let mut telemetry_info: Option<TelemetrySessionInfo> = None;

        loop {
            let Some(manager) = manager.upgrade() else {
                break;
            };
            if !manager.is_session_active(&session_id) {
                break;
            }

            if transcript_path.is_none() {
                transcript_path = find_transcript_path(&project_path, &session_id);
                if transcript_path.is_none() {
                    thread::sleep(Duration::from_millis(TRANSCRIPT_POLL_INTERVAL_MS));
                    continue;
                }
            }

            let Some(path) = transcript_path.as_ref() else {
                thread::sleep(Duration::from_millis(TRANSCRIPT_POLL_INTERVAL_MS));
                continue;
            };

            if !path.exists() {
                transcript_path = None;
                read_offset = 0;
                pending.clear();
                thread::sleep(Duration::from_millis(TRANSCRIPT_POLL_INTERVAL_MS));
                continue;
            }

            let resolution = resolve_context_window(
                telemetry_info.as_ref(),
                last_emitted
                    .as_ref()
                    .and_then(|snapshot| snapshot.model.as_deref()),
            );

            match read_appended_lines(path, &mut read_offset, &mut pending) {
                Ok(lines) => {
                    let mut latest_snapshot: Option<UsageSnapshot> = None;
                    let mut latest_model = resolution.model.clone();

                    for line in lines {
                        if let Some(parsed) = parse_usage_snapshot(&line, &resolution) {
                            latest_model = parsed.model.clone().or(latest_model);
                            latest_snapshot = Some(parsed);
                        }
                    }

                    if telemetry_info.is_none() || resolution.context_window.is_none() {
                        telemetry_info = find_session_telemetry(&session_id);
                    }

                    if let Some(mut snapshot) = latest_snapshot {
                        let refined = resolve_context_window(
                            telemetry_info.as_ref(),
                            snapshot.model.as_deref().or(latest_model.as_deref()),
                        );
                        snapshot.model = snapshot.model.or(refined.model.clone());
                        snapshot.context_window = refined.context_window;
                        snapshot.context_window_source = refined.context_window_source;

                        if last_emitted.as_ref() != Some(&snapshot) {
                            emit_usage_snapshot(&app, &session_id, &snapshot);
                            last_emitted = Some(snapshot);
                        }
                    }
                }
                Err(_) => {
                    transcript_path = None;
                    read_offset = 0;
                    pending.clear();
                }
            }

            thread::sleep(Duration::from_millis(TRANSCRIPT_POLL_INTERVAL_MS));
        }
    });
}

fn emit_usage_snapshot(app: &AppHandle, session_id: &str, snapshot: &UsageSnapshot) {
    let payload = SessionUsageUpdatePayload {
        session_id: session_id.to_string(),
        used_tokens: snapshot.used_tokens,
        context_window: snapshot.context_window,
        usage_ratio: snapshot
            .context_window
            .filter(|window| *window > 0)
            .map(|window| snapshot.used_tokens as f64 / window as f64),
        model: snapshot.model.clone(),
        usage_source: snapshot.usage_source.clone(),
        context_window_source: snapshot.context_window_source.clone(),
        updated_at: now_ms(),
    };

    let _ = app.emit("session-usage-update", payload);
}

fn parse_usage_snapshot(line: &str, resolution: &WindowResolution) -> Option<UsageSnapshot> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let message = value.get("message")?;
    let role = message.get("role")?.as_str()?;
    if role != "assistant" {
        return None;
    }

    let usage = message.get("usage")?;
    let used_tokens = usage_total(usage);
    if used_tokens == 0 {
        return None;
    }

    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToString::to_string)
        .or_else(|| resolution.model.clone());

    Some(UsageSnapshot {
        used_tokens,
        context_window: resolution.context_window,
        model,
        usage_source: "transcript".to_string(),
        context_window_source: resolution.context_window_source.clone(),
    })
}

fn usage_total(usage: &Value) -> u64 {
    [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|key| usage.get(*key))
    .filter_map(Value::as_u64)
    .sum()
}

fn resolve_context_window(
    telemetry: Option<&TelemetrySessionInfo>,
    model_hint: Option<&str>,
) -> WindowResolution {
    if let Some(info) = telemetry {
        if let Some(model) = info.model.as_deref() {
            if let Some(window) = infer_context_window_from_model(model) {
                return WindowResolution {
                    model: Some(strip_context_suffix(model)),
                    context_window: Some(window),
                    context_window_source: "telemetry-model".to_string(),
                };
            }
        }

        if info
            .betas
            .as_deref()
            .is_some_and(|betas| betas.to_ascii_lowercase().contains("context-1m"))
        {
            return WindowResolution {
                model: info.model.as_deref().map(strip_context_suffix),
                context_window: Some(ONE_MILLION_CONTEXT_WINDOW),
                context_window_source: "telemetry-model".to_string(),
            };
        }
    }

    if let Some(model) = model_hint {
        if let Some(window) = infer_context_window_from_model(model) {
            return WindowResolution {
                model: Some(strip_context_suffix(model)),
                context_window: Some(window),
                context_window_source: "model-estimate".to_string(),
            };
        }
    }

    WindowResolution {
        model: model_hint.map(strip_context_suffix),
        context_window: None,
        context_window_source: "unknown".to_string(),
    }
}

fn infer_context_window_from_model(model: &str) -> Option<u64> {
    let lower = model.to_ascii_lowercase();
    if lower.contains("[1m]")
        || lower.contains(" 1m")
        || lower.contains("-1m")
        || lower.contains("_1m")
        || lower.contains("1m]")
    {
        return Some(ONE_MILLION_CONTEXT_WINDOW);
    }

    if lower.contains("claude") {
        return Some(DEFAULT_CLAUDE_CONTEXT_WINDOW);
    }

    None
}

fn strip_context_suffix(model: &str) -> String {
    model
        .replace("[1m]", "")
        .trim()
        .trim_end_matches('-')
        .trim()
        .to_string()
}

fn read_appended_lines(
    path: &Path,
    read_offset: &mut u64,
    pending: &mut String,
) -> Result<Vec<String>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() < *read_offset {
        *read_offset = 0;
        pending.clear();
    }

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(*read_offset))
        .map_err(|error| error.to_string())?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;

    if buffer.is_empty() {
        return Ok(Vec::new());
    }

    *read_offset += buffer.len() as u64;
    pending.push_str(&String::from_utf8_lossy(&buffer));

    let mut lines = Vec::new();
    while let Some(pos) = pending.find('\n') {
        let line = pending[..pos].trim();
        if !line.is_empty() {
            lines.push(line.to_string());
        }
        pending.drain(..=pos);
    }

    Ok(lines)
}

fn find_transcript_path(project_path: &str, session_id: &str) -> Option<PathBuf> {
    let claude_root = claude_root_dir()?;
    let projects_dir = claude_root.join("projects");
    let expected_dir = projects_dir.join(claude_project_dir_name(project_path));
    let expected_file = expected_dir.join(format!("{}.jsonl", session_id));
    if expected_file.exists() {
        return Some(expected_file);
    }

    let entries = fs::read_dir(projects_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(format!("{}.jsonl", session_id));
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn find_session_telemetry(session_id: &str) -> Option<TelemetrySessionInfo> {
    let telemetry_dir = claude_root_dir()?.join("telemetry");
    let entries = fs::read_dir(telemetry_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy();
        if !file_name.contains(session_id)
            || path.extension().and_then(|ext| ext.to_str()) != Some("json")
        {
            continue;
        }

        let content = fs::read_to_string(&path).ok()?;
        for line in content.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(event_data) = value.get("event_data") else {
                continue;
            };
            let Some(event_session_id) = event_data.get("session_id").and_then(Value::as_str)
            else {
                continue;
            };
            if event_session_id != session_id {
                continue;
            }

            return Some(TelemetrySessionInfo {
                model: event_data
                    .get("model")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                betas: event_data
                    .get("betas")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            });
        }
    }

    None
}

fn claude_root_dir() -> Option<PathBuf> {
    dirs_next::home_dir().map(|home| home.join(".claude"))
}

fn claude_project_dir_name(project_path: &str) -> String {
    project_path
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_usage_from_transcript_line() {
        let line = r#"{"message":{"role":"assistant","model":"mimo-v2.5-pro","usage":{"input_tokens":29211,"output_tokens":120,"cache_read_input_tokens":1024,"cache_creation_input_tokens":0}}}"#;
        let snapshot = parse_usage_snapshot(
            line,
            &WindowResolution {
                model: Some("mimo-v2.5-pro".to_string()),
                context_window: Some(1_000_000),
                context_window_source: "telemetry-model".to_string(),
            },
        )
        .expect("snapshot");

        assert_eq!(snapshot.used_tokens, 30_355);
        assert_eq!(snapshot.context_window, Some(1_000_000));
        assert_eq!(snapshot.model.as_deref(), Some("mimo-v2.5-pro"));
    }

    #[test]
    fn ignores_zero_usage_intermediate_messages() {
        let line = r#"{"message":{"role":"assistant","model":"mimo-v2.5-pro","usage":{"input_tokens":0,"output_tokens":0}}}"#;
        assert!(parse_usage_snapshot(
            line,
            &WindowResolution {
                model: None,
                context_window: None,
                context_window_source: "unknown".to_string(),
            },
        )
        .is_none());
    }

    #[test]
    fn infers_project_directory_name_like_claude() {
        assert_eq!(
            claude_project_dir_name(r"D:\3.project\Termflow"),
            "D--3-project-Termflow"
        );
    }

    #[test]
    fn infers_one_million_window_from_suffix() {
        assert_eq!(
            infer_context_window_from_model("mimo-v2.5-pro[1m]"),
            Some(1_000_000)
        );
    }
}
