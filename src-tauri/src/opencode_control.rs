use rand::{distr::Alphanumeric, Rng};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

const OPENCODE_CONTROL_HOST: &str = "127.0.0.1";
const OPENCODE_CONTROL_USERNAME: &str = "opencode";
const OPENCODE_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const OPENCODE_READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const OPENCODE_INITIAL_PROMPT_TIMEOUT: Duration = Duration::from_secs(15);
const OPENCODE_TUI_NAVIGATION_ATTEMPTS: usize = 8;
const OPENCODE_TUI_NAVIGATION_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Deserialize)]
struct CreatedSession {
    id: String,
}

pub(crate) struct OpenCodePromptControl {
    port: u16,
    password: String,
    prompt: String,
    directory: String,
}

impl OpenCodePromptControl {
    pub(crate) fn new(prompt: String, directory: String) -> Result<Self, String> {
        Ok(Self {
            port: reserve_loopback_port()?,
            password: random_password(),
            prompt,
            directory,
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn password(&self) -> &str {
        &self.password
    }

    pub(crate) fn deliver(self) -> Result<(), String> {
        deliver_with_options(
            &self,
            OPENCODE_INITIAL_PROMPT_TIMEOUT,
            OPENCODE_TUI_NAVIGATION_ATTEMPTS,
            OPENCODE_TUI_NAVIGATION_INTERVAL,
        )
    }

    fn endpoint(&self, path: &str) -> String {
        format!("http://{OPENCODE_CONTROL_HOST}:{}{path}", self.port)
    }

    fn authenticated(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        request
            .basic_auth(OPENCODE_CONTROL_USERNAME, Some(&self.password))
            .query(&[("directory", self.directory.as_str())])
    }
}

fn random_password() -> String {
    rand::rng()
        .sample_iter(Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

pub(crate) fn with_tui_server_args(command: &str, port: u16) -> String {
    format!("{command} --hostname {OPENCODE_CONTROL_HOST} --port {port}")
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind((OPENCODE_CONTROL_HOST, 0))
        .map_err(|error| format!("无法为 OpenCode 分配本地控制端口: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("无法读取 OpenCode 本地控制端口: {error}"))
}

fn deliver_with_options(
    control: &OpenCodePromptControl,
    timeout: Duration,
    navigation_attempts: usize,
    navigation_interval: Duration,
) -> Result<(), String> {
    let client = Client::builder()
        .connect_timeout(OPENCODE_REQUEST_TIMEOUT)
        .timeout(OPENCODE_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建 OpenCode 本地控制客户端: {error}"))?;
    let deadline = Instant::now() + timeout;

    wait_for_server(&client, control, deadline)?;
    let session_id = create_session(&client, control)?;
    if let Err(error) = submit_prompt(&client, control, &session_id) {
        cleanup_session(&client, control, &session_id);
        return Err(error);
    }
    if let Err(error) = wait_for_prompt_persisted(&client, control, &session_id, deadline) {
        cleanup_session(&client, control, &session_id);
        return Err(error);
    }
    navigate_to_session(
        &client,
        control,
        &session_id,
        navigation_attempts,
        navigation_interval,
    )
}

fn wait_for_server(
    client: &Client,
    control: &OpenCodePromptControl,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        match control
            .authenticated(client.get(control.endpoint("/global/health")))
            .send()
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
                return Err("OpenCode 本地控制认证失败".to_string());
            }
            Ok(_) | Err(_) if Instant::now() < deadline => {
                thread::sleep(OPENCODE_READY_POLL_INTERVAL);
            }
            Ok(response) => {
                return Err(format!(
                    "OpenCode 本地服务启动失败（HTTP {}）",
                    response.status()
                ));
            }
            Err(_) => return Err("等待 OpenCode 本地服务启动超时".to_string()),
        }
    }
}

fn create_session(client: &Client, control: &OpenCodePromptControl) -> Result<String, String> {
    let response = control
        .authenticated(client.post(control.endpoint("/session")))
        .json(&json!({}))
        .send()
        .map_err(|error| format!("OpenCode 会话创建失败: {error}"))?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err("OpenCode 会话接口认证失败".to_string());
    }
    if !status.is_success() {
        return Err(format!("OpenCode 会话创建失败（HTTP {status}）"));
    }
    let session = response
        .json::<CreatedSession>()
        .map_err(|error| format!("OpenCode 会话响应无效: {error}"))?;
    if !is_safe_session_id(&session.id) {
        return Err("OpenCode 返回了无效的会话 ID".to_string());
    }
    Ok(session.id)
}

fn is_safe_session_id(session_id: &str) -> bool {
    session_id.starts_with("ses")
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn submit_prompt(
    client: &Client,
    control: &OpenCodePromptControl,
    session_id: &str,
) -> Result<(), String> {
    let response = control
        .authenticated(
            client.post(control.endpoint(&format!("/session/{session_id}/prompt_async"))),
        )
        .json(&json!({
            "parts": [{
                "type": "text",
                "text": control.prompt,
            }],
        }))
        .send()
        .map_err(|error| format!("OpenCode 完整问题提交失败: {error}"))?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err("OpenCode 问题接口认证失败".to_string());
    }
    if !status.is_success() {
        return Err(format!("OpenCode 完整问题提交失败（HTTP {status}）"));
    }
    Ok(())
}

fn wait_for_prompt_persisted(
    client: &Client,
    control: &OpenCodePromptControl,
    session_id: &str,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        let response = control
            .authenticated(client.get(control.endpoint(&format!("/session/{session_id}/message"))))
            .query(&[("limit", "20")])
            .send();
        match response {
            Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
                return Err("OpenCode 消息接口认证失败".to_string());
            }
            Ok(response) if response.status().is_success() => {
                if response
                    .json::<serde_json::Value>()
                    .ok()
                    .is_some_and(|value| response_contains_prompt(&value, &control.prompt))
                {
                    return Ok(());
                }
            }
            Ok(_) | Err(_) => {}
        }
        if Instant::now() >= deadline {
            return Err("等待 OpenCode 确认完整问题超时".to_string());
        }
        thread::sleep(OPENCODE_READY_POLL_INTERVAL);
    }
}

fn response_contains_prompt(response: &serde_json::Value, prompt: &str) -> bool {
    response.as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message
                .get("info")
                .and_then(|info| info.get("role"))
                .and_then(serde_json::Value::as_str)
                == Some("user")
                && message
                    .get("parts")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|parts| {
                        parts.iter().any(|part| {
                            part.get("type").and_then(serde_json::Value::as_str) == Some("text")
                                && part.get("text").and_then(serde_json::Value::as_str)
                                    == Some(prompt)
                        })
                    })
        })
    })
}

fn navigate_to_session(
    client: &Client,
    control: &OpenCodePromptControl,
    session_id: &str,
    attempts: usize,
    interval: Duration,
) -> Result<(), String> {
    let mut delivered = false;
    for attempt in 0..attempts.max(1) {
        let response = control
            .authenticated(client.post(control.endpoint("/tui/select-session")))
            .json(&json!({ "sessionID": session_id }))
            .send();
        if response
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json::<bool>())
            .unwrap_or(false)
        {
            delivered = true;
        }
        if attempt + 1 < attempts {
            thread::sleep(interval);
        }
    }
    delivered
        .then_some(())
        .ok_or_else(|| "OpenCode 已接收问题，但侧边界面无法切换到新会话".to_string())
}

fn cleanup_session(client: &Client, control: &OpenCodePromptControl, session_id: &str) {
    let _ = control
        .authenticated(client.delete(control.endpoint(&format!("/session/{session_id}"))))
        .send();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tiny_http::{Header, Response as TinyResponse, Server};

    #[test]
    fn adds_only_loopback_tui_server_arguments() {
        assert_eq!(
            with_tui_server_args("opencode", 43127),
            "opencode --hostname 127.0.0.1 --port 43127"
        );
    }

    #[test]
    fn reserves_an_available_loopback_port() {
        let port = reserve_loopback_port().unwrap();
        assert!(port > 0);
        TcpListener::bind((OPENCODE_CONTROL_HOST, port)).unwrap();
    }

    #[test]
    fn creates_an_independent_password_for_each_session() {
        let first = random_password();
        let second = random_password();
        assert_eq!(first.len(), 48);
        assert_eq!(second.len(), 48);
        assert_ne!(first, second);
    }

    #[test]
    fn persists_the_exact_multiline_prompt_before_navigating_the_tui() {
        let server = Server::http((OPENCODE_CONTROL_HOST, 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let (sender, receiver) = mpsc::channel();
        let prompt = "来源会话：Claude Code 15:28:19\n工作目录：D:\\repo\n用户问题：\n为什么失败？";
        let expected_prompt = prompt.to_string();
        let server_thread = thread::spawn(move || {
            let mut captured_prompt = None;
            let mut paths = Vec::new();
            let mut auth_headers = Vec::new();
            for mut request in server.incoming_requests().take(6) {
                paths.push(request.url().to_string());
                auth_headers.push(
                    request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv("authorization"))
                        .map(|header| header.value.as_str().to_string()),
                );
                if request
                    .url()
                    .starts_with("/session/ses_termflow_test/prompt_async")
                {
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap();
                    captured_prompt = serde_json::from_str::<serde_json::Value>(&body)
                        .unwrap()
                        .get("parts")
                        .and_then(serde_json::Value::as_array)
                        .and_then(|parts| parts.first())
                        .and_then(|part| part.get("text"))
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    request.respond(TinyResponse::empty(204)).unwrap();
                    continue;
                }
                let body = if request.url().starts_with("/global/health") {
                    r#"{"healthy":true,"version":"1.17.13"}"#.to_string()
                } else if request.url().starts_with("/session?") {
                    r#"{"id":"ses_termflow_test"}"#.to_string()
                } else if request
                    .url()
                    .starts_with("/session/ses_termflow_test/message")
                {
                    serde_json::to_string(&json!([{
                        "info": { "role": "user" },
                        "parts": [{ "type": "text", "text": expected_prompt }],
                    }]))
                    .unwrap()
                } else {
                    "true".to_string()
                };
                let content_type = Header::from_bytes("Content-Type", "application/json").unwrap();
                request
                    .respond(TinyResponse::from_string(body).with_header(content_type))
                    .unwrap();
            }
            sender.send((paths, auth_headers, captured_prompt)).unwrap();
        });

        let control = OpenCodePromptControl {
            port,
            password: "secret-token".to_string(),
            prompt: prompt.to_string(),
            directory: r"D:\repo".to_string(),
        };
        deliver_with_options(&control, Duration::from_secs(2), 2, Duration::ZERO).unwrap();

        let (paths, auth_headers, captured_prompt) =
            receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        server_thread.join().unwrap();
        assert_eq!(
            paths
                .iter()
                .map(|path| path.split('?').next().unwrap())
                .collect::<Vec<_>>(),
            [
                "/global/health",
                "/session",
                "/session/ses_termflow_test/prompt_async",
                "/session/ses_termflow_test/message",
                "/tui/select-session",
                "/tui/select-session",
            ]
        );
        assert!(paths.iter().all(|path| path.contains("directory=")));
        assert!(auth_headers
            .iter()
            .all(|header| header.as_deref() == Some("Basic b3BlbmNvZGU6c2VjcmV0LXRva2Vu")));
        assert_eq!(captured_prompt.as_deref(), Some(prompt));
    }

    #[test]
    fn timeout_errors_never_expose_the_prompt() {
        let port = reserve_loopback_port().unwrap();
        let sensitive_prompt = "用户问题：不要泄露 secret-value";
        let control = OpenCodePromptControl {
            port,
            password: "secret-token".to_string(),
            prompt: sensitive_prompt.to_string(),
            directory: r"D:\repo".to_string(),
        };

        let error = deliver_with_options(&control, Duration::from_millis(30), 1, Duration::ZERO)
            .unwrap_err();
        assert!(error.contains("超时"));
        assert!(!error.contains(sensitive_prompt));
        assert!(!error.contains("secret-token"));
    }
}
