use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::State;

use crate::{
    database::Database,
    network_proxy::{
        apply_proxy_to_client_builder, redacted_proxy_url, resolve_network_proxy,
        NetworkProxySettings, ResolvedNetworkProxy,
    },
};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProxyTestResult {
    target: String,
    url: String,
    success: bool,
    status_code: Option<u16>,
    latency_ms: u128,
    route: String,
    proxy_url: Option<String>,
    error_kind: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub fn resolve_network_proxy_settings(
    settings: NetworkProxySettings,
) -> Result<ResolvedNetworkProxy, String> {
    let mut resolved = resolve_network_proxy(&settings)?;
    resolved.http_proxy = resolved.http_proxy.as_deref().map(redacted_proxy_url);
    resolved.https_proxy = resolved.https_proxy.as_deref().map(redacted_proxy_url);
    Ok(resolved)
}

#[tauri::command]
pub async fn test_network_proxy(
    target: String,
    custom_url: Option<String>,
    settings: NetworkProxySettings,
) -> Result<NetworkProxyTestResult, String> {
    let url = target_url(&target, custom_url.as_deref())?;
    let resolved = resolve_network_proxy(&settings)?;
    let proxy_url = resolved
        .https_proxy
        .as_deref()
        .or(resolved.http_proxy.as_deref())
        .map(redacted_proxy_url);
    let route = if proxy_url.is_some() {
        "proxy"
    } else {
        "direct"
    }
    .to_string();
    let client = apply_proxy_to_client_builder(
        reqwest::Client::builder()
            .timeout(TEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(3)),
        &resolved,
    )?
    .build()
    .map_err(|error| format!("创建网络测试客户端失败: {error}"))?;

    let started = Instant::now();
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, "Termflow network diagnostics")
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis();
    match response {
        Ok(response) => Ok(NetworkProxyTestResult {
            target,
            url,
            success: true,
            status_code: Some(response.status().as_u16()),
            latency_ms,
            route,
            proxy_url,
            error_kind: None,
            error: None,
        }),
        Err(error) => Ok(NetworkProxyTestResult {
            target,
            url,
            success: false,
            status_code: error.status().map(|status| status.as_u16()),
            latency_ms,
            route,
            proxy_url,
            error_kind: Some(classify_error(&error).into()),
            error: Some(error.to_string()),
        }),
    }
}

pub fn load_resolved_proxy(
    database: &State<'_, Arc<Database>>,
) -> Result<ResolvedNetworkProxy, String> {
    let settings = database
        .load_persistent_settings()?
        .network_proxy_settings();
    resolve_network_proxy(&settings)
}

fn target_url(target: &str, custom_url: Option<&str>) -> Result<String, String> {
    let url = match target {
        "googleOAuth" => "https://oauth2.googleapis.com/token",
        "github" => "https://api.github.com",
        "openai" => "https://api.openai.com/v1/models",
        "claude" => "https://api.anthropic.com/v1/messages",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/models",
        "glm" => "https://open.bigmodel.cn/api/paas/v4",
        "qwen" => "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
        "custom" => custom_url
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| "请输入自定义测试地址".to_string())?,
        _ => return Err("未知的网络测试目标".into()),
    };
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("测试地址无效: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("测试地址必须使用 HTTP 或 HTTPS".into());
    }
    Ok(parsed.to_string())
}

fn classify_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_builder() {
        "configuration"
    } else {
        "request"
    }
}

#[cfg(test)]
mod tests {
    use super::target_url;

    #[test]
    fn every_built_in_connectivity_target_uses_https() {
        for target in [
            "googleOAuth",
            "github",
            "openai",
            "claude",
            "gemini",
            "glm",
            "qwen",
        ] {
            let url = target_url(target, None).unwrap();
            assert!(
                url.starts_with("https://"),
                "unexpected URL for {target}: {url}"
            );
        }
    }

    #[test]
    fn custom_connectivity_target_rejects_non_http_protocols() {
        let error = target_url("custom", Some("file:///etc/passwd")).unwrap_err();
        assert!(error.contains("HTTP"));
    }
}
