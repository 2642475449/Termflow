use std::{collections::HashMap, sync::Arc};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header::AUTHORIZATION, Message},
};

const MIMO_API_CHAT_COMPLETIONS_ENDPOINT: &str = "https://api.xiaomimimo.com/v1/chat/completions";
const MIMO_TOKEN_PLAN_CHAT_COMPLETIONS_ENDPOINT: &str =
    "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";
const DEFAULT_ASR_LANGUAGE: &str = "zh";
const LIVE_ASR_MODEL: &str = "qwen-audio-3.0-asr-flash-streaming";

/// 实时识别会话由后端持有，以便在 WebSocket 握手时安全携带 API Key。
#[derive(Clone, Default)]
pub struct LiveAsrSessions(Arc<Mutex<HashMap<String, mpsc::UnboundedSender<LiveAsrCommand>>>>);

enum LiveAsrCommand {
    Audio(Vec<u8>),
    Finish,
    Cancel,
}

#[derive(Clone, Serialize, Deserialize)]
struct LiveAsrEvent {
    session_id: String,
    kind: String,
    text: Option<String>,
    sentence_end: Option<bool>,
    message: Option<String>,
}

#[tauri::command]
pub async fn start_live_asr(
    app: AppHandle,
    sessions: tauri::State<'_, LiveAsrSessions>,
    session_id: String,
    api_key: String,
    model: String,
    region: String,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("实时语音会话 ID 不能为空".into());
    }
    if api_key.trim().is_empty() {
        return Err("请先在设置中配置语音识别 API Key".into());
    }
    if model.trim() != LIVE_ASR_MODEL {
        return Err("当前模型不支持实时转写".into());
    }

    let endpoint = match region.trim() {
        "beijing" => "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        "singapore" => "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference",
        _ => return Err("实时转写目前仅支持北京或新加坡地域".into()),
    };
    let mut request = endpoint
        .into_client_request()
        .map_err(|error| format!("创建实时语音请求失败: {error}"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {}", api_key.trim())
            .parse()
            .map_err(|error| format!("设置实时语音鉴权失败: {error}"))?,
    );
    request.headers_mut().insert(
        "user-agent",
        "Termflow/1.0"
            .parse()
            .map_err(|error| format!("设置实时语音客户端标识失败: {error}"))?,
    );

    let (socket, _) = connect_async(request)
        .await
        .map_err(|error| format!("连接实时语音服务失败: {error}"))?;
    let (mut writer, mut reader) = socket.split();
    let task_id = new_live_asr_task_id();
    let start = json!({
        "header": { "action": "run-task", "task_id": task_id, "streaming": "duplex" },
        "payload": {
            "task_group": "audio", "task": "asr", "function": "recognition",
            "model": LIVE_ASR_MODEL,
            "parameters": { "format": "pcm", "sample_rate": 16000, "max_sentence_silence": 600 },
            "input": {}
        }
    });
    writer
        .send(Message::Text(start.to_string().into()))
        .await
        .map_err(|error| format!("启动实时语音任务失败: {error}"))?;

    loop {
        let Some(message) = reader.next().await else {
            return Err("实时语音服务在任务启动前关闭了连接".into());
        };
        let message = message.map_err(|error| format!("读取实时语音响应失败: {error}"))?;
        if let Some(event) = parse_live_asr_event(&session_id, &message)? {
            if event.kind == "started" {
                break;
            }
            if event.kind == "error" {
                return Err(event
                    .message
                    .unwrap_or_else(|| "实时语音任务启动失败".into()));
            }
        }
    }

    let (sender, mut receiver) = mpsc::unbounded_channel();
    sessions.0.lock().insert(session_id.clone(), sender);
    let session_map = sessions.0.clone();
    tauri::async_runtime::spawn(async move {
        let mut finishing = false;
        loop {
            tokio::select! {
                command = receiver.recv() => match command {
                    Some(LiveAsrCommand::Audio(audio)) if !finishing => {
                        if writer.send(Message::Binary(audio.into())).await.is_err() { break; }
                    }
                    Some(LiveAsrCommand::Finish) if !finishing => {
                        finishing = true;
                        let finish = json!({
                            "header": { "action": "finish-task", "task_id": task_id, "streaming": "duplex" },
                            "payload": { "input": {} }
                        });
                        if writer.send(Message::Text(finish.to_string().into())).await.is_err() { break; }
                    }
                    Some(LiveAsrCommand::Cancel) | None => break,
                    _ => {}
                },
                message = reader.next() => match message {
                    Some(Ok(message)) => match parse_live_asr_event(&session_id, &message) {
                        Ok(Some(event)) => {
                            let finished = event.kind == "finished" || event.kind == "error";
                            let _ = app.emit("voice-live-asr-event", event);
                            if finished { break; }
                        }
                        Ok(None) => {}
                        Err(message) => { let _ = emit_live_asr_error(&app, &session_id, message); break; }
                    },
                    Some(Err(error)) => { let _ = emit_live_asr_error(&app, &session_id, format!("实时语音连接错误: {error}")); break; }
                    None => break,
                }
            }
        }
        session_map.lock().remove(&session_id);
        let _ = writer.close().await;
    });
    Ok(())
}

#[tauri::command]
pub fn send_live_asr_audio(
    sessions: tauri::State<'_, LiveAsrSessions>,
    session_id: String,
    audio: Vec<u8>,
) -> Result<(), String> {
    if audio.is_empty() {
        return Ok(());
    }
    sessions
        .0
        .lock()
        .get(&session_id)
        .ok_or_else(|| "实时语音会话未启动".to_string())?
        .send(LiveAsrCommand::Audio(audio))
        .map_err(|_| "实时语音会话已关闭".to_string())
}

#[tauri::command]
pub fn finish_live_asr(
    sessions: tauri::State<'_, LiveAsrSessions>,
    session_id: String,
) -> Result<(), String> {
    sessions
        .0
        .lock()
        .get(&session_id)
        .ok_or_else(|| "实时语音会话未启动".to_string())?
        .send(LiveAsrCommand::Finish)
        .map_err(|_| "实时语音会话已关闭".to_string())
}

#[tauri::command]
pub fn cancel_live_asr(
    sessions: tauri::State<'_, LiveAsrSessions>,
    session_id: String,
) -> Result<(), String> {
    if let Some(sender) = sessions.0.lock().remove(&session_id) {
        let _ = sender.send(LiveAsrCommand::Cancel);
    }
    Ok(())
}

fn new_live_asr_task_id() -> String {
    let value = rand::random::<u128>();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        value >> 96,
        (value >> 80) & 0xffff,
        (value >> 64) & 0xffff,
        (value >> 48) & 0xffff,
        value & 0xffffffffffff
    )
}

fn parse_live_asr_event(
    session_id: &str,
    message: &Message,
) -> Result<Option<LiveAsrEvent>, String> {
    let Message::Text(text) = message else {
        return Ok(None);
    };
    let payload: Value =
        serde_json::from_str(text).map_err(|error| format!("解析实时语音响应失败: {error}"))?;
    let header = payload.get("header").and_then(Value::as_object);
    let event = header
        .and_then(|header| header.get("event"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event {
        "task-started" => Ok(Some(LiveAsrEvent {
            session_id: session_id.into(),
            kind: "started".into(),
            text: None,
            sentence_end: None,
            message: None,
        })),
        "result-generated" => {
            let sentence = payload.pointer("/payload/output/sentence");
            let text = sentence
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let sentence_end = sentence
                .and_then(|value| value.get("sentence_end"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if text.is_empty() {
                Ok(None)
            } else {
                Ok(Some(LiveAsrEvent {
                    session_id: session_id.into(),
                    kind: "result".into(),
                    text: Some(text),
                    sentence_end: Some(sentence_end),
                    message: None,
                }))
            }
        }
        "task-finished" => Ok(Some(LiveAsrEvent {
            session_id: session_id.into(),
            kind: "finished".into(),
            text: None,
            sentence_end: None,
            message: None,
        })),
        "task-failed" => Ok(Some(LiveAsrEvent {
            session_id: session_id.into(),
            kind: "error".into(),
            text: None,
            sentence_end: None,
            message: header
                .and_then(|header| header.get("error_message"))
                .and_then(Value::as_str)
                .map(str::to_string),
        })),
        _ => Ok(None),
    }
}

fn emit_live_asr_error(
    app: &AppHandle,
    session_id: &str,
    message: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "voice-live-asr-event",
        LiveAsrEvent {
            session_id: session_id.into(),
            kind: "error".into(),
            text: None,
            sentence_end: None,
            message: Some(message),
        },
    )
}

#[tauri::command]
pub async fn transcribe_audio(
    audio_base64: String,
    mime_type: String,
    model: String,
    api_key: String,
    auth_mode: Option<String>,
    database: tauri::State<'_, std::sync::Arc<crate::database::Database>>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("请先在设置中配置语音识别 API Key".into());
    }
    if audio_base64.trim().is_empty() {
        return Err("未识别到语音内容".into());
    }
    if model.trim().is_empty() {
        return Err("请先在设置中配置语音识别模型".into());
    }

    let payload = json!({
        "model": model.trim(),
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": format!(
                                "data:{};base64,{}",
                                normalize_mime_type(&mime_type),
                                audio_base64.trim()
                            ),
                        }
                    }
                ]
            }
        ],
        "asr_options": {
            "language": DEFAULT_ASR_LANGUAGE,
        }
    });

    let auth_mode = normalize_auth_mode(auth_mode.as_deref());
    let proxy = super::network_proxy::load_resolved_proxy(&database)?;
    let client =
        crate::network_proxy::apply_proxy_to_client_builder(reqwest::Client::builder(), &proxy)?
            .build()
            .map_err(|error| format!("创建语音转写客户端失败: {error}"))?;
    let request = client.post(mimo_endpoint(auth_mode)).json(&payload);
    let request = if auth_mode == "token-plan" {
        request.bearer_auth(api_key.trim())
    } else {
        request.header("api-key", api_key.trim())
    };

    let response = request
        .send()
        .await
        .map_err(|e| format!("语音转写请求失败: {e}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(classify_http_error(
            status.as_u16(),
            extract_api_error_message(&body),
        ));
    }

    if content_type.contains("application/json") {
        let payload: Value = response
            .json()
            .await
            .map_err(|e| format!("解析语音转写结果失败: {e}"))?;
        return Ok(sanitize_asr_text(&extract_completion_text(&payload)));
    }

    response
        .text()
        .await
        .map(|text| sanitize_asr_text(text.trim()))
        .map_err(|e| format!("读取语音转写结果失败: {e}"))
}

fn normalize_auth_mode(auth_mode: Option<&str>) -> &str {
    if matches!(auth_mode.map(str::trim), Some("api")) {
        "api"
    } else {
        "token-plan"
    }
}

fn mimo_endpoint(auth_mode: &str) -> &'static str {
    if auth_mode == "token-plan" {
        MIMO_TOKEN_PLAN_CHAT_COMPLETIONS_ENDPOINT
    } else {
        MIMO_API_CHAT_COMPLETIONS_ENDPOINT
    }
}

fn classify_http_error(status: u16, fallback_message: Option<String>) -> String {
    match status {
        401 => "API Key 无效或已过期".into(),
        403 => "API Key 没有访问权限".into(),
        429 => "调用频率超限，请稍后再试".into(),
        404 => fallback_message.unwrap_or_else(|| "当前模型不存在，或当前接口不支持该模型".into()),
        500..=599 => "服务暂时不可用".into(),
        _ => fallback_message.unwrap_or_else(|| format!("请求失败 ({status})")),
    }
}

fn extract_api_error_message(body: &str) -> Option<String> {
    let payload = serde_json::from_str::<Value>(body).ok()?;
    if let Some(message) = payload
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        return Some(message.trim().to_string());
    }

    payload
        .get("message")
        .and_then(Value::as_str)
        .map(|message| message.trim().to_string())
}

fn extract_completion_text(payload: &Value) -> String {
    if let Some(text) = payload.get("text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| {
            choices.iter().find_map(|choice| {
                let message_content = choice
                    .get("message")
                    .and_then(|message| message.get("content"));
                extract_text_from_content(message_content).or_else(|| {
                    let delta_content = choice.get("delta").and_then(|delta| delta.get("content"));
                    extract_text_from_content(delta_content)
                })
            })
        })
        .unwrap_or_default()
}

fn extract_text_from_content(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Some(Value::Array(items)) => {
            let combined = items
                .iter()
                .filter_map(|item| {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                    if let Some(text) = item.get("content").and_then(Value::as_str) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                    item.get("transcript")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(ToString::to_string)
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!combined.is_empty()).then_some(combined)
        }
        Some(Value::Object(map)) => map
            .get("text")
            .or_else(|| map.get("content"))
            .or_else(|| map.get("transcript"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string),
        _ => None,
    }
}

fn normalize_mime_type(mime_type: &str) -> &str {
    let trimmed = mime_type.trim();
    if trimmed.is_empty() {
        "audio/wav"
    } else {
        trimmed
    }
}

/// 去除 ASR 模型常见的尾部幻觉字符（如多余的斜杠、反斜杠等）
fn sanitize_asr_text(text: &str) -> String {
    let trimmed = text.trim();
    let sanitized = trimmed.trim_end_matches(|c: char| c == '/' || c == '\\');
    sanitized.trim().to_string()
}
