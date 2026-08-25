use crate::commands::agents::find_agent_executable;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DIAGNOSTIC_OUTPUT_LENGTH: usize = 100_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderQuotaBucket {
    pub total: Option<f64>,
    pub cap: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub percentage: Option<f64>,
    pub available: Option<bool>,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderUsage {
    pub user_type: Option<String>,
    pub total_usage_percentage: Option<f64>,
    pub expires_at: Option<i64>,
    pub user_quota: Option<QoderQuotaBucket>,
    pub add_on_quota: Option<QoderQuotaBucket>,
    pub org_resource_package: Option<QoderQuotaBucket>,
    pub is_quota_exceeded: Option<bool>,
    pub session_credits: Option<f64>,
    pub updated_at: i64,
    pub error: Option<String>,
    pub status: String,
    pub account_label: Option<String>,
}

#[tauri::command]
pub async fn get_qoder_usage() -> Result<QoderUsage, String> {
    tauri::async_runtime::spawn_blocking(fetch_qoder_usage)
        .await
        .map_err(|error| format!("Qoder usage task failed: {error}"))
}

fn fetch_qoder_usage() -> QoderUsage {
    let executable = match find_agent_executable("qoder") {
        Ok(path) => path,
        Err(_) => return unavailable_result("Qoder CLI CN not found"),
    };

    fetch_via_control_protocol(&executable)
}

fn unavailable_result(error: &str) -> QoderUsage {
    QoderUsage {
        user_type: None,
        total_usage_percentage: None,
        expires_at: None,
        user_quota: None,
        add_on_quota: None,
        org_resource_package: None,
        is_quota_exceeded: None,
        session_credits: None,
        updated_at: now_ms(),
        error: Some(error.to_string()),
        status: "unavailable".to_string(),
        account_label: None,
    }
}

fn error_result(error: String, account_label: Option<String>) -> QoderUsage {
    QoderUsage {
        account_label,
        status: "error".to_string(),
        error: Some(error),
        ..unavailable_result("")
    }
}

fn fetch_via_control_protocol(executable: &str) -> QoderUsage {
    let mut child = match spawn_qoder_sdk_process(executable) {
        Ok(child) => child,
        Err(error) => return error_result(error, None),
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return error_result("Qoder SDK stdin unavailable".to_string(), None);
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return error_result("Qoder SDK stdout unavailable".to_string(), None);
    };

    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        spawn_limited_stderr_reader(stderr, stderr_buffer.clone());
    }

    let (line_tx, line_rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });

    // Official Qoder Agent SDK protocol and quota API:
    // https://docs.qoder.com/cli/sdk/how-it-works
    // https://docs.qoder.com/cli/sdk/cost-usage
    if let Err(error) = write_control_request(
        &mut stdin,
        "termflow-initialize",
        json!({
            "type": "initialize",
            "allowedTools": [],
            "disallowedTools": [],
            "permissionMode": "dont_ask"
        }),
    ) {
        let _ = child.kill();
        return error_result(error, None);
    }

    let deadline = Instant::now() + CONTROL_TIMEOUT;
    let mut account_label = None;
    let mut usage_requested = false;

    loop {
        let now = Instant::now();
        if now >= deadline {
            let stderr = diagnostic_snapshot(&stderr_buffer);
            let _ = child.kill();
            let _ = child.wait();
            return error_result(
                diagnostic_message("Qoder usage timeout", &stderr),
                account_label,
            );
        }

        let remaining = deadline.saturating_duration_since(now);
        match line_rx.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(line) => {
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let Some(response) = message.get("response") else {
                    continue;
                };
                let request_id = response
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                if request_id == "termflow-initialize" {
                    if let Some(error) = control_error_message(response) {
                        let _ = child.kill();
                        return error_result(error, account_label);
                    }
                    account_label = response
                        .get("response")
                        .and_then(|value| value.get("account"))
                        .and_then(|value| value.get("name"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string);
                    if !usage_requested {
                        usage_requested = true;
                        if let Err(error) = write_control_request(
                            &mut stdin,
                            "termflow-usage",
                            json!({ "type": "get_usage_info" }),
                        ) {
                            let _ = child.kill();
                            return error_result(error, account_label);
                        }
                    }
                    continue;
                }

                if request_id == "termflow-usage" {
                    let result = if let Some(error) = control_error_message(response) {
                        error_result(error, account_label)
                    } else {
                        map_usage_response(response.get("response"), account_label)
                    };
                    let _ = child.kill();
                    let _ = child.wait();
                    return result;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(_)) = child.try_wait() {
                    let stderr = diagnostic_snapshot(&stderr_buffer);
                    return error_result(
                        diagnostic_message("Qoder usage process exited unexpectedly", &stderr),
                        account_label,
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let stderr = diagnostic_snapshot(&stderr_buffer);
                let _ = child.wait();
                return error_result(
                    diagnostic_message("Qoder usage process exited unexpectedly", &stderr),
                    account_label,
                );
            }
        }
    }
}

fn spawn_qoder_sdk_process(executable: &str) -> Result<Child, String> {
    // These flags mirror the official Agent SDK process transport. Disabling
    // persistence and setting sources keeps quota polling from creating local
    // sessions or running Termflow's normal project/user hooks.
    // https://docs.qoder.com/cli/sdk/overview
    // https://docs.qoder.com/cli/sdk/references-typescript
    let args = [
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--tools",
        "",
        "--disable-builtin-skills",
        "--permission-mode",
        "dont_ask",
        "--setting-sources",
        "",
        "--no-session-persistence",
    ];
    let lower = executable.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    let mut command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/c").arg(executable).args(args);
        command
    } else if lower.ends_with(".ps1") {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            executable,
        ]);
        command.args(args);
        command
    } else {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };

    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start Qoder CLI CN SDK mode: {error}"))
}

fn write_control_request(
    stdin: &mut impl Write,
    request_id: &str,
    request: Value,
) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        json!({ "type": "control_request", "request_id": request_id, "request": request })
    )
    .map_err(|error| format!("Failed to write Qoder control request: {error}"))
}

fn control_error_message(response: &Value) -> Option<String> {
    (response.get("subtype").and_then(Value::as_str) == Some("error")).then(|| {
        response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Qoder control request failed")
            .to_string()
    })
}

fn map_usage_response(response: Option<&Value>, account_label: Option<String>) -> QoderUsage {
    let usage = response.and_then(|value| value.get("usage"));
    let session = response.and_then(|value| value.get("session"));
    let usage_error = response
        .and_then(|value| value.get("usage_error"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let has_usage = usage.is_some_and(Value::is_object);
    let session_credits = session
        .and_then(|value| value.get("total_credits"))
        .and_then(Value::as_f64);
    if !has_usage && session_credits.is_none() {
        return error_result(
            usage_error.unwrap_or_else(|| "Qoder usage is unavailable".to_string()),
            account_label,
        );
    }

    QoderUsage {
        user_type: usage.and_then(|value| read_string(value, "userType")),
        total_usage_percentage: usage
            .and_then(|value| value.get("totalUsagePercentage"))
            .and_then(Value::as_f64),
        expires_at: usage
            .and_then(|value| value.get("expiresAt"))
            .and_then(Value::as_i64),
        user_quota: usage
            .and_then(|value| value.get("userQuota"))
            .and_then(map_quota_bucket),
        add_on_quota: usage
            .and_then(|value| value.get("addOnQuota"))
            .and_then(map_quota_bucket),
        org_resource_package: usage
            .and_then(|value| value.get("orgResourcePackage"))
            .and_then(map_quota_bucket),
        is_quota_exceeded: usage
            .and_then(|value| value.get("isQuotaExceeded"))
            .and_then(Value::as_bool),
        session_credits,
        updated_at: now_ms(),
        error: usage_error,
        status: "ok".to_string(),
        account_label,
    }
}

fn map_quota_bucket(value: &Value) -> Option<QoderQuotaBucket> {
    value.is_object().then(|| QoderQuotaBucket {
        total: value.get("total").and_then(Value::as_f64),
        cap: value.get("cap").and_then(Value::as_f64),
        used: value.get("used").and_then(Value::as_f64),
        remaining: value.get("remaining").and_then(Value::as_f64),
        percentage: value.get("percentage").and_then(Value::as_f64),
        available: value.get("available").and_then(Value::as_bool),
        unit: read_string(value, "unit"),
    })
}

fn read_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn spawn_limited_stderr_reader(mut stderr: impl Read + Send + 'static, buffer: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut chunk = [0_u8; 4096];
        loop {
            let Ok(count) = stderr.read(&mut chunk) else {
                break;
            };
            if count == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&chunk[..count]);
            if let Ok(mut output) = buffer.lock() {
                output.push_str(&text);
                if output.len() > MAX_DIAGNOSTIC_OUTPUT_LENGTH {
                    let overflow = output.len() - MAX_DIAGNOSTIC_OUTPUT_LENGTH;
                    output.drain(..overflow);
                }
            }
        }
    });
}

fn diagnostic_snapshot(buffer: &Arc<Mutex<String>>) -> String {
    buffer
        .lock()
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn diagnostic_message(prefix: &str, stderr: &str) -> String {
    if stderr.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}: {stderr}")
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
    fn maps_official_usage_info_shape() {
        let result = map_usage_response(
            Some(&json!({
                "usage": {
                    "userType": "personal_professional",
                    "totalUsagePercentage": 3,
                    "expiresAt": 1_790_265_600_000_i64,
                    "userQuota": {
                        "total": 2000,
                        "used": 44,
                        "remaining": 1956,
                        "percentage": 3,
                        "unit": "credits"
                    },
                    "isQuotaExceeded": false
                },
                "session": { "total_credits": 1.25, "model_usage": {} }
            })),
            Some("Qoder user".to_string()),
        );

        assert_eq!(result.status, "ok");
        assert_eq!(result.total_usage_percentage, Some(3.0));
        assert_eq!(
            result.user_quota.as_ref().and_then(|value| value.remaining),
            Some(1956.0)
        );
        assert_eq!(result.session_credits, Some(1.25));
        assert_eq!(result.account_label.as_deref(), Some("Qoder user"));
    }

    #[test]
    fn missing_account_and_session_usage_is_not_reported_as_zero() {
        let result = map_usage_response(
            Some(&json!({ "usage": null, "usage_error": "not supported" })),
            None,
        );

        assert_eq!(result.status, "error");
        assert_eq!(result.error.as_deref(), Some("not supported"));
        assert!(result.user_quota.is_none());
    }
}
