use std::process::Command;

use reqwest::{ClientBuilder, NoProxy, Proxy, Url};
use serde::{Deserialize, Serialize};

pub const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProxySettings {
    #[serde(default = "default_proxy_mode")]
    pub mode: String,
    #[serde(default)]
    pub custom_proxy_url: String,
    #[serde(default = "default_no_proxy")]
    pub no_proxy: String,
}

impl Default for NetworkProxySettings {
    fn default() -> Self {
        Self {
            mode: default_proxy_mode(),
            custom_proxy_url: String::new(),
            no_proxy: default_no_proxy(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedNetworkProxy {
    pub mode: String,
    pub source: String,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: String,
    pub warning: Option<String>,
}

pub fn default_proxy_mode() -> String {
    "system".into()
}

pub fn default_no_proxy() -> String {
    DEFAULT_NO_PROXY.into()
}

pub fn normalize_settings(settings: &NetworkProxySettings) -> NetworkProxySettings {
    NetworkProxySettings {
        mode: match settings.mode.trim() {
            "disabled" => "disabled",
            "custom" => "custom",
            _ => "system",
        }
        .into(),
        custom_proxy_url: settings.custom_proxy_url.trim().to_string(),
        no_proxy: normalize_no_proxy(&settings.no_proxy),
    }
}

pub fn resolve_network_proxy(
    settings: &NetworkProxySettings,
) -> Result<ResolvedNetworkProxy, String> {
    let settings = normalize_settings(settings);
    match settings.mode.as_str() {
        "disabled" => Ok(ResolvedNetworkProxy {
            mode: settings.mode,
            source: "disabled".into(),
            http_proxy: None,
            https_proxy: None,
            no_proxy: settings.no_proxy,
            warning: None,
        }),
        "custom" => {
            let proxy = normalize_proxy_url(&settings.custom_proxy_url)?;
            Ok(ResolvedNetworkProxy {
                mode: settings.mode,
                source: "custom".into(),
                http_proxy: Some(proxy.clone()),
                https_proxy: Some(proxy),
                no_proxy: settings.no_proxy,
                warning: None,
            })
        }
        _ => resolve_system_proxy(settings.no_proxy),
    }
}

pub fn apply_proxy_to_command(command: &mut Command, proxy: &ResolvedNetworkProxy) {
    clear_proxy_from_command(command);
    if let Some(value) = proxy.http_proxy.as_deref() {
        command.env("HTTP_PROXY", value).env("http_proxy", value);
    }
    if let Some(value) = proxy.https_proxy.as_deref() {
        command.env("HTTPS_PROXY", value).env("https_proxy", value);
    }
    if let Some(value) = proxy.https_proxy.as_deref().or(proxy.http_proxy.as_deref()) {
        command.env("ALL_PROXY", value).env("all_proxy", value);
    }
    command
        .env("NO_PROXY", &proxy.no_proxy)
        .env("no_proxy", &proxy.no_proxy);
}

pub fn apply_proxy_to_pty_command(
    command: &mut portable_pty::CommandBuilder,
    proxy: &ResolvedNetworkProxy,
) {
    // portable-pty inherits the already-sanitized Termflow environment. Only
    // explicitly resolved settings are added to the child shell.
    if let Some(value) = proxy.http_proxy.as_deref() {
        command.env("HTTP_PROXY", value);
        command.env("http_proxy", value);
    }
    if let Some(value) = proxy.https_proxy.as_deref() {
        command.env("HTTPS_PROXY", value);
        command.env("https_proxy", value);
    }
    if let Some(value) = proxy.https_proxy.as_deref().or(proxy.http_proxy.as_deref()) {
        command.env("ALL_PROXY", value);
        command.env("all_proxy", value);
    }
    command.env("NO_PROXY", &proxy.no_proxy);
    command.env("no_proxy", &proxy.no_proxy);
}

pub fn apply_proxy_to_client_builder(
    mut builder: ClientBuilder,
    proxy: &ResolvedNetworkProxy,
) -> Result<ClientBuilder, String> {
    let no_proxy = NoProxy::from_string(&proxy.no_proxy);
    if let Some(value) = proxy.http_proxy.as_deref() {
        builder = builder.proxy(
            Proxy::http(value)
                .map_err(|error| format!("HTTP 代理地址无效: {error}"))?
                .no_proxy(no_proxy.clone()),
        );
    }
    if let Some(value) = proxy.https_proxy.as_deref() {
        builder = builder.proxy(
            Proxy::https(value)
                .map_err(|error| format!("HTTPS 代理地址无效: {error}"))?
                .no_proxy(no_proxy),
        );
    }
    Ok(builder)
}

pub fn apply_proxy_to_blocking_client_builder(
    mut builder: reqwest::blocking::ClientBuilder,
    proxy: &ResolvedNetworkProxy,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    let no_proxy = NoProxy::from_string(&proxy.no_proxy);
    if let Some(value) = proxy.http_proxy.as_deref() {
        builder = builder.proxy(
            Proxy::http(value)
                .map_err(|error| format!("HTTP 代理地址无效: {error}"))?
                .no_proxy(no_proxy.clone()),
        );
    }
    if let Some(value) = proxy.https_proxy.as_deref() {
        builder = builder.proxy(
            Proxy::https(value)
                .map_err(|error| format!("HTTPS 代理地址无效: {error}"))?
                .no_proxy(no_proxy),
        );
    }
    Ok(builder)
}

pub fn redacted_proxy_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return value.to_string();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("***");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("***"));
    }
    url.to_string().trim_end_matches('/').to_string()
}

fn clear_proxy_from_command(command: &mut Command) {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        command.env_remove(key);
    }
}

fn normalize_no_proxy(value: &str) -> String {
    let mut entries = value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    for required in ["localhost", "127.0.0.1", "::1"] {
        if !entries.iter().any(|entry| entry == required) {
            entries.push(required.into());
        }
    }
    entries.join(",")
}

fn normalize_proxy_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("请输入代理地址".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|error| format!("代理地址无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("首版仅支持 HTTP 和 HTTPS 代理".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("首版暂不支持需要账号密码的代理".into());
    }
    if url.host_str().is_none() {
        return Err("代理地址缺少主机名".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

#[cfg(target_os = "windows")]
fn resolve_system_proxy(no_proxy: String) -> Result<ResolvedNetworkProxy, String> {
    use windows_registry::CURRENT_USER;

    const INTERNET_SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let key = match CURRENT_USER.open(INTERNET_SETTINGS) {
        Ok(key) => key,
        Err(_error) => {
            return Ok(ResolvedNetworkProxy {
                mode: "system".into(),
                source: "system-none".into(),
                http_proxy: None,
                https_proxy: None,
                no_proxy,
                warning: Some("systemReadFailed".into()),
            });
        }
    };
    let enabled = key.get_u32("ProxyEnable").unwrap_or(0) != 0;
    let pac_url = key
        .get_string("AutoConfigURL")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if !enabled {
        return Ok(ResolvedNetworkProxy {
            mode: "system".into(),
            source: "system-none".into(),
            http_proxy: None,
            https_proxy: None,
            no_proxy,
            warning: pac_url.map(|_| "pacUnsupported".into()),
        });
    }

    let raw = match key.get_string("ProxyServer") {
        Ok(value) => value,
        Err(_error) => {
            return Ok(ResolvedNetworkProxy {
                mode: "system".into(),
                source: "system-none".into(),
                http_proxy: None,
                https_proxy: None,
                no_proxy,
                warning: Some("systemServerReadFailed".into()),
            });
        }
    };
    let (http_proxy, https_proxy) = match parse_windows_proxy_server(&raw) {
        Ok(proxy) => proxy,
        Err(_error) => {
            return Ok(ResolvedNetworkProxy {
                mode: "system".into(),
                source: "system-none".into(),
                http_proxy: None,
                https_proxy: None,
                no_proxy,
                warning: Some("systemParseFailed".into()),
            });
        }
    };
    Ok(ResolvedNetworkProxy {
        mode: "system".into(),
        source: "windows-system".into(),
        http_proxy,
        https_proxy,
        no_proxy,
        warning: pac_url.map(|_| "pacManualUsed".into()),
    })
}

#[cfg(not(target_os = "windows"))]
fn resolve_system_proxy(no_proxy: String) -> Result<ResolvedNetworkProxy, String> {
    Ok(ResolvedNetworkProxy {
        mode: "system".into(),
        source: "system-none".into(),
        http_proxy: None,
        https_proxy: None,
        no_proxy,
        warning: Some("systemUnsupported".into()),
    })
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(raw: &str) -> Result<(Option<String>, Option<String>), String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("Windows 系统代理地址为空".into());
    }
    if !value.contains('=') {
        let proxy = normalize_proxy_url(value)?;
        return Ok((Some(proxy.clone()), Some(proxy)));
    }

    let mut http_proxy = None;
    let mut https_proxy = None;
    for entry in value.split(';') {
        let Some((scheme, address)) = entry.split_once('=') else {
            continue;
        };
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http_proxy = Some(normalize_proxy_url(address)?),
            "https" => https_proxy = Some(normalize_proxy_url(address)?),
            _ => {}
        }
    }
    if http_proxy.is_none() && https_proxy.is_none() {
        return Err("Windows 系统代理中没有 HTTP 或 HTTPS 地址".into());
    }
    if http_proxy.is_none() {
        http_proxy = https_proxy.clone();
    }
    if https_proxy.is_none() {
        https_proxy = http_proxy.clone();
    }
    Ok((http_proxy, https_proxy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_proxy_adds_http_scheme_and_local_bypass() {
        let resolved = resolve_network_proxy(&NetworkProxySettings {
            mode: "custom".into(),
            custom_proxy_url: "127.0.0.1:7897".into(),
            no_proxy: "example.test".into(),
        })
        .unwrap();
        assert_eq!(
            resolved.https_proxy.as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(resolved.no_proxy, "example.test,localhost,127.0.0.1,::1");
    }

    #[test]
    fn unsupported_proxy_scheme_is_rejected() {
        let result = resolve_network_proxy(&NetworkProxySettings {
            mode: "custom".into(),
            custom_proxy_url: "socks5://127.0.0.1:1080".into(),
            no_proxy: String::new(),
        });
        assert!(result.unwrap_err().contains("HTTP"));
    }

    #[test]
    fn proxy_credentials_are_redacted() {
        assert_eq!(
            redacted_proxy_url("http://alice:secret@127.0.0.1:7897"),
            "http://***:***@127.0.0.1:7897"
        );
    }

    #[test]
    fn proxy_credentials_are_rejected_by_the_mvp() {
        let result = normalize_proxy_url("http://alice:secret@127.0.0.1:7897");
        assert!(result.unwrap_err().contains("账号密码"));
    }

    #[test]
    fn configured_proxy_is_applied_to_child_process_environment() {
        let proxy = resolve_network_proxy(&NetworkProxySettings {
            mode: "custom".into(),
            custom_proxy_url: "http://127.0.0.1:7897".into(),
            no_proxy: "localhost".into(),
        })
        .unwrap();
        let mut command = Command::new("unused");
        apply_proxy_to_command(&mut command, &proxy);
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|item| item.to_string_lossy().to_string()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            environment.get("HTTPS_PROXY").and_then(Option::as_deref),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(
            environment.get("NO_PROXY").and_then(Option::as_deref),
            Some("localhost,127.0.0.1,::1")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_protocol_specific_proxy_is_parsed() {
        let (http, https) =
            parse_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7897").unwrap();
        assert_eq!(http.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(https.as_deref(), Some("http://127.0.0.1:7897"));
    }
}
