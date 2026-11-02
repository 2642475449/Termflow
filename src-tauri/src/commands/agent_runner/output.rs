use serde::Serialize;
use std::process::Output;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentTextErrorCode {
    Capacity,
    RateLimited,
    Authentication,
    Quota,
    Network,
    Timeout,
    OutputLimit,
    EmptyOutput,
    Unavailable,
    InvalidInput,
    ProcessFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTextRunError {
    pub code: AgentTextErrorCode,
    pub detail: Option<String>,
    pub exit_code: Option<i32>,
    pub attempts: usize,
}

impl AgentTextRunError {
    pub fn new(code: AgentTextErrorCode, detail: Option<String>) -> Self {
        Self {
            code,
            detail: detail.and_then(|value| diagnostic_excerpt(&value)),
            exit_code: None,
            attempts: 1,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.code,
            AgentTextErrorCode::Capacity
                | AgentTextErrorCode::RateLimited
                | AgentTextErrorCode::Network
        )
    }
}

impl From<String> for AgentTextRunError {
    fn from(detail: String) -> Self {
        Self::new(AgentTextErrorCode::InvalidInput, Some(detail))
    }
}

fn classify_failure(detail: &str) -> AgentTextErrorCode {
    let lower = detail.to_ascii_lowercase();
    if [
        "insufficient_quota",
        "credit_balance_exhausted",
        "usage_limit_reached",
        "usage limit",
        "spend limit",
        "no credits",
        "out of credits",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        AgentTextErrorCode::Quota
    } else if [
        "invalid_api_key",
        "authentication failed",
        "authentication_error",
        "not logged in",
        "unauthorized",
        "401 unauthorized",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        AgentTextErrorCode::Authentication
    } else if [
        "selected model is at capacity",
        "server_is_overloaded",
        "server_overloaded",
        "temporarily overloaded",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        AgentTextErrorCode::Capacity
    } else if [
        "rate_limit_exceeded",
        "rate limit reached",
        "too many requests",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        AgentTextErrorCode::RateLimited
    } else if [
        "connection reset",
        "connection refused",
        "dns error",
        "failed to lookup address",
        "error sending request",
        "stream disconnected before completion",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        AgentTextErrorCode::Network
    } else {
        AgentTextErrorCode::ProcessFailed
    }
}

/// 从末尾诊断取证，避免把启动头和回显的用户提示词作为错误展示。
fn diagnostic_excerpt(source: &str) -> Option<String> {
    let tail = source
        .chars()
        .rev()
        .take(8_192)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let tail = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]")
        .ok()
        .map(|pattern| pattern.replace_all(&tail, "").into_owned())
        .unwrap_or(tail);
    let lines: Vec<_> = tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let errors: Vec<_> = lines
        .iter()
        .copied()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            lower.starts_with("error:")
                || lower.starts_with("fatal:")
                || lower.starts_with("error ")
        })
        .collect();
    let selected = if errors.is_empty() { &lines } else { &errors };
    let mut unique = Vec::new();
    for line in selected.iter().rev().take(3).rev() {
        if !unique.contains(line) {
            unique.push(*line);
        }
    }
    let text = unique
        .join(" ")
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.chars().count() > 600 {
        Some(format!(
            "{}…",
            trimmed.chars().take(599).collect::<String>()
        ))
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn process_diagnostic(output: &Output) -> Option<String> {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let source = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        stderr
    };
    diagnostic_excerpt(&source)
}

#[derive(Default)]
struct CodexTextOutput {
    message: Option<String>,
    error: Option<String>,
    completed: bool,
}

fn parse_codex_output(stdout: &[u8]) -> CodexTextOutput {
    let mut result = CodexTextOutput::default();
    for line in String::from_utf8_lossy(stdout).lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match event["type"].as_str() {
            Some("turn.started") => result = CodexTextOutput::default(),
            Some("turn.completed") => result.completed = true,
            Some("turn.failed") => {
                result.completed = false;
                result.error = event["error"]["message"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| event["error"].as_str().map(str::to_string));
            }
            Some("error") => {
                result.error = event["message"].as_str().map(str::to_string);
            }
            Some("item.completed") if event["item"]["type"] == "agent_message" => {
                if event["item"]["phase"] != "commentary" {
                    result.message = event["item"]["text"]
                        .as_str()
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string);
                }
            }
            _ => {}
        }
    }
    result
}

pub(super) fn decode_agent_output(
    agent_id: &str,
    output: Output,
) -> Result<String, AgentTextRunError> {
    let codex = (agent_id == "codex").then(|| parse_codex_output(&output.stdout));
    if output.status.success() {
        let message = match codex.as_ref() {
            Some(result) if result.completed => result.message.clone(),
            Some(_) => None,
            None => Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
        };
        if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
            return Ok(message.trim().to_string());
        }
    }
    let detail = codex
        .as_ref()
        .and_then(|result| result.error.clone())
        .and_then(|value| diagnostic_excerpt(&value))
        .or_else(|| process_diagnostic(&output));
    let code = if let Some(detail) = detail.as_deref() {
        classify_failure(detail)
    } else if output.status.success() {
        AgentTextErrorCode::EmptyOutput
    } else {
        AgentTextErrorCode::ProcessFailed
    };
    let code =
        if output.status.success() && codex.as_ref().is_none_or(|result| result.error.is_none()) {
            AgentTextErrorCode::EmptyOutput
        } else {
            code
        };
    let mut error = AgentTextRunError::new(code, detail);
    error.exit_code = output.status.code();
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::{decode_agent_output, AgentTextErrorCode};
    use std::process::{ExitStatus, Output};

    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        #[cfg(target_os = "windows")]
        let status = {
            use std::os::windows::process::ExitStatusExt;
            ExitStatus::from_raw(code as u32)
        };
        #[cfg(not(target_os = "windows"))]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            ExitStatus::from_raw(code << 8)
        };
        Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn codex_returns_only_the_final_agent_text_after_a_completed_turn() {
        let stdout = concat!(
            "{\"type\":\"turn.started\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"wrong result\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"phase\":\"commentary\",\"text\":\"Inspecting changes\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"phase\":\"final_answer\",\"text\":\"fix(git): handle generation failures\\n\\n- Drain output pipes\"}}\n",
            "{\"type\":\"turn.completed\"}\n"
        );
        assert_eq!(
            decode_agent_output("codex", output(0, stdout, "diagnostic only")).unwrap(),
            "fix(git): handle generation failures\n\n- Drain output pipes"
        );
    }

    #[test]
    fn codex_does_not_accept_a_partial_answer_before_turn_failure() {
        let stdout = concat!(
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"partial answer\"}}\n",
            "{\"type\":\"turn.failed\",\"error\":{\"message\":\"Selected model is at capacity. Please try a different model.\"}}\n"
        );
        let error = decode_agent_output(
            "codex",
            output(1, stdout, "OpenAI Codex\nuser\nprivate prompt"),
        )
        .unwrap_err();
        assert_eq!(error.code, AgentTextErrorCode::Capacity);
        assert!(error.retryable());
        assert!(!error.detail.unwrap().contains("private prompt"));
    }

    #[test]
    fn codex_requires_a_completed_turn_and_recovers_from_transient_stream_errors() {
        let message = "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fix: complete\"}}\n";
        assert_eq!(
            decode_agent_output("codex", output(0, message, ""))
                .unwrap_err()
                .code,
            AgentTextErrorCode::EmptyOutput
        );
        let recovered = format!("{{\"type\":\"error\",\"message\":\"stream disconnected before completion\"}}\n{message}{{\"type\":\"turn.completed\"}}\n");
        assert_eq!(
            decode_agent_output("codex", output(0, &recovered, "")).unwrap(),
            "fix: complete"
        );
    }

    #[test]
    fn recognizes_the_actual_capacity_error_after_prompt_echo_and_deduplicates_it() {
        let stderr = format!("OpenAI Codex v0.166.0\nuser\n{}\n\x1b[31mERROR: Selected model is at capacity.\x1b[0m\nERROR: Selected model is at capacity.", "private diff\n".repeat(3_000));
        let error = decode_agent_output("codex", output(1, "", &stderr)).unwrap_err();
        assert_eq!(error.code, AgentTextErrorCode::Capacity);
        assert_eq!(error.exit_code, Some(1));
        assert_eq!(
            error.detail.as_deref(),
            Some("ERROR: Selected model is at capacity.")
        );
    }

    #[test]
    fn retry_classification_separates_quota_and_authentication_from_transient_errors() {
        for (message, expected, retryable) in [
            (
                "ERROR: 429 insufficient_quota",
                AgentTextErrorCode::Quota,
                false,
            ),
            (
                "ERROR: invalid_api_key",
                AgentTextErrorCode::Authentication,
                false,
            ),
            (
                "ERROR: rate_limit_exceeded",
                AgentTextErrorCode::RateLimited,
                true,
            ),
            (
                "ERROR: connection reset by peer",
                AgentTextErrorCode::Network,
                true,
            ),
            (
                "ERROR: unknown model",
                AgentTextErrorCode::ProcessFailed,
                false,
            ),
        ] {
            let error = decode_agent_output("claude", output(1, "", message)).unwrap_err();
            assert_eq!(error.code, expected);
            assert_eq!(error.retryable(), retryable);
        }
    }

    #[test]
    fn non_codex_text_output_is_preserved_and_empty_output_is_an_error() {
        assert_eq!(
            decode_agent_output("claude", output(0, " fix: update\n", "")).unwrap(),
            "fix: update"
        );
        assert_eq!(
            decode_agent_output("claude", output(0, "", "progress"))
                .unwrap_err()
                .code,
            AgentTextErrorCode::EmptyOutput
        );
    }
}
