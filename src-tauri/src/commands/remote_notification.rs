use super::feishu::{
    clear_feishu_notification_credentials, get_feishu_notification_config,
    save_feishu_notification_credentials, send_feishu_notification, FeishuCredentialStatus,
    FeishuNotificationPayload, FeishuSendResult,
};

fn require_supported_provider(provider: &str) -> Result<(), String> {
    match provider {
        "feishu" => Ok(()),
        "dingtalk" | "wechat" | "qq" | "telegram" => Err(format!(
            "Remote notification provider '{provider}' is not supported yet"
        )),
        _ => Err(format!("Unknown remote notification provider '{provider}'")),
    }
}

#[tauri::command]
pub fn get_remote_notification_config(provider: String) -> Result<FeishuCredentialStatus, String> {
    require_supported_provider(&provider)?;
    get_feishu_notification_config()
}

#[tauri::command]
pub fn save_remote_notification_credentials(
    provider: String,
    webhook_url: String,
    signing_secret: Option<String>,
) -> Result<FeishuCredentialStatus, String> {
    require_supported_provider(&provider)?;
    save_feishu_notification_credentials(webhook_url, signing_secret)
}

#[tauri::command]
pub fn clear_remote_notification_credentials(
    provider: String,
) -> Result<FeishuCredentialStatus, String> {
    require_supported_provider(&provider)?;
    clear_feishu_notification_credentials()
}

#[tauri::command]
pub async fn send_remote_notification(
    provider: String,
    payload: FeishuNotificationPayload,
    database: tauri::State<'_, std::sync::Arc<crate::database::Database>>,
) -> Result<FeishuSendResult, String> {
    require_supported_provider(&provider)?;
    let proxy = super::network_proxy::load_resolved_proxy(&database)?;
    send_feishu_notification(payload, proxy).await
}
