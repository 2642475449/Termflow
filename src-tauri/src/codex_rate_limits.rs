use crate::commands::agents::find_agent_executable;
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DIAGNOSTIC_OUTPUT_LENGTH: usize = 100_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    pub reset_description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitResetCredits {
    pub available_count: u32,
    pub total_earned_count: Option<u32>,
    pub next_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    pub session: Option<CodexRateLimitWindow>,
    pub weekly: Option<CodexRateLimitWindow>,
    pub rate_limit_reset_credits: Option<CodexRateLimitResetCredits>,
    pub updated_at: i64,
    pub error: Option<String>,
    pub status: String,
    pub account_label: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CodexIdentity {
    account_label: Option<String>,
    account_id: Option<String>,
}

#[tauri::command]
pub async fn get_codex_rate_limits() -> Result<CodexRateLimits, String> {
    tauri::async_runtime::spawn_blocking(fetch_codex_rate_limits)
        .await
        .map_err(|error| format!("Codex rate-limit task failed: {error}"))?
}

fn fetch_codex_rate_limits() -> Result<CodexRateLimits, String> {
    let auth_path = codex_auth_path();
    let identity = auth_path
        .as_deref()
        .and_then(read_codex_identity)
        .unwrap_or_default();

    let Some(auth_path) = auth_path else {
        return Ok(unavailable_result(
            "Codex auth path is unavailable",
            identity,
        ));
    };

    if !auth_path.exists() {
        return Ok(unavailable_result("Codex not signed in", identity));
    }

    let executable = match find_agent_executable("codex") {
        Ok(path) => path,
        Err(_) => return Ok(unavailable_result("Codex CLI not found", identity)),
    };

    Ok(fetch_via_rpc(&executable, identity))
}

fn unavailable_result(error: &str, identity: CodexIdentity) -> CodexRateLimits {
    CodexRateLimits {
        session: None,
        weekly: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: Some(error.to_string()),
        status: "unavailable".to_string(),
        account_label: identity.account_label,
        account_id: identity.account_id,
    }
}

fn error_result(error: String, identity: CodexIdentity) -> CodexRateLimits {
    CodexRateLimits {
        session: None,
        weekly: None,
        rate_limit_reset_credits: None,
        updated_at: now_ms(),
        error: Some(error),
        status: "error".to_string(),
        account_label: identity.account_label,
        account_id: identity.account_id,
    }
}

fn codex_home_path() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs_next::home_dir().map(|home| home.join(".codex")))
}

fn codex_auth_path() -> Option<PathBuf> {
    codex_home_path().map(|home| home.join("auth.json"))
}

fn read_codex_identity(auth_path: &Path) -> Option<CodexIdentity> {
    let raw = fs::read_to_string(auth_path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    Some(read_identity_from_auth_value(&value))
}

fn read_identity_from_auth_value(value: &Value) -> CodexIdentity {
    if value
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
    {
        return CodexIdentity {
            account_label: Some("API key".to_string()),
            account_id: None,
        };
    }

    let tokens = value.get("tokens");
    let account_id =
        read_string_claim(tokens, "account_id").or_else(|| read_string_claim(tokens, "accountId"));
    let id_token =
        read_string_claim(tokens, "id_token").or_else(|| read_string_claim(tokens, "idToken"));
    let payload = id_token.as_deref().and_then(parse_jwt_payload);

    let auth_claims = payload
        .as_ref()
        .and_then(|payload| payload.get("https://api.openai.com/auth"));
    let profile_claims = payload
        .as_ref()
        .and_then(|payload| payload.get("https://api.openai.com/profile"));
    let email = payload
        .as_ref()
        .and_then(|payload| read_string_claim(Some(payload), "email"))
        .or_else(|| read_string_claim(profile_claims, "email"));
    let workspace_label = read_string_claim(auth_claims, "workspace_name")
        .or_else(|| read_string_claim(profile_claims, "workspace_name"));
    let claim_account_id = account_id
        .or_else(|| read_string_claim(auth_claims, "chatgpt_account_id"))
        .or_else(|| {
            payload
                .as_ref()
                .and_then(|payload| read_string_claim(Some(payload), "chatgpt_account_id"))
        });

    let account_label = match (email, workspace_label) {
        (Some(email), Some(workspace)) => Some(format!("{email} ({workspace})")),
        (Some(email), None) => Some(email),
        (None, _) => claim_account_id.clone(),
    };

    CodexIdentity {
        account_label,
        account_id: claim_account_id,
    }
}

fn read_string_claim(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn parse_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = decode_base64_url(payload)?;
    let json = String::from_utf8(bytes).ok()?;
    serde_json::from_str(&json).ok()
}

fn decode_base64_url(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = 0_u32;
    let mut bits = 0_u8;

    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;

        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
        }
    }

    Some(output)
}

fn fetch_via_rpc(executable: &str, identity: CodexIdentity) -> CodexRateLimits {
    let mut child = match spawn_codex_app_server(executable) {
        Ok(child) => child,
        Err(error) => return error_result(error, identity),
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return error_result("Codex RPC stdin unavailable".to_string(), identity);
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return error_result("Codex RPC stdout unavailable".to_string(), identity);
    };
    let stderr = child.stderr.take();
    let stderr_buffer = Arc::new(Mutex::new(String::new()));

    if let Some(stderr) = stderr {
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

    let initialize_id = 1_u64;
    let mut rate_limits_id = None::<u64>;
    let deadline = Instant::now() + RPC_TIMEOUT;

    if let Err(error) = write_rpc_request(
        &mut stdin,
        initialize_id,
        "initialize",
        json!({ "clientInfo": { "name": "termflow", "version": "1.0.0" } }),
    ) {
        let _ = child.kill();
        return error_result(error, identity);
    }

    loop {
        let now = Instant::now();
        if now >= deadline {
            let stderr = diagnostic_snapshot(&stderr_buffer);
            let _ = child.kill();
            let _ = child.wait();
            return error_result(diagnostic_message("RPC timeout", &stderr), identity);
        }

        let remaining = deadline.saturating_duration_since(now);
        match line_rx.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(line) => {
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };

                if id == initialize_id {
                    if let Some(error) = rpc_error_message(&message) {
                        let _ = child.kill();
                        return error_result(error, identity);
                    }
                    if let Err(error) = write_rpc_notification(&mut stdin, "initialized") {
                        let _ = child.kill();
                        return error_result(error, identity);
                    }
                    let next_id = 2_u64;
                    rate_limits_id = Some(next_id);
                    if let Err(error) =
                        write_rpc_request(&mut stdin, next_id, "account/rateLimits/read", json!({}))
                    {
                        let _ = child.kill();
                        return error_result(error, identity);
                    }
                    continue;
                }

                if rate_limits_id == Some(id) {
                    let result = if let Some(error) = rpc_error_message(&message) {
                        error_result(error, identity)
                    } else {
                        map_rate_limits_response(message.get("result"), identity)
                    };
                    let _ = child.kill();
                    let _ = child.wait();
                    return result;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(_status)) = child.try_wait() {
                    let stderr = diagnostic_snapshot(&stderr_buffer);
                    return error_result(
                        diagnostic_message("RPC process exited unexpectedly", &stderr),
                        identity,
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let stderr = diagnostic_snapshot(&stderr_buffer);
                let _ = child.wait();
                return error_result(
                    diagnostic_message("RPC process exited unexpectedly", &stderr),
                    identity,
                );
            }
        }
    }
}

fn spawn_codex_app_server(executable: &str) -> Result<Child, String> {
    let args = ["-s", "read-only", "-a", "never", "app-server"];
    let lower = executable.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    let mut command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/c").arg(executable);
        command.args(args);
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
        .map_err(|error| format!("Failed to start Codex app-server: {error}"))
}

fn write_rpc_request(
    stdin: &mut impl Write,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    )
    .map_err(|error| format!("Failed to write Codex RPC request: {error}"))
}

fn write_rpc_notification(stdin: &mut impl Write, method: &str) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "method": method, "params": {} })
    )
    .map_err(|error| format!("Failed to write Codex RPC notification: {error}"))
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
            let mut guard = buffer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.push_str(&String::from_utf8_lossy(&chunk[..count]));
            if guard.len() > MAX_DIAGNOSTIC_OUTPUT_LENGTH {
                let keep_from = guard.len().saturating_sub(MAX_DIAGNOSTIC_OUTPUT_LENGTH);
                guard.drain(..keep_from);
            }
        }
    });
}

fn diagnostic_snapshot(buffer: &Arc<Mutex<String>>) -> String {
    buffer
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn diagnostic_message(message: &str, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        message.to_string()
    } else {
        let detail = trimmed.lines().last().unwrap_or(trimmed).trim();
        let detail_lower = detail.to_ascii_lowercase();
        if detail_lower.contains("<!doctype html")
            || detail_lower.contains("<html")
            || detail_lower.contains("<body")
        {
            return format!("{message}: Codex service returned an HTML error response");
        }

        let normalized = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        let shortened = truncate_diagnostic_detail(&normalized);
        format!("{message}: {shortened}")
    }
}

fn truncate_diagnostic_detail(detail: &str) -> String {
    if detail.chars().count() <= MAX_DIAGNOSTIC_MESSAGE_LENGTH {
        return detail.to_string();
    }

    let prefix = detail
        .chars()
        .take(MAX_DIAGNOSTIC_MESSAGE_LENGTH)
        .collect::<String>();
    format!("{prefix}…")
}

fn rpc_error_message(message: &Value) -> Option<String> {
    message
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn map_rate_limits_response(result: Option<&Value>, identity: CodexIdentity) -> CodexRateLimits {
    let rate_limits = result
        .and_then(|result| result.get("rateLimits"))
        .or(result);
    let primary = rate_limits
        .and_then(|limits| limits.get("primary"))
        .and_then(|window| map_rpc_window(window, 300));
    let secondary = rate_limits
        .and_then(|limits| limits.get("secondary"))
        .and_then(|window| map_rpc_window(window, 10_080));
    let (session, weekly) = classify_rate_limit_windows(primary, secondary);
    let rate_limit_reset_credits = result
        .and_then(|result| result.get("rateLimitResetCredits"))
        .and_then(map_reset_credits);

    CodexRateLimits {
        session,
        weekly,
        rate_limit_reset_credits,
        updated_at: now_ms(),
        error: None,
        status: "ok".to_string(),
        account_label: identity.account_label,
        account_id: identity.account_id,
    }
}

fn map_rpc_window(value: &Value, expected_window_minutes: u32) -> Option<CodexRateLimitWindow> {
    let used_percent = json_f64(value.get("usedPercent"))?;
    let window_minutes = json_u64(value.get("windowDurationMins"))
        .and_then(|minutes| u32::try_from(minutes).ok())
        .filter(|minutes| *minutes > 0)
        .unwrap_or(expected_window_minutes);
    let resets_at = parse_unix_timestamp_ms(value.get("resetsAt"));

    Some(CodexRateLimitWindow {
        used_percent: used_percent.clamp(0.0, 100.0),
        window_minutes,
        resets_at,
        reset_description: None,
    })
}

fn classify_rate_limit_windows(
    primary: Option<CodexRateLimitWindow>,
    secondary: Option<CodexRateLimitWindow>,
) -> (Option<CodexRateLimitWindow>, Option<CodexRateLimitWindow>) {
    match (primary, secondary) {
        (Some(primary), Some(secondary)) => {
            if primary.window_minutes <= secondary.window_minutes {
                (Some(primary), Some(secondary))
            } else {
                (Some(secondary), Some(primary))
            }
        }
        (Some(window), None) | (None, Some(window)) => {
            if window.window_minutes >= 10_080 {
                (None, Some(window))
            } else {
                (Some(window), None)
            }
        }
        (None, None) => (None, None),
    }
}

fn map_reset_credits(value: &Value) -> Option<CodexRateLimitResetCredits> {
    let available_count = json_u64(value.get("availableCount"))?;
    let total_earned_count = json_u64(value.get("totalEarnedCount")).map(|value| value as u32);
    let next_expires_at = parse_credit_timestamp_ms(value.get("nextExpiresAt"));

    Some(CodexRateLimitResetCredits {
        available_count: available_count as u32,
        total_earned_count,
        next_expires_at,
    })
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|value| value.is_finite()),
        Some(Value::String(value)) => value.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value as u64)
        }),
        Some(Value::String(value)) => value.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn parse_unix_timestamp_ms(value: Option<&Value>) -> Option<i64> {
    let raw = match value {
        Some(Value::Number(number)) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value as i64)
        })?,
        Some(Value::String(value)) => value.trim().parse::<i64>().ok()?,
        _ => return None,
    };

    if raw < 10_000_000_000 {
        Some(raw * 1000)
    } else {
        Some(raw)
    }
}

fn parse_credit_timestamp_ms(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::String(value)) => value
            .trim()
            .parse::<i64>()
            .ok()
            .and_then(|timestamp| {
                if timestamp < 10_000_000_000 {
                    Some(timestamp * 1000)
                } else {
                    Some(timestamp)
                }
            })
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(value.trim())
                    .ok()
                    .map(|date| date.timestamp_millis())
            }),
        _ => parse_unix_timestamp_ms(value),
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
    fn decodes_codex_identity_from_id_token() {
        let value = json!({
            "tokens": {
                "id_token": "e30.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIiwid29ya3NwYWNlX25hbWUiOiJUZWFtIn19.sig"
            }
        });

        let identity = read_identity_from_auth_value(&value);

        assert_eq!(
            identity,
            CodexIdentity {
                account_label: Some("user@example.com (Team)".to_string()),
                account_id: Some("acct-1".to_string()),
            }
        );
    }

    #[test]
    fn maps_rpc_window_with_second_reset_timestamp() {
        let window = map_rpc_window(
            &json!({
                "usedPercent": 22.4,
                "windowDurationMins": 10_080,
                "resetsAt": 1_780_000_000
            }),
            300,
        )
        .expect("window");

        assert_eq!(window.used_percent, 22.4);
        assert_eq!(window.window_minutes, 10_080);
        assert_eq!(window.resets_at, Some(1_780_000_000_000));
    }

    #[test]
    fn classifies_single_weekly_primary_window_as_weekly() {
        let limits = map_rate_limits_response(
            Some(&json!({
                "rateLimits": {
                    "primary": {
                        "usedPercent": 12,
                        "windowDurationMins": 10_080,
                        "resetsAt": 1_780_000_000
                    },
                    "secondary": null
                }
            })),
            CodexIdentity::default(),
        );

        assert!(limits.session.is_none());
        let weekly = limits.weekly.expect("weekly window");
        assert_eq!(weekly.used_percent, 12.0);
        assert_eq!(weekly.window_minutes, 10_080);
    }

    #[test]
    fn keeps_legacy_fallback_when_window_duration_is_missing() {
        let window = map_rpc_window(&json!({ "usedPercent": 7 }), 300).expect("window");

        assert_eq!(window.window_minutes, 300);
    }

    #[test]
    fn replaces_html_diagnostic_with_concise_message() {
        let message = diagnostic_message(
            "RPC process exited unexpectedly",
            "warning\n<!DOCTYPE html><html><body>blocked</body></html>",
        );

        assert_eq!(
            message,
            "RPC process exited unexpectedly: Codex service returned an HTML error response"
        );
    }

    #[test]
    fn truncates_oversized_single_line_diagnostic() {
        let detail = "x".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH + 20);
        let message = diagnostic_message("RPC timeout", &detail);

        assert_eq!(
            message.chars().count(),
            "RPC timeout: ".chars().count() + MAX_DIAGNOSTIC_MESSAGE_LENGTH + 1
        );
        assert!(message.ends_with('…'));
    }
}
