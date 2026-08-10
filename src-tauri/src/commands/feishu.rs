use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

const FEISHU_CREDENTIAL_TARGET: &str = "Termflow/FeishuNotification";
const FEISHU_CREDENTIAL_USER: &str = "Termflow";
const FEISHU_WEBHOOK_PREFIX: &str = "/open-apis/bot/v2/hook/";
const FEISHU_REQUEST_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeishuCredentials {
    webhook_url: String,
    signing_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuCredentialStatus {
    configured: bool,
    webhook_hint: Option<String>,
    signing_secret_configured: bool,
    secure_storage_available: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuNotificationField {
    label: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuNotificationPayload {
    event_type: String,
    title: String,
    fields: Vec<FeishuNotificationField>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuSendResult {
    delivered_at: i64,
}

#[tauri::command]
pub fn get_feishu_notification_config() -> Result<FeishuCredentialStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let credentials = load_credentials()?;
        return Ok(status_from_credentials(credentials.as_ref(), true));
    }

    #[cfg(not(target_os = "windows"))]
    Ok(status_from_credentials(None, false))
}

#[tauri::command]
pub fn save_feishu_notification_credentials(
    webhook_url: String,
    signing_secret: Option<String>,
) -> Result<FeishuCredentialStatus, String> {
    validate_webhook_url(&webhook_url)?;
    let current = load_credentials()?;
    let signing_secret = match signing_secret {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(value.trim().to_string()),
        None => current.and_then(|credentials| credentials.signing_secret),
    };
    let credentials = FeishuCredentials {
        webhook_url: webhook_url.trim().to_string(),
        signing_secret,
    };
    save_credentials(&credentials)?;
    Ok(status_from_credentials(Some(&credentials), true))
}

#[tauri::command]
pub fn clear_feishu_notification_credentials() -> Result<FeishuCredentialStatus, String> {
    delete_credentials()?;
    Ok(status_from_credentials(None, cfg!(target_os = "windows")))
}

#[tauri::command]
pub async fn send_feishu_notification(
    payload: FeishuNotificationPayload,
) -> Result<FeishuSendResult, String> {
    validate_notification_payload(&payload)?;
    let credentials =
        load_credentials()?.ok_or_else(|| "Feishu webhook is not configured".to_string())?;
    tauri::async_runtime::spawn_blocking(move || send_feishu_blocking(&credentials, &payload))
        .await
        .map_err(|error| format!("Feishu delivery task failed: {error}"))??;
    Ok(FeishuSendResult {
        delivered_at: chrono::Utc::now().timestamp_millis(),
    })
}

fn status_from_credentials(
    credentials: Option<&FeishuCredentials>,
    secure_storage_available: bool,
) -> FeishuCredentialStatus {
    FeishuCredentialStatus {
        configured: credentials.is_some(),
        webhook_hint: credentials.map(|value| mask_webhook(&value.webhook_url)),
        signing_secret_configured: credentials
            .and_then(|value| value.signing_secret.as_ref())
            .is_some_and(|value| !value.is_empty()),
        secure_storage_available,
    }
}

fn validate_webhook_url(value: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(value.trim()).map_err(|_| "Invalid Feishu webhook URL".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("open.feishu.cn")
        || !parsed.path().starts_with(FEISHU_WEBHOOK_PREFIX)
        || parsed.path().len() <= FEISHU_WEBHOOK_PREFIX.len()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Only official Feishu v2 webhook URLs are supported".into());
    }
    Ok(())
}

fn validate_notification_payload(payload: &FeishuNotificationPayload) -> Result<(), String> {
    match payload.event_type.as_str() {
        "completed" | "error" | "waiting" | "permission" | "test" => {}
        _ => return Err("Unsupported Feishu notification event".into()),
    }
    if payload.title.trim().is_empty() || payload.title.chars().count() > 80 {
        return Err("Feishu notification title must contain 1 to 80 characters".into());
    }
    if payload.fields.len() > 8 {
        return Err("Feishu notification contains too many fields".into());
    }
    if payload.fields.iter().any(|field| {
        field.label.trim().is_empty()
            || field.label.chars().count() > 24
            || field.value.chars().count() > 240
    }) {
        return Err("Feishu notification field is invalid".into());
    }
    Ok(())
}

fn send_feishu_blocking(
    credentials: &FeishuCredentials,
    payload: &FeishuNotificationPayload,
) -> Result<(), String> {
    validate_webhook_url(&credentials.webhook_url)?;
    let request_body = build_request_body(credentials, payload);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(FEISHU_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Failed to create Feishu HTTP client: {error}"))?;

    for attempt in 0..2 {
        match client
            .post(&credentials.webhook_url)
            .json(&request_body)
            .send()
        {
            Ok(response) if response.status().is_server_error() && attempt == 0 => {
                std::thread::sleep(Duration::from_millis(250));
            }
            Ok(response) => return parse_feishu_response(response),
            Err(_) if attempt == 0 => std::thread::sleep(Duration::from_millis(250)),
            Err(error) => return Err(format!("Failed to reach Feishu: {error}")),
        }
    }
    Err("Feishu delivery failed".into())
}

fn parse_feishu_response(response: reqwest::blocking::Response) -> Result<(), String> {
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|error| format!("Invalid Feishu response: {error}"))?;
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if status.is_success() && code == 0 {
        return Ok(());
    }
    let message = body
        .get("msg")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    Err(format!(
        "Feishu rejected the notification ({code}): {message}"
    ))
}

fn build_request_body(
    credentials: &FeishuCredentials,
    payload: &FeishuNotificationPayload,
) -> Value {
    let (template, icon) = match payload.event_type.as_str() {
        "completed" => ("green", "✅"),
        "error" => ("red", "❌"),
        "waiting" | "permission" => ("orange", "⏳"),
        _ => ("blue", "🔔"),
    };
    let content = payload
        .fields
        .iter()
        .map(|field| {
            format!(
                "**{}**：{}",
                escape_markdown(&field.label),
                escape_markdown(&field.value)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut body = json!({
        "msg_type": "interactive",
        "card": {
            "schema": "2.0",
            "config": { "update_multi": true },
            "header": {
                "template": template,
                "title": {
                    "tag": "plain_text",
                    "content": format!("{icon} {}", payload.title.trim())
                }
            },
            "body": {
                "direction": "vertical",
                "padding": "12px 12px 12px 12px",
                "elements": [{ "tag": "markdown", "content": content }]
            }
        }
    });
    if let Some(secret) = credentials
        .signing_secret
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let timestamp = chrono::Utc::now().timestamp().to_string();
        body["timestamp"] = Value::String(timestamp.clone());
        body["sign"] = Value::String(feishu_signature(&timestamp, secret));
    }
    body
}

fn escape_markdown(value: &str) -> String {
    value
        .replace('\r', " ")
        .replace('\n', " ")
        .replace('\\', "\\\\")
        .replace('*', "\\*")
        .replace('`', "\\`")
}

fn mask_webhook(value: &str) -> String {
    let suffix = value.rsplit('/').next().unwrap_or_default();
    let visible = suffix
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("••••••{visible}")
}

fn feishu_signature(timestamp: &str, secret: &str) -> String {
    let key = format!("{timestamp}\n{secret}");
    base64_encode(&hmac_sha256(key.as_bytes(), b""))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut normalized = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; BLOCK_SIZE];
    let mut outer_pad = [0x5cu8; BLOCK_SIZE];
    for index in 0..BLOCK_SIZE {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn load_credentials() -> Result<Option<FeishuCredentials>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = wide(FEISHU_CREDENTIAL_TARGET);
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    let result = unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut pointer) };
    if let Err(error) = result {
        if error.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);
        }
        return Err(format!("Failed to read Windows credentials: {error}"));
    }
    if pointer.is_null() {
        return Ok(None);
    }
    let bytes = unsafe {
        let credential = &*pointer;
        std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        )
        .to_vec()
    };
    unsafe { CredFree(pointer.cast()) };
    let credentials = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Stored Feishu credentials are invalid: {error}"))?;
    Ok(Some(credentials))
}

#[cfg(not(target_os = "windows"))]
fn load_credentials() -> Result<Option<FeishuCredentials>, String> {
    Err("Secure Feishu credential storage is currently supported on Windows only".into())
}

#[cfg(target_os = "windows")]
fn save_credentials(credentials: &FeishuCredentials) -> Result<(), String> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let mut target = wide(FEISHU_CREDENTIAL_TARGET);
    let mut username = wide(FEISHU_CREDENTIAL_USER);
    let mut blob = serde_json::to_vec(credentials)
        .map_err(|error| format!("Failed to encode Feishu credentials: {error}"))?;
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(username.as_mut_ptr()),
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }
        .map_err(|error| format!("Failed to save Windows credentials: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn save_credentials(_credentials: &FeishuCredentials) -> Result<(), String> {
    Err("Secure Feishu credential storage is currently supported on Windows only".into())
}

#[cfg(target_os = "windows")]
fn delete_credentials() -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target = wide(FEISHU_CREDENTIAL_TARGET);
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0) } {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
        Err(error) => Err(format!("Failed to delete Windows credentials: {error}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn delete_credentials() -> Result<(), String> {
    Err("Secure Feishu credential storage is currently supported on Windows only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_official_v2_webhooks() {
        assert!(
            validate_webhook_url("https://open.feishu.cn/open-apis/bot/v2/hook/abc123").is_ok()
        );
        assert!(validate_webhook_url("http://open.feishu.cn/open-apis/bot/v2/hook/abc").is_err());
        assert!(validate_webhook_url("https://example.com/open-apis/bot/v2/hook/abc").is_err());
        assert!(validate_webhook_url("https://open.feishu.cn/open-apis/bot/hook/abc").is_err());
    }

    #[test]
    fn masks_webhook_and_escapes_card_content() {
        assert_eq!(
            mask_webhook("https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456"),
            "••••••123456"
        );
        assert_eq!(escape_markdown("a*b\n`c`"), "a\\*b \\`c\\`");
    }

    #[test]
    fn builds_signed_static_card_without_credentials_in_body() {
        let credentials = FeishuCredentials {
            webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc123".into(),
            signing_secret: Some("secret-value".into()),
        };
        let payload = FeishuNotificationPayload {
            event_type: "completed".into(),
            title: "Task completed".into(),
            fields: vec![FeishuNotificationField {
                label: "Project".into(),
                value: "Termflow".into(),
            }],
        };
        let body = build_request_body(&credentials, &payload);
        let encoded = body.to_string();
        assert_eq!(body["msg_type"], "interactive");
        assert_eq!(body["card"]["header"]["template"], "green");
        assert!(body.get("timestamp").is_some());
        assert!(body.get("sign").is_some());
        assert!(!encoded.contains("secret-value"));
        assert!(!encoded.contains("abc123"));
    }
}
