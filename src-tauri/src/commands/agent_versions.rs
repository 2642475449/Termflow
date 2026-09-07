use std::{sync::Arc, time::Duration};

use crate::{database::Database, network_proxy::apply_proxy_to_client_builder};

fn version_source(agent_id: &str) -> Result<(String, &'static str), String> {
    let package = match agent_id {
        "claude" => "@anthropic-ai/claude-code",
        "codex" => "@openai/codex",
        "opencode" => "opencode-ai",
        "pi" => "@earendil-works/pi-coding-agent",
        "qoder" => {
            return Ok((
                "https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json".into(),
                "latest",
            ))
        }
        "antigravity" => {
            let os = match std::env::consts::OS {
                "windows" => "windows",
                "macos" => "darwin",
                "linux" => "linux",
                _ => return Err("Unsupported platform".into()),
            };
            let arch = match std::env::consts::ARCH {
                "x86_64" => "amd64",
                "aarch64" => "arm64",
                _ => return Err("Unsupported architecture".into()),
            };
            return Ok((format!("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{os}_{arch}.json"), "version"));
        }
        _ => return Err("Unknown agent".into()),
    };
    Ok((
        format!("https://registry.npmjs.org/{package}/latest"),
        "version",
    ))
}

fn parse_version(value: &serde_json::Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|version| !version.is_empty() && version.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| "Invalid version response".into())
}

/// 仅请求官方版本元数据，不下载或执行安装程序。
#[tauri::command]
pub async fn check_agent_latest_version(
    agent_id: String,
    database: tauri::State<'_, Arc<Database>>,
) -> Result<String, String> {
    let (url, field) = version_source(&agent_id)?;
    let proxy = super::network_proxy::load_resolved_proxy(&database)?;
    let client = apply_proxy_to_client_builder(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("Termflow version check"),
        &proxy,
    )?
    .build()
    .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    parse_version(&value, field)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_agents_have_https_sources_and_unknown_ids_are_rejected() {
        for agent in super::super::agents::AGENT_DEFINITIONS {
            assert!(version_source(agent.id)
                .expect("known agent")
                .0
                .starts_with("https://"));
        }
        assert!(version_source("https://example.com").is_err());
    }

    #[test]
    fn manifests_require_nonempty_string_versions() {
        assert_eq!(
            parse_version(&serde_json::json!({"latest": " 1.2.3 "}), "latest"),
            Ok("1.2.3".into())
        );
        for value in [
            serde_json::json!({}),
            serde_json::json!({"version": 123}),
            serde_json::json!({"version": " "}),
        ] {
            assert!(parse_version(&value, "version").is_err());
        }
    }
}
