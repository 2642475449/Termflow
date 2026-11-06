//! Read quota for OpenCode's own saved logins. Never borrow Codex/Claude credentials,
//! refresh tokens, or query arbitrary provider URLs from configuration.
use crate::database::Database;
use crate::usage_cache::{
    fingerprint, now_ms, query_cached, SharedUsageCache, UsageResponse, UsageSnapshot,
};
use crate::usage_quota::{self, QuotaDetails, QuotaWindow};
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::{fs, io::Read, path::PathBuf, sync::OnceLock, time::Duration};
use tauri::{Emitter, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeUsage {
    pub accounts: Vec<OpenCodeUsageAccount>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeUsageAccount {
    pub provider: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(flatten)]
    pub quota: QuotaDetails,
}

impl UsageSnapshot for OpenCodeUsage {
    fn status(&self) -> &str {
        &self.status
    }
    fn with_failure(&self, failure: Self) -> Self {
        failure
    }
}

fn auth_path() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs_next::home_dir().map(|p| p.join(".local/share")))
        .map(|p| p.join("opencode/auth.json"))
}

#[tauri::command]
pub async fn get_opencode_usage(
    app: tauri::AppHandle,
    database: State<'_, Arc<Database>>,
    force_refresh: Option<bool>,
) -> Result<UsageResponse<OpenCodeUsage>, String> {
    let requested_at = now_ms();
    let proxy = crate::commands::network_proxy::load_resolved_proxy(&database)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        static CACHE: OnceLock<SharedUsageCache<OpenCodeUsage>> = OnceLock::new();
        let path = auth_path();
        let raw = path.as_ref().and_then(|p| fs::read(p).ok());
        let key = fingerprint((&path, &raw, serde_json::to_string(&proxy).ok()));
        query_cached(
            CACHE.get_or_init(Default::default),
            key,
            0,
            requested_at,
            force_refresh.unwrap_or(false),
            || {
                let result = fetch(raw.as_deref(), &proxy);
                if path.as_ref().and_then(|p| fs::read(p).ok()) != raw {
                    return Err("OpenCode login changed during usage query".into());
                }
                Ok(result)
            },
        )
    })
    .await
    .map_err(|_| "OpenCode usage task failed".to_string())??;
    let _ = app.emit("opencode-usage-updated", &result);
    Ok(result)
}

fn fetch(raw: Option<&[u8]>, proxy: &crate::network_proxy::ResolvedNetworkProxy) -> OpenCodeUsage {
    let mut result = OpenCodeUsage {
        accounts: Vec::new(),
        status: "ok".into(),
        error: None,
        updated_at: now_ms(),
    };
    let Some(raw) = raw else {
        result.status = "unavailable".into();
        return result;
    };
    let Ok(Value::Object(entries)) = serde_json::from_slice::<Value>(raw) else {
        result.status = "error".into();
        result.error = Some("invalidCredentials".into());
        return result;
    };
    let client = crate::network_proxy::apply_proxy_to_blocking_client_builder(
        Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none()),
        proxy,
    )
    .and_then(|builder| builder.build().map_err(|_| "network".to_string()));
    // Local entries are shown separately: the last globally selected model is not evidence
    // that every running OpenCode session bills that provider.
    for (provider, entry) in entries.iter().take(64) {
        let account = match client.as_ref() {
            Ok(client) => read_account(provider, entry, client),
            Err(_) => account_error(provider, "network"),
        };
        result.accounts.push(account);
    }
    if result.accounts.iter().any(|a| a.status == "error") {
        result.status = "error".into();
    }
    result
}

fn account_error(provider: &str, error: &str) -> OpenCodeUsageAccount {
    OpenCodeUsageAccount {
        provider: provider.into(),
        status: "error".into(),
        error: Some(error.into()),
        quota: QuotaDetails::default(),
    }
}

fn read_account(provider: &str, entry: &Value, client: &Client) -> OpenCodeUsageAccount {
    let mut account = OpenCodeUsageAccount {
        provider: provider.into(),
        status: "ok".into(),
        error: None,
        quota: QuotaDetails::default(),
    };
    let kind = entry.get("type").and_then(Value::as_str);
    let oauth = kind == Some("oauth");
    let go = matches!(provider, "opencode-go" | "opencode");
    if go
        && entry
            .pointer("/metadata/server")
            .and_then(Value::as_str)
            .is_some_and(|url| {
                !matches!(
                    url.trim_end_matches('/'),
                    "https://opencode.ai/console" | "https://console.opencode.ai"
                )
            })
    {
        account.quota.empty_reason = Some("unsupportedProvider".into());
        return account;
    }
    let supported = go || (oauth && matches!(provider, "openai" | "anthropic"));
    if !supported {
        account.quota.empty_reason = Some(
            if provider == "opencode" {
                "consoleQuota"
            } else if kind == Some("api") {
                "apiBilling"
            } else {
                "unsupportedProvider"
            }
            .into(),
        );
        return account;
    }
    if oauth
        && usage_quota::number(entry.get("expires")).is_some_and(|expiry| expiry <= now_ms() as f64)
    {
        account.quota.empty_reason = Some("loginExpired".into());
        return account;
    }
    let token = entry
        .get(if oauth { "access" } else { "key" })
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let Some(token) = token else {
        account.quota.empty_reason = Some("notSignedIn".into());
        return account;
    };
    if provider == "opencode" {
        return read_console_account(provider, token, entry, client);
    }
    let url = match provider {
        "openai" => "https://chatgpt.com/backend-api/wham/usage",
        "anthropic" => "https://api.anthropic.com/api/oauth/usage",
        _ => "https://opencode.ai/zen/go/v1/usage",
    };
    let mut request = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json");
    if go {
        if let Some(org) = entry.pointer("/metadata/orgID").and_then(Value::as_str) {
            request = request.header("x-opencode-org-id", org);
        }
    }
    if provider == "anthropic" {
        request = request.header("anthropic-beta", "oauth-2025-04-20");
    }
    if provider == "openai" {
        if let Some(id) = entry.get("accountId").and_then(Value::as_str) {
            request = request.header("ChatGPT-Account-Id", id);
        }
    }
    let response = match request.send() {
        Ok(value) => value,
        Err(_) => return account_error(provider, "network"),
    };
    let status = response.status().as_u16();
    if status == 401 {
        account.quota.empty_reason = Some("loginExpired".into());
        return account;
    }
    if status == 403 {
        account.quota.empty_reason = Some("accessDenied".into());
        return account;
    }
    if !response.status().is_success() {
        return account_error(
            provider,
            if status == 429 {
                "rateLimited"
            } else {
                "serviceError"
            },
        );
    }
    let mut body = Vec::new();
    if response.take(1_048_577).read_to_end(&mut body).is_err() || body.len() > 1_048_576 {
        return account_error(provider, "invalidResponse");
    }
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return account_error(provider, "invalidResponse");
    };
    if !value.is_object() {
        return account_error(provider, "invalidResponse");
    }
    account.quota = match provider {
        "openai" => usage_quota::codex_backend(&value),
        "anthropic" => usage_quota::claude_windows(&value),
        _ => go_usage(&value),
    };
    account
}

fn go_usage(value: &Value) -> QuotaDetails {
    let mut result = QuotaDetails::default();
    for (id, minutes) in [("rolling", 300), ("weekly", 10080), ("monthly", 0)] {
        let Some(raw) = value.get("usage").and_then(|v| v.get(id)) else {
            continue;
        };
        let Some(used) = usage_quota::number(raw.get("percent")) else {
            continue;
        };
        result.quota_windows.push(QuotaWindow {
            id: id.into(),
            label: (id == "monthly").then(|| "monthly".into()),
            bucket_id: "opencode-go".into(),
            bucket_name: None,
            used_percent: used.clamp(0.0, 100.0),
            window_minutes: minutes,
            resets_at: usage_quota::timestamp(raw.get("resetsAt")),
            reset_description: None,
            used_amount: None,
            limit_amount: None,
            currency: None,
        });
    }
    if !result.has_data() {
        result.empty_reason = Some("noQuota".into());
    }
    result
}

fn read_console_account(
    provider: &str,
    token: &str,
    entry: &Value,
    client: &Client,
) -> OpenCodeUsageAccount {
    let mut account = OpenCodeUsageAccount {
        provider: provider.into(),
        status: "ok".into(),
        error: None,
        quota: QuotaDetails::default(),
    };
    // Only the official console is supported. Do not replay a custom console's credential elsewhere.
    if entry
        .pointer("/metadata/server")
        .and_then(Value::as_str)
        .is_some_and(|url| {
            !matches!(
                url.trim_end_matches('/'),
                "https://opencode.ai/console" | "https://console.opencode.ai"
            )
        })
    {
        account.quota.empty_reason = Some("unsupportedProvider".into());
        return account;
    }
    for (url, budgets) in [
        ("https://opencode.ai/zen/go/v1/usage", false),
        (
            "https://opencode.ai/console/api/policies/current-budgets",
            true,
        ),
    ] {
        let mut request = client
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/json");
        if let Some(org) = entry.pointer("/metadata/orgID").and_then(Value::as_str) {
            request = request.header(
                if budgets {
                    "x-org-id"
                } else {
                    "x-opencode-org-id"
                },
                org,
            );
        }
        let response = match request.send() {
            Ok(r) => r,
            Err(_) => {
                account.error = Some("network".into());
                continue;
            }
        };
        match response.status().as_u16() {
            401 => {
                account.quota.empty_reason = Some("loginExpired".into());
                return account;
            }
            403 => continue, // Service accounts/no Go entitlement need not have a budget/window.
            429 => {
                account.error = Some("rateLimited".into());
                continue;
            }
            _ if !response.status().is_success() => {
                account.error = Some("serviceError".into());
                continue;
            }
            _ => {}
        }
        let mut body = Vec::new();
        if response.take(1_048_577).read_to_end(&mut body).is_err() || body.len() > 1_048_576 {
            account.error = Some("invalidResponse".into());
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&body) else {
            account.error = Some("invalidResponse".into());
            continue;
        };
        if budgets {
            if !value.is_array() {
                account.error = Some("invalidResponse".into());
                continue;
            }
            account.quota.quota_windows.extend(console_budgets(&value));
        } else {
            if !value.get("usage").is_some_and(Value::is_object) {
                account.error = Some("invalidResponse".into());
                continue;
            }
            account
                .quota
                .quota_windows
                .extend(go_usage(&value).quota_windows);
        }
    }
    if account.error.is_some() {
        account.status = "error".into();
    }
    if !account.quota.has_data() && account.error.is_none() {
        account.quota.empty_reason = Some("consoleQuota".into());
    }
    account
}

fn console_budgets(value: &Value) -> Vec<QuotaWindow> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, raw)| {
            let limit = usage_quota::number(raw.get("limitDollars")).filter(|v| *v >= 0.0)?;
            let spent = usage_quota::number(raw.get("spentDollars")).filter(|v| *v >= 0.0)?;
            let period = raw.get("per").and_then(Value::as_str).unwrap_or("");
            let label = match period {
                "day" | "daily" => "dailySpend",
                "week" | "weekly" => "weeklySpend",
                "month" | "monthly" => "monthlySpend",
                _ => "spendLimit",
            };
            let id = raw
                .get("ruleID")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| i.to_string());
            Some(QuotaWindow {
                id: format!("budget:{id}"),
                label: Some(label.into()),
                bucket_id: "console-budget".into(),
                bucket_name: raw
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|models| {
                        models
                            .iter()
                            .filter_map(|m| m.get("name").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .filter(|s| !s.is_empty()),
                used_percent: if limit > 0.0 {
                    (spent / limit * 100.0).min(100.0)
                } else {
                    100.0
                },
                window_minutes: 0,
                resets_at: usage_quota::timestamp(raw.get("resetsAt")),
                reset_description: None,
                used_amount: Some(spent),
                limit_amount: Some(limit),
                currency: Some("USD".into()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn console_budget_keeps_money_separate_from_credits_and_zero_budget_is_exhausted() {
        let windows = console_budgets(&json!([
            {"ruleID":"one", "limitDollars":100, "spentDollars":25, "per":"monthly", "resetsAt":"2026-12-01T00:00:00Z"},
            {"ruleID":"two", "limitDollars":0, "spentDollars":0}
        ]));
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].used_percent, 25.0);
        assert_eq!(windows[0].currency.as_deref(), Some("USD"));
        assert_eq!(windows[0].label.as_deref(), Some("monthlySpend"));
        assert_eq!(windows[1].used_percent, 100.0);
    }
    #[test]
    fn api_and_unknown_providers_never_use_subscription_credentials() {
        let client = Client::new();
        let api = read_account(
            "openai",
            &json!({"type":"api", "key":"must-not-be-sent"}),
            &client,
        );
        assert_eq!(api.quota.empty_reason.as_deref(), Some("apiBilling"));
        let unknown = read_account(
            "custom",
            &json!({"type":"oauth", "access":"must-not-be-sent"}),
            &client,
        );
        assert_eq!(
            unknown.quota.empty_reason.as_deref(),
            Some("unsupportedProvider")
        );
        let expired = read_account(
            "anthropic",
            &json!({"type":"oauth", "access":"must-not-be-sent", "expires":1}),
            &client,
        );
        assert_eq!(expired.quota.empty_reason.as_deref(), Some("loginExpired"));
        assert!(!serde_json::to_string(&api)
            .unwrap()
            .contains("must-not-be-sent"));
    }
    #[test]
    fn go_keeps_each_available_window_and_does_not_invent_a_calendar_month_length() {
        let value = go_usage(
            &json!({"usage":{"monthly":{"percent":42,"resetsAt":"2026-12-01T00:00:00Z"}}}),
        );
        assert_eq!(value.quota_windows.len(), 1);
        assert_eq!(value.quota_windows[0].label.as_deref(), Some("monthly"));
        assert_eq!(value.quota_windows[0].window_minutes, 0);
        assert!(value.quota_windows[0].resets_at.is_some());
    }
}
