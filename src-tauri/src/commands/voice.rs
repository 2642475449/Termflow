use serde_json::{json, Value};

const MIMO_API_CHAT_COMPLETIONS_ENDPOINT: &str = "https://api.xiaomimimo.com/v1/chat/completions";
const MIMO_TOKEN_PLAN_CHAT_COMPLETIONS_ENDPOINT: &str =
    "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";
const DEFAULT_ASR_LANGUAGE: &str = "zh";

#[tauri::command]
pub async fn transcribe_audio(
    audio_base64: String,
    mime_type: String,
    model: String,
    api_key: String,
    auth_mode: Option<String>,
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
    let request = reqwest::Client::new()
        .post(mimo_endpoint(auth_mode))
        .json(&payload);
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
