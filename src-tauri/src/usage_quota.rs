//! Provider-neutral quota data. Missing durations and balances remain unknown.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaDetails {
    pub quota_windows: Vec<QuotaWindow>,
    pub balances: Vec<QuotaBalance>,
    pub plan_type: Option<String>,
    pub limit_reached: Option<String>,
    pub empty_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub label: Option<String>,
    pub bucket_id: String,
    pub bucket_name: Option<String>,
    pub used_percent: f64,
    /// Zero means the source did not report a duration; never assume a plan's period.
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    pub reset_description: Option<String>,
    pub used_amount: Option<f64>,
    pub limit_amount: Option<f64>,
    pub currency: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaBalance {
    pub bucket_id: String,
    pub bucket_name: Option<String>,
    pub balance: Option<f64>,
    pub unlimited: bool,
    pub has_credits: Option<bool>,
}

impl QuotaDetails {
    pub fn has_data(&self) -> bool {
        !self.quota_windows.is_empty() || !self.balances.is_empty() || self.limit_reached.is_some()
    }
}

pub fn number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
}

pub fn timestamp(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(n) = number(Some(value)).filter(|n| *n > 0.0 && *n < i64::MAX as f64 / 1000.0) {
        let n = n as i64;
        return Some(if n < 10_000_000_000 { n * 1000 } else { n });
    }
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|v| v.timestamp_millis())
}

pub fn duration(value: Option<&Value>) -> u32 {
    number(value)
        .filter(|n| *n > 0.0 && *n <= u32::MAX as f64)
        .map(|n| n.round() as u32)
        .unwrap_or(0)
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

pub fn codex_rpc(result: &Value) -> QuotaDetails {
    let mut details = QuotaDetails::default();
    let legacy = result.get("rateLimits").unwrap_or(result);
    let groups = result.get("rateLimitsByLimitId").and_then(Value::as_object);
    if let Some(groups) = groups {
        for (id, group) in groups {
            codex_bucket(&mut details, id, group);
        }
    }
    let legacy_id = legacy
        .get("limitId")
        .and_then(Value::as_str)
        .unwrap_or("codex");
    // The map is authoritative for matching buckets; do not duplicate its legacy projection.
    if !groups.is_some_and(|groups| groups.get(legacy_id).is_some_and(Value::is_object)) {
        codex_bucket(&mut details, legacy_id, legacy);
    }
    if details.plan_type.is_none() {
        details.plan_type = text(legacy.get("planType"));
    }
    if !details.has_data() {
        details.empty_reason = Some("noQuota".into());
    }
    details
}

fn codex_bucket(details: &mut QuotaDetails, id: &str, group: &Value) {
    if !group.is_object() {
        return;
    }
    let name = text(group.get("limitName")).or_else(|| (id != "codex").then(|| id.to_owned()));
    if id == "codex" {
        details.plan_type = text(group.get("planType"));
    }
    if let Some(reached) = text(group.get("rateLimitReachedType")) {
        details.limit_reached = Some(reached);
    }
    for slot in ["primary", "secondary"] {
        let Some(raw) = group.get(slot) else {
            continue;
        };
        let Some(used) = number(raw.get("usedPercent")) else {
            continue;
        };
        details.quota_windows.push(QuotaWindow {
            id: format!("{id}:{slot}"),
            label: None,
            bucket_id: id.into(),
            bucket_name: name.clone(),
            used_percent: used.clamp(0.0, 100.0),
            window_minutes: duration(raw.get("windowDurationMins")),
            resets_at: timestamp(raw.get("resetsAt")),
            reset_description: None,
            used_amount: None,
            limit_amount: None,
            currency: None,
        });
    }
    if let Some(credits) = group.get("credits").filter(|v| v.is_object()) {
        let balance = number(credits.get("balance")).filter(|v| *v >= 0.0);
        let unlimited = credits
            .get("unlimited")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let has_credits = credits.get("hasCredits").and_then(Value::as_bool);
        if balance.is_some() || unlimited || has_credits.is_some() {
            details.balances.push(QuotaBalance {
                bucket_id: id.into(),
                bucket_name: name,
                balance,
                unlimited,
                has_credits,
            });
        }
    }
}

/// Same quota endpoint used by OpenCode's saved ChatGPT OAuth login. No token refresh.
pub fn codex_backend(value: &Value) -> QuotaDetails {
    fn bucket(
        value: &Value,
        credits: Option<&Value>,
        plan: Option<&Value>,
        name: Option<&Value>,
    ) -> Value {
        let mut result =
            serde_json::json!({"planType": plan, "limitName": name, "credits": credits});
        for (from, to) in [
            ("primary_window", "primary"),
            ("secondary_window", "secondary"),
        ] {
            if let Some(window) = value.get(from) {
                result[to] = serde_json::json!({
                    "usedPercent": window.get("used_percent"),
                    "windowDurationMins": number(window.get("limit_window_seconds")).map(|v| v / 60.0),
                    "resetsAt": timestamp(window.get("reset_at")).or_else(|| {
                        let seconds = number(window.get("reset_after_seconds"))
                            .filter(|v| *v >= 0.0 && *v < i64::MAX as f64 / 1000.0)?;
                        crate::usage_cache::now_ms().checked_add((seconds * 1000.0) as i64)
                    }),
                });
            }
        }
        if value.get("limit_reached").and_then(Value::as_bool) == Some(true) {
            result["rateLimitReachedType"] = Value::String("quota_reached".into());
        }
        result
    }
    let mut groups = serde_json::Map::new();
    let credits = value.get("credits").map(|c| serde_json::json!({
        "balance": c.get("balance"), "unlimited": c.get("unlimited"), "hasCredits": c.get("has_credits")
    }));
    groups.insert(
        "codex".into(),
        bucket(
            value.get("rate_limit").unwrap_or(&Value::Null),
            credits.as_ref(),
            value.get("plan_type"),
            None,
        ),
    );
    if let Some(extra) = value
        .get("additional_rate_limits")
        .and_then(Value::as_array)
    {
        for (i, group) in extra.iter().enumerate() {
            groups.insert(
                format!("additional:{i}"),
                bucket(
                    group.get("rate_limit").unwrap_or(&Value::Null),
                    None,
                    None,
                    group.get("limit_name"),
                ),
            );
        }
    }
    codex_rpc(&serde_json::json!({"rateLimitsByLimitId": groups}))
}

/// Accept only the quota object, never a full status-line payload or transcript.
pub fn claude_windows(value: &Value) -> QuotaDetails {
    let mut details = QuotaDetails::default();
    let Some(windows) = value.as_object() else {
        details.empty_reason = Some("noQuota".into());
        return details;
    };
    for (id, raw) in windows {
        let Some(used) =
            number(raw.get("used_percentage")).or_else(|| number(raw.get("utilization")))
        else {
            continue;
        };
        let period = raw.get("period").and_then(Value::as_str);
        let minutes = match id.as_str() {
            "five_hour" => 300,
            key if key.starts_with("seven_day") => 10_080,
            "spend_limit" => match period {
                Some("daily") => 1440,
                Some("weekly") => 10_080,
                _ => 0,
            },
            _ => duration(raw.get("window_minutes")),
        };
        let label = match id.as_str() {
            "five_hour" | "seven_day" => None,
            key if key.starts_with("seven_day_") => None,
            "spend_limit" => Some(
                match period {
                    Some("monthly") => "monthlySpend",
                    Some("daily") => "dailySpend",
                    Some("weekly") => "weeklySpend",
                    _ => "spendLimit",
                }
                .into(),
            ),
            "extra_usage" => Some("extraUsage".into()),
            _ => Some(id.clone()),
        };
        details.quota_windows.push(QuotaWindow {
            id: id.clone(),
            label,
            bucket_id: "claude".into(),
            bucket_name: id.strip_prefix("seven_day_").map(str::to_owned),
            used_percent: used.max(0.0),
            window_minutes: minutes,
            resets_at: timestamp(raw.get("resets_at")),
            reset_description: None,
            used_amount: number(raw.get("used_usd")),
            limit_amount: number(raw.get("limit_usd")),
            currency: (raw.get("used_usd").is_some() || raw.get("limit_usd").is_some())
                .then(|| "USD".into()),
        });
    }
    if !details.has_data() {
        details.empty_reason = Some("noQuota".into());
    }
    details
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_monthly_unknown_and_all_buckets_without_duplicates() {
        let value = codex_rpc(
            &json!({"rateLimits": {"primary": {"usedPercent": 9}}, "rateLimitsByLimitId": {
                "codex": {"planType": "go", "primary": {"usedPercent": 12, "windowDurationMins": 43200}},
                "model": {"primary": {"usedPercent": 10, "windowDurationMins": 15}, "secondary": {"usedPercent": 20}}
            }}),
        );
        assert_eq!(value.quota_windows.len(), 3);
        assert_eq!(value.plan_type.as_deref(), Some("go"));
        assert_eq!(value.quota_windows[0].window_minutes, 43200);
        assert_eq!(value.quota_windows[2].window_minutes, 0);
    }

    #[test]
    fn balance_only_and_zero_are_data_but_missing_balance_is_not_zero() {
        for credits in [
            json!({"balance": "0"}),
            json!({"unlimited": true}),
            json!({"hasCredits": true}),
        ] {
            let value = codex_rpc(&json!({"rateLimits": {"credits": credits}}));
            assert!(value.has_data());
            assert!(value.empty_reason.is_none());
        }
        assert_eq!(
            codex_rpc(&json!({"credits": {"hasCredits": true}})).balances[0].balance,
            None
        );
        assert!(!codex_rpc(&json!({"credits": {"balance": "NaN"}})).has_data());
    }

    #[test]
    fn backend_keeps_extra_secondary_windows_and_balance() {
        let value = codex_backend(&json!({"plan_type": "plus", "credits": {"balance": "12.5"},
        "additional_rate_limits": [{"limit_name": "model", "rate_limit": {
            "primary_window": {"used_percent": 10, "limit_window_seconds": 900},
            "secondary_window": {"used_percent": 80, "limit_window_seconds": 604800}
        }}]}));
        assert_eq!(value.quota_windows.len(), 2);
        assert_eq!(value.quota_windows[0].window_minutes, 15);
        assert_eq!(value.balances[0].balance, Some(12.5));
    }

    #[test]
    fn claude_gateway_only_unknown_period_and_optional_amounts() {
        let value = claude_windows(
            &json!({"spend_limit": {"used_percentage": 105, "period": "monthly", "resets_at": 1800000000}}),
        );
        assert!(value.has_data());
        assert_eq!(
            value.quota_windows[0].label.as_deref(),
            Some("monthlySpend")
        );
        assert_eq!(value.quota_windows[0].used_amount, None);
        assert_eq!(value.quota_windows[0].window_minutes, 0);
        assert_eq!(value.quota_windows[0].resets_at, Some(1800000000000));
        assert!(!claude_windows(&json!({"five_hour": {"used_percentage": null}})).has_data());
    }
}
