use crate::hook_ingest::HookIngestConfig;
use crate::path_utils::{display_path, normalize_input_path};
use crate::qoder_config::{qoder_user_config_root, qoder_workspace_config_root};
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Timelike, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::State;

const CLAUDE_REQUIRED_STATUS_EVENTS: [&str; 8] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

#[derive(Debug, Serialize)]
pub struct HookStatus {
    pub configured: bool,
    pub config_path: String,
    pub hook_command: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HookIngestClientConfig {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEffortInfo {
    pub effective_level: String,
    pub configured_level: Option<String>,
    pub source: String,
    pub config_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdDetail {
    pub scope: String,
    pub file_path: String,
    pub directory_path: String,
    pub exists: bool,
    pub content: String,
    pub source: String,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageOverview {
    pub last_computed_date: Option<String>,
    pub summary: AgentUsageOverviewSummary,
    pub token_breakdown: AgentUsageTokenBreakdown,
    pub heatmap: Vec<AgentUsageHeatmapDay>,
    pub daily_activity: Vec<AgentUsageDailyActivity>,
    pub daily_model_tokens: Vec<AgentUsageDailyModelTokens>,
    pub providers: Vec<AgentUsageProviderSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageProviderSummary {
    pub agent: String,
    pub label: String,
    pub capability: String,
    pub source: String,
    pub total_tokens: u64,
    pub total_sessions: u64,
    pub total_messages: u64,
    pub active_days: u32,
    pub favorite_model: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageOverviewSummary {
    pub total_tokens: u64,
    pub total_messages: u64,
    pub peak_daily_tokens: u64,
    pub longest_session_ms: u64,
    pub current_streak_days: u32,
    pub longest_streak_days: u32,
    pub total_sessions: u64,
    pub active_days: u32,
    pub total_days: u32,
    pub favorite_model: Option<String>,
    pub peak_hour: Option<u8>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageTokenBreakdown {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub other_tokens: u64,
    pub total_tokens: u64,
}

impl AgentUsageTokenBreakdown {
    fn recalculate_total(&mut self) {
        self.total_tokens = self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
            + self.reasoning_output_tokens
            + self.other_tokens;
    }

    fn add_model_usage(&mut self, usage: &ClaudeStatsModelUsage) {
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.cache_read_tokens += usage.cache_read_input_tokens;
        self.cache_creation_tokens += usage.cache_creation_input_tokens;
        self.recalculate_total();
    }

    fn add_codex_usage(&mut self, usage: RawTokenUsage, total_tokens: u64) {
        let cache_read_tokens = usage.cached_input_tokens.min(usage.input_tokens);
        let reasoning_output_tokens = usage.reasoning_output_tokens.min(usage.output_tokens);
        self.input_tokens += usage.input_tokens - cache_read_tokens;
        self.output_tokens += usage.output_tokens - reasoning_output_tokens;
        self.cache_read_tokens += cache_read_tokens;
        self.reasoning_output_tokens += reasoning_output_tokens;

        // Codex reports cached input and reasoning output as detail subsets of
        // input/output. Keep the display buckets mutually exclusive so their
        // sum remains equal to the provider total.
        let known_total = usage.input_tokens + usage.output_tokens;
        if total_tokens > known_total {
            self.other_tokens += total_tokens - known_total;
        }
        self.recalculate_total();
    }

    fn add_opencode_usage(&mut self, usage: RawTokenUsage, total_tokens: u64) {
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.cache_read_tokens += usage.cached_input_tokens;
        self.reasoning_output_tokens += usage.reasoning_output_tokens;

        // OpenCode persists cache reads and reasoning as separate usage
        // categories, unlike the detail subsets reported by Codex.
        let known_total = usage.input_tokens
            + usage.output_tokens
            + usage.cached_input_tokens
            + usage.reasoning_output_tokens;
        if total_tokens > known_total {
            self.other_tokens += total_tokens - known_total;
        }
        self.recalculate_total();
    }

    fn add_total_as_other(&mut self, total_tokens: u64) {
        self.other_tokens += total_tokens;
        self.recalculate_total();
    }

    fn merge(&mut self, other: AgentUsageTokenBreakdown) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.reasoning_output_tokens += other.reasoning_output_tokens;
        self.other_tokens += other.other_tokens;
        self.recalculate_total();
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageHeatmapDay {
    pub date: String,
    pub token_count: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageDailyActivity {
    pub date: String,
    pub message_count: u64,
    pub session_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageDailyModelTokens {
    pub date: String,
    pub tokens_by_model: std::collections::BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub agent: String,
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub scope: String,
    pub event: String,
    pub matcher: String,
    pub command: String,
    pub command_preview: String,
    pub timeout: Option<u64>,
    pub config_path: String,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookCatalog {
    pub hooks: Vec<HookInfo>,
    pub workspace_config_path: Option<String>,
    pub user_config_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDetail {
    pub hook: HookInfo,
    pub raw_config: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredHookEntry {
    event: String,
    matcher: String,
    action_type: String,
    command: String,
    timeout: Option<u64>,
}

#[derive(Debug, Clone)]
struct HookRecord {
    info: HookInfo,
    raw_config: Value,
}

fn normalize_hook_agent(agent: &str) -> Result<&'static str, String> {
    match agent {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        "qoder" => Ok("qoder"),
        "antigravity" => Ok("antigravity"),
        "opencode" => Ok("opencode"),
        _ => Err("该智能体不支持 Hook 设置".to_string()),
    }
}

fn get_user_codex_hooks_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".codex").join("hooks.json"))
}

fn get_user_qoder_settings_path() -> Result<PathBuf, String> {
    Ok(qoder_user_config_root()?.join("settings.json"))
}

fn get_user_antigravity_hooks_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".gemini").join("config").join("hooks.json"))
}

fn get_user_opencode_plugin_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join("termflow-status.js"))
}

fn get_agent_scope_config_path(
    agent: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    let agent = normalize_hook_agent(agent)?;
    match (agent, scope) {
        ("claude", _) => get_scope_config_path(scope, project_path),
        ("codex", "user") => get_user_codex_hooks_path(),
        ("codex", "workspace") => {
            let project_path =
                project_path.ok_or("当前未打开项目，无法读取项目级 Codex Hook 配置")?;
            Ok(normalize_input_path(project_path)
                .join(".codex")
                .join("hooks.json"))
        }
        ("qoder", "user") => get_user_qoder_settings_path(),
        ("qoder", "workspace") => {
            let project_path =
                project_path.ok_or("当前未打开项目，无法读取项目级 Qoder Hook 配置")?;
            Ok(
                qoder_workspace_config_root(&normalize_input_path(project_path))?
                    .join("settings.json"),
            )
        }
        ("antigravity", "user") => get_user_antigravity_hooks_path(),
        ("antigravity", "workspace") => {
            let project_path =
                project_path.ok_or("当前未打开项目，无法读取项目级 Antigravity Hook 配置")?;
            Ok(normalize_input_path(project_path)
                .join(".agents")
                .join("hooks.json"))
        }
        ("opencode", "user") => get_user_opencode_plugin_path(),
        ("opencode", "workspace") => {
            let project_path =
                project_path.ok_or("当前未打开项目，无法读取项目级 OpenCode Plugin 配置")?;
            Ok(normalize_input_path(project_path)
                .join(".opencode")
                .join("plugins")
                .join("termflow-status.js"))
        }
        _ => Err("无效的 Hook 来源".to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatsCache {
    #[serde(default)]
    last_computed_date: Option<String>,
    #[serde(default)]
    daily_activity: Vec<ClaudeStatsDailyActivity>,
    #[serde(default)]
    daily_model_tokens: Vec<ClaudeStatsDailyModelTokens>,
    #[serde(default)]
    model_usage: BTreeMap<String, ClaudeStatsModelUsage>,
    #[serde(default)]
    total_sessions: Option<u64>,
    #[serde(default)]
    total_messages: Option<u64>,
    #[serde(default)]
    longest_session: Option<ClaudeStatsLongestSession>,
    #[serde(default)]
    first_session_date: Option<String>,
    #[serde(default)]
    last_session_date: Option<String>,
    #[serde(default)]
    hour_counts: BTreeMap<String, u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatsDailyActivity {
    date: String,
    #[serde(default)]
    message_count: Option<u64>,
    #[serde(default)]
    session_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatsDailyModelTokens {
    date: String,
    #[serde(default)]
    tokens_by_model: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatsModelUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

impl ClaudeStatsModelUsage {
    fn total_tokens(&self) -> u64 {
        self.input_tokens
            + self.output_tokens
            + self.cache_read_input_tokens
            + self.cache_creation_input_tokens
    }

    fn merge_max(&mut self, other: &ClaudeStatsModelUsage) {
        self.input_tokens = self.input_tokens.max(other.input_tokens);
        self.output_tokens = self.output_tokens.max(other.output_tokens);
        self.cache_read_input_tokens = self
            .cache_read_input_tokens
            .max(other.cache_read_input_tokens);
        self.cache_creation_input_tokens = self
            .cache_creation_input_tokens
            .max(other.cache_creation_input_tokens);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatsLongestSession {
    duration: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregatedTranscriptStats {
    daily_activity: BTreeMap<String, AgentUsageDailyActivity>,
    daily_model_tokens: BTreeMap<String, BTreeMap<String, u64>>,
    model_usage: BTreeMap<String, ClaudeStatsModelUsage>,
    token_breakdown: AgentUsageTokenBreakdown,
    total_sessions: u64,
    total_messages: u64,
    longest_session_ms: u64,
    first_session_date: Option<String>,
    last_session_date: Option<String>,
    hour_counts: BTreeMap<String, u64>,
}

impl AggregatedTranscriptStats {
    pub(crate) fn total_tokens(&self) -> u64 {
        compute_total_tokens(&self.model_usage)
    }

    pub(crate) fn total_messages(&self) -> u64 {
        self.total_messages
    }
}

#[derive(Debug, Clone)]
struct UsageSessionSpan {
    first_timestamp: DateTime<Utc>,
    last_timestamp: DateTime<Utc>,
}

impl UsageSessionSpan {
    fn new(timestamp: DateTime<Utc>) -> Self {
        Self {
            first_timestamp: timestamp,
            last_timestamp: timestamp,
        }
    }

    fn update(&mut self, timestamp: DateTime<Utc>) {
        if timestamp < self.first_timestamp {
            self.first_timestamp = timestamp;
        }
        if timestamp > self.last_timestamp {
            self.last_timestamp = timestamp;
        }
    }
}

#[derive(Debug, Clone)]
struct ParsedAgentUsageEvent {
    session_id: String,
    timestamp: DateTime<Utc>,
    model: String,
    total_tokens: u64,
    token_breakdown: AgentUsageTokenBreakdown,
}

fn get_user_claude_config_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".claude").join("settings.json"))
}

pub(crate) fn get_scope_config_path(
    scope: &str,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    match scope {
        "user" => get_user_claude_config_path(),
        "workspace" => {
            let project_path =
                project_path.ok_or("当前未打开项目，无法读取项目级 Claude Hook 配置")?;
            Ok(normalize_input_path(project_path)
                .join(".claude")
                .join("settings.json"))
        }
        _ => Err("无效的 Hook 来源".to_string()),
    }
}

fn get_local_claude_config_path(project_path: &str) -> PathBuf {
    normalize_input_path(project_path)
        .join(".claude")
        .join("settings.local.json")
}

fn get_user_claude_md_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".claude").join("CLAUDE.md"))
}

fn get_claude_stats_cache_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".claude").join("stats-cache.json"))
}

fn get_workspace_claude_md_root_path(project_path: &str) -> PathBuf {
    normalize_input_path(project_path).join("CLAUDE.md")
}

fn get_workspace_claude_md_alt_path(project_path: &str) -> PathBuf {
    normalize_input_path(project_path)
        .join(".claude")
        .join("CLAUDE.md")
}

fn get_local_claude_md_path(project_path: &str) -> PathBuf {
    normalize_input_path(project_path).join("CLAUDE.local.md")
}

fn resolve_workspace_claude_md_path(project_path: &str) -> (PathBuf, &'static str) {
    let root_path = get_workspace_claude_md_root_path(project_path);
    let alt_path = get_workspace_claude_md_alt_path(project_path);
    if root_path.exists() {
        (root_path, "workspace-root")
    } else if alt_path.exists() {
        (alt_path, "workspace-dot-claude")
    } else {
        (root_path, "workspace-root")
    }
}

fn resolve_claude_md_path(
    scope: &str,
    project_path: Option<&str>,
) -> Result<(PathBuf, String), String> {
    match scope {
        "user" => Ok((get_user_claude_md_path()?, "user".to_string())),
        "workspace" => {
            let project_path = project_path.ok_or("当前未打开项目，无法读取项目级 CLAUDE.md")?;
            let (path, source) = resolve_workspace_claude_md_path(project_path);
            Ok((path, source.to_string()))
        }
        "local" => {
            let project_path =
                project_path.ok_or("当前未打开项目，无法读取本地 CLAUDE.local.md")?;
            Ok((get_local_claude_md_path(project_path), "local".to_string()))
        }
        _ => Err("无效的 CLAUDE.md 来源".to_string()),
    }
}

pub(crate) fn read_settings(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        return Ok(json!({}));
    }
    let content =
        fs::read_to_string(config_path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析配置文件失败: {}", e))
}

fn get_claude_projects_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".claude").join("projects"))
}

fn load_claude_stats_cache() -> Result<Option<ClaudeStatsCache>, String> {
    let cache_path = get_claude_stats_cache_path()?;
    if !cache_path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&cache_path).map_err(|e| format!("读取 Claude 统计缓存失败: {}", e))?;
    let parsed =
        serde_json::from_str(&content).map_err(|e| format!("解析 Claude 统计缓存失败: {}", e))?;
    Ok(Some(parsed))
}

fn is_subagent_session_file(path: &Path) -> bool {
    let file_name_is_subagent = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        .unwrap_or(false);
    let has_subagents_component = path
        .components()
        .any(|component| component.as_os_str() == "subagents");
    file_name_is_subagent && has_subagents_component
}

fn is_top_level_session_file(projects_root: &Path, path: &Path) -> bool {
    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    parent.parent() == Some(projects_root)
}

fn collect_claude_session_files() -> Result<Vec<PathBuf>, String> {
    fn walk(dir: &Path, projects_root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in
            fs::read_dir(dir).map_err(|e| format!("读取 Claude transcript 目录失败: {}", e))?
        {
            let entry = entry.map_err(|e| format!("读取 Claude transcript 条目失败: {}", e))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("读取 Claude transcript 文件类型失败: {}", e))?;
            if file_type.is_dir() {
                walk(&path, projects_root, output)?;
                continue;
            }
            if is_top_level_session_file(projects_root, &path) || is_subagent_session_file(&path) {
                output.push(path);
            }
        }
        Ok(())
    }

    let projects_root = get_claude_projects_path()?;
    if !projects_root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    walk(&projects_root, &projects_root, &mut files)?;
    Ok(files)
}

fn parse_timestamp_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn local_date_string(timestamp: &DateTime<Utc>) -> String {
    timestamp
        .with_timezone(&Local)
        .format("%Y-%m-%d")
        .to_string()
}

fn local_hour_string(timestamp: &DateTime<Utc>) -> String {
    timestamp.with_timezone(&Local).hour().to_string()
}

fn today_local_date_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn next_date_string(value: &str) -> Option<String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    Some((date + Duration::days(1)).format("%Y-%m-%d").to_string())
}

fn update_min_string(target: &mut Option<String>, candidate: String) {
    match target {
        Some(current) if *current <= candidate => {}
        _ => *target = Some(candidate),
    }
}

fn update_max_string(target: &mut Option<String>, candidate: String) {
    match target {
        Some(current) if *current >= candidate => {}
        _ => *target = Some(candidate),
    }
}

fn merge_model_usage(
    destination: &mut BTreeMap<String, ClaudeStatsModelUsage>,
    source: BTreeMap<String, ClaudeStatsModelUsage>,
) {
    for (model, usage) in source {
        let aggregate = destination.entry(model).or_default();
        aggregate.input_tokens += usage.input_tokens;
        aggregate.output_tokens += usage.output_tokens;
        aggregate.cache_read_input_tokens += usage.cache_read_input_tokens;
        aggregate.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    }
}

pub(crate) fn merge_aggregated_stats(
    destination: &mut AggregatedTranscriptStats,
    source: AggregatedTranscriptStats,
) {
    for (date, entry) in source.daily_activity {
        let aggregate =
            destination
                .daily_activity
                .entry(date.clone())
                .or_insert(AgentUsageDailyActivity {
                    date,
                    message_count: 0,
                    session_count: 0,
                });
        aggregate.message_count += entry.message_count;
        aggregate.session_count += entry.session_count;
    }

    for (date, tokens_by_model) in source.daily_model_tokens {
        let aggregate = destination.daily_model_tokens.entry(date).or_default();
        for (model, count) in tokens_by_model {
            *aggregate.entry(model).or_insert(0) += count;
        }
    }

    merge_model_usage(&mut destination.model_usage, source.model_usage);
    destination.token_breakdown.merge(source.token_breakdown);

    destination.total_sessions += source.total_sessions;
    destination.total_messages += source.total_messages;
    destination.longest_session_ms = destination
        .longest_session_ms
        .max(source.longest_session_ms);

    if let Some(first_session_date) = source.first_session_date {
        update_min_string(&mut destination.first_session_date, first_session_date);
    }
    if let Some(last_session_date) = source.last_session_date {
        update_max_string(&mut destination.last_session_date, last_session_date);
    }

    for (hour, count) in source.hour_counts {
        *destination.hour_counts.entry(hour).or_insert(0) += count;
    }
}

fn active_day_count(stats: &AggregatedTranscriptStats) -> u32 {
    stats
        .daily_activity
        .values()
        .filter(|entry| entry.message_count > 0 || entry.session_count > 0)
        .count() as u32
}

fn build_provider_summary(
    agent: &str,
    label: &str,
    capability: &str,
    source: &str,
    stats: &AggregatedTranscriptStats,
    last_error: Option<String>,
) -> AgentUsageProviderSummary {
    AgentUsageProviderSummary {
        agent: agent.to_string(),
        label: label.to_string(),
        capability: capability.to_string(),
        source: source.to_string(),
        total_tokens: compute_total_tokens(&stats.model_usage),
        total_sessions: stats.total_sessions,
        total_messages: stats.total_messages,
        active_days: active_day_count(stats),
        favorite_model: compute_favorite_model(&stats.model_usage),
        last_error,
    }
}

fn build_empty_provider_summary(
    agent: &str,
    label: &str,
    capability: &str,
    source: &str,
    last_error: Option<String>,
) -> AgentUsageProviderSummary {
    build_provider_summary(
        agent,
        label,
        capability,
        source,
        &AggregatedTranscriptStats::default(),
        last_error,
    )
}

fn record_generic_usage_event(
    aggregate: &mut AggregatedTranscriptStats,
    sessions: &mut BTreeMap<String, UsageSessionSpan>,
    event: ParsedAgentUsageEvent,
) {
    if event.total_tokens == 0 {
        return;
    }

    let date_key = local_date_string(&event.timestamp);
    let activity =
        aggregate
            .daily_activity
            .entry(date_key.clone())
            .or_insert(AgentUsageDailyActivity {
                date: date_key.clone(),
                message_count: 0,
                session_count: 0,
            });
    activity.message_count += 1;
    aggregate.total_messages += 1;

    // Codex and OpenCode expose provider-normalized totals; keep them in the
    // aggregate total bucket so cached-input subsets are not double-counted.
    aggregate
        .model_usage
        .entry(event.model.clone())
        .or_default()
        .input_tokens += event.total_tokens;
    aggregate.token_breakdown.merge(event.token_breakdown);

    let day_tokens = aggregate.daily_model_tokens.entry(date_key).or_default();
    *day_tokens.entry(event.model).or_insert(0) += event.total_tokens;

    sessions
        .entry(event.session_id)
        .and_modify(|span| span.update(event.timestamp))
        .or_insert_with(|| UsageSessionSpan::new(event.timestamp));
}

fn finalize_generic_sessions(
    aggregate: &mut AggregatedTranscriptStats,
    sessions: BTreeMap<String, UsageSessionSpan>,
) {
    for span in sessions.into_values() {
        let date_key = local_date_string(&span.first_timestamp);
        let activity =
            aggregate
                .daily_activity
                .entry(date_key.clone())
                .or_insert(AgentUsageDailyActivity {
                    date: date_key.clone(),
                    message_count: 0,
                    session_count: 0,
                });
        activity.session_count += 1;

        let duration_ms = (span.last_timestamp.timestamp_millis()
            - span.first_timestamp.timestamp_millis())
        .max(0) as u64;
        aggregate.total_sessions += 1;
        aggregate.longest_session_ms = aggregate.longest_session_ms.max(duration_ms);
        update_min_string(&mut aggregate.first_session_date, date_key);
        update_max_string(
            &mut aggregate.last_session_date,
            local_date_string(&span.last_timestamp),
        );
        let hour_key = local_hour_string(&span.first_timestamp);
        *aggregate.hour_counts.entry(hour_key).or_insert(0) += 1;
    }
}

fn cache_to_aggregate(cache: ClaudeStatsCache) -> AggregatedTranscriptStats {
    let mut aggregate = AggregatedTranscriptStats::default();

    for entry in cache.daily_activity {
        aggregate.daily_activity.insert(
            entry.date.clone(),
            AgentUsageDailyActivity {
                date: entry.date,
                message_count: entry.message_count.unwrap_or(0),
                session_count: entry.session_count.unwrap_or(0),
            },
        );
    }

    for entry in cache.daily_model_tokens {
        aggregate
            .daily_model_tokens
            .insert(entry.date, entry.tokens_by_model);
    }

    aggregate.model_usage = cache.model_usage;
    for usage in aggregate.model_usage.values() {
        aggregate.token_breakdown.add_model_usage(usage);
    }
    aggregate.total_sessions = cache.total_sessions.unwrap_or(0);
    aggregate.total_messages = cache.total_messages.unwrap_or(0);
    aggregate.longest_session_ms = cache
        .longest_session
        .map(|entry| entry.duration)
        .unwrap_or(0);
    aggregate.first_session_date = cache.first_session_date.or_else(|| {
        aggregate
            .daily_activity
            .keys()
            .next()
            .map(std::string::ToString::to_string)
    });
    aggregate.last_session_date = cache.last_session_date.or_else(|| {
        aggregate
            .daily_activity
            .keys()
            .next_back()
            .map(std::string::ToString::to_string)
    });
    aggregate.hour_counts = cache.hour_counts;

    aggregate
}

fn is_transcript_message(entry: &Value) -> bool {
    matches!(
        entry.get("type").and_then(Value::as_str),
        Some("assistant" | "user" | "system" | "attachment")
    )
}

fn get_message_usage(entry: &Value) -> Option<(String, ClaudeStatsModelUsage)> {
    let message = entry.get("message")?;
    let usage = message.get("usage")?;
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .unwrap_or("unknown");

    if model == "<synthetic>" {
        return None;
    }

    Some((
        model.to_string(),
        ClaudeStatsModelUsage {
            input_tokens: usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            output_tokens: usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_read_input_tokens: usage
                .get("cache_read_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_creation_input_tokens: usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        },
    ))
}

fn get_message_dedupe_key(entry: &Value) -> Option<String> {
    let message_id = entry
        .get("message")?
        .get("id")?
        .as_str()
        .filter(|value| !value.is_empty())?;
    let request_id = entry
        .get("requestId")
        .or_else(|| entry.get("request_id"))?
        .as_str()
        .filter(|value| !value.is_empty())?;

    Some(format!("{message_id}:{request_id}"))
}

fn process_session_files(
    files: &[PathBuf],
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> AggregatedTranscriptStats {
    let mut aggregate = AggregatedTranscriptStats::default();

    for path in files {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        let reader = BufReader::new(file);
        let mut messages = Vec::new();

        for line in reader.lines() {
            let Ok(line) = line else {
                continue;
            };
            let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if is_transcript_message(&entry) {
                messages.push(entry);
            }
        }

        if messages.is_empty() {
            continue;
        }

        let is_subagent_file = is_subagent_session_file(path);
        let main_messages = messages
            .iter()
            .filter(|entry| {
                is_subagent_file
                    || !entry
                        .get("isSidechain")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            })
            .collect::<Vec<_>>();

        if main_messages.is_empty() {
            continue;
        }

        let Some(first_timestamp_raw) = main_messages
            .first()
            .and_then(|entry| entry.get("timestamp"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(last_timestamp_raw) = main_messages
            .last()
            .and_then(|entry| entry.get("timestamp"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(first_timestamp) = parse_timestamp_utc(first_timestamp_raw) else {
            continue;
        };
        let Some(last_timestamp) = parse_timestamp_utc(last_timestamp_raw) else {
            continue;
        };

        let date_key = local_date_string(&first_timestamp);
        if from_date.is_some_and(|value| date_key.as_str() < value) {
            continue;
        }
        if to_date.is_some_and(|value| date_key.as_str() > value) {
            continue;
        }

        if !is_subagent_file {
            let duration_ms = (last_timestamp.timestamp_millis()
                - first_timestamp.timestamp_millis())
            .max(0) as u64;
            let message_count = main_messages.len() as u64;

            let activity = aggregate.daily_activity.entry(date_key.clone()).or_insert(
                AgentUsageDailyActivity {
                    date: date_key.clone(),
                    message_count: 0,
                    session_count: 0,
                },
            );
            activity.message_count += message_count;
            activity.session_count += 1;

            aggregate.total_sessions += 1;
            aggregate.total_messages += message_count;
            aggregate.longest_session_ms = aggregate.longest_session_ms.max(duration_ms);
            update_min_string(&mut aggregate.first_session_date, date_key.clone());
            update_max_string(
                &mut aggregate.last_session_date,
                local_date_string(&last_timestamp),
            );

            let hour_key = local_hour_string(&first_timestamp);
            *aggregate.hour_counts.entry(hour_key).or_insert(0) += 1;
        }

        let mut assistant_usages: Vec<(String, ClaudeStatsModelUsage)> = Vec::new();
        let mut dedupe_index_by_key = BTreeMap::<String, usize>::new();

        for message in main_messages {
            if message.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let Some((model, usage)) = get_message_usage(message) else {
                continue;
            };

            if usage.total_tokens() == 0 {
                continue;
            }

            if let Some(dedupe_key) = get_message_dedupe_key(message) {
                if let Some(existing_index) = dedupe_index_by_key.get(&dedupe_key).copied() {
                    assistant_usages[existing_index].1.merge_max(&usage);
                    continue;
                }
                dedupe_index_by_key.insert(dedupe_key, assistant_usages.len());
            }

            assistant_usages.push((model, usage));
        }

        for (model, usage) in assistant_usages {
            let tokens_for_display = usage.total_tokens();

            let model_totals = aggregate.model_usage.entry(model.clone()).or_default();
            model_totals.input_tokens += usage.input_tokens;
            model_totals.output_tokens += usage.output_tokens;
            model_totals.cache_read_input_tokens += usage.cache_read_input_tokens;
            model_totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            aggregate.token_breakdown.add_model_usage(&usage);

            if tokens_for_display > 0 {
                let day_tokens = aggregate
                    .daily_model_tokens
                    .entry(date_key.clone())
                    .or_default();
                *day_tokens.entry(model).or_insert(0) += tokens_for_display;
            }
        }
    }

    aggregate
}

#[derive(Debug, Clone, Copy, Default)]
struct RawTokenUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
}

#[derive(Debug, Clone, Copy)]
enum TokenDeltaResolution {
    Event {
        delta: RawTokenUsage,
        next_totals: Option<RawTokenUsage>,
    },
    Baseline {
        next_totals: RawTokenUsage,
    },
}

#[derive(Debug, Clone)]
struct CodexUsageParseContext {
    session_id: String,
    session_cwd: Option<String>,
    current_cwd: Option<String>,
    current_model: Option<String>,
    previous_totals: Option<RawTokenUsage>,
    total_only_baseline_pending: bool,
}

fn json_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .map(|value| value as u64)
            })
            .unwrap_or(0),
        Some(Value::String(value)) => value.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value as i64)
        }),
        Some(Value::String(value)) => value.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn extract_json_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_raw_token_usage(value: Option<&Value>) -> Option<RawTokenUsage> {
    let record = value?.as_object()?;
    let input_tokens = json_u64(record.get("input_tokens"));
    let cached_input_tokens = json_u64(
        record
            .get("cached_input_tokens")
            .or_else(|| record.get("cache_read_input_tokens")),
    )
    .min(input_tokens);
    let output_tokens = json_u64(record.get("output_tokens"));
    let reasoning_output_tokens = json_u64(record.get("reasoning_output_tokens"));
    let total_tokens = json_u64(record.get("total_tokens"));

    Some(RawTokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        // Cached input and reasoning output are detail fields for input/output,
        // not extra tokens to add on top of the provider total.
        total_tokens: if total_tokens > 0 {
            total_tokens
        } else {
            input_tokens + output_tokens
        },
    })
}

fn subtract_raw_token_usage(
    current: RawTokenUsage,
    previous: Option<RawTokenUsage>,
) -> RawTokenUsage {
    RawTokenUsage {
        input_tokens: current
            .input_tokens
            .saturating_sub(previous.map(|value| value.input_tokens).unwrap_or(0)),
        cached_input_tokens: current
            .cached_input_tokens
            .saturating_sub(previous.map(|value| value.cached_input_tokens).unwrap_or(0)),
        output_tokens: current
            .output_tokens
            .saturating_sub(previous.map(|value| value.output_tokens).unwrap_or(0)),
        reasoning_output_tokens: current.reasoning_output_tokens.saturating_sub(
            previous
                .map(|value| value.reasoning_output_tokens)
                .unwrap_or(0),
        ),
        total_tokens: current
            .total_tokens
            .saturating_sub(previous.map(|value| value.total_tokens).unwrap_or(0)),
    }
}

fn add_raw_token_usage(left: RawTokenUsage, right: RawTokenUsage) -> RawTokenUsage {
    RawTokenUsage {
        input_tokens: left.input_tokens + right.input_tokens,
        cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
        output_tokens: left.output_tokens + right.output_tokens,
        reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
        total_tokens: left.total_tokens + right.total_tokens,
    }
}

fn raw_token_usage_equals(left: RawTokenUsage, right: RawTokenUsage) -> bool {
    left.input_tokens == right.input_tokens
        && left.cached_input_tokens == right.cached_input_tokens
        && left.output_tokens == right.output_tokens
        && left.reasoning_output_tokens == right.reasoning_output_tokens
}

fn raw_token_usage_is_monotonic(current: RawTokenUsage, previous: RawTokenUsage) -> bool {
    current.input_tokens >= previous.input_tokens
        && current.cached_input_tokens >= previous.cached_input_tokens
        && current.output_tokens >= previous.output_tokens
        && current.reasoning_output_tokens >= previous.reasoning_output_tokens
}

fn raw_token_usage_magnitude(usage: RawTokenUsage) -> u64 {
    usage.input_tokens
        + usage.cached_input_tokens
        + usage.output_tokens
        + usage.reasoning_output_tokens
}

fn looks_like_stale_regression(
    current: RawTokenUsage,
    previous: RawTokenUsage,
    last: RawTokenUsage,
) -> bool {
    let previous_total = raw_token_usage_magnitude(previous);
    let current_total = raw_token_usage_magnitude(current);
    let last_total = raw_token_usage_magnitude(last);
    if previous_total == 0 || current_total == 0 || last_total == 0 {
        return false;
    }
    current_total * 100 >= previous_total * 98 || current_total + last_total * 2 >= previous_total
}

fn resolve_usage_delta(
    total_usage: Option<RawTokenUsage>,
    last_usage: Option<RawTokenUsage>,
    previous_totals: Option<RawTokenUsage>,
) -> Option<TokenDeltaResolution> {
    match (total_usage, last_usage, previous_totals) {
        (Some(total), Some(last), Some(previous)) => {
            if raw_token_usage_equals(total, previous) {
                return None;
            }
            if !raw_token_usage_is_monotonic(total, previous)
                && looks_like_stale_regression(total, previous, last)
            {
                return None;
            }
            Some(TokenDeltaResolution::Event {
                delta: last,
                next_totals: Some(total),
            })
        }
        (Some(total), Some(last), None) => Some(TokenDeltaResolution::Event {
            delta: last,
            next_totals: Some(total),
        }),
        (Some(total), None, Some(previous)) => {
            if raw_token_usage_equals(total, previous) {
                return None;
            }
            if !raw_token_usage_is_monotonic(total, previous) {
                return Some(TokenDeltaResolution::Baseline { next_totals: total });
            }
            Some(TokenDeltaResolution::Event {
                delta: subtract_raw_token_usage(total, Some(previous)),
                next_totals: Some(total),
            })
        }
        (Some(total), None, None) => Some(TokenDeltaResolution::Event {
            delta: total,
            next_totals: Some(total),
        }),
        (None, Some(last), Some(previous)) => Some(TokenDeltaResolution::Event {
            delta: last,
            next_totals: Some(add_raw_token_usage(previous, last)),
        }),
        (None, Some(last), None) => Some(TokenDeltaResolution::Event {
            delta: last,
            next_totals: None,
        }),
        (None, None, _) => None,
    }
}

fn extract_codex_model(value: Option<&Value>) -> Option<String> {
    let record = value?.as_object()?;
    let direct = extract_json_string(record.get("model"))
        .or_else(|| extract_json_string(record.get("model_name")));
    if direct.is_some() {
        return direct;
    }

    if let Some(info) = record.get("info").and_then(Value::as_object) {
        let info_direct = extract_json_string(info.get("model"))
            .or_else(|| extract_json_string(info.get("model_name")));
        if info_direct.is_some() {
            return info_direct;
        }
        if let Some(metadata) = info.get("metadata").and_then(Value::as_object) {
            if let Some(model) = extract_json_string(metadata.get("model")) {
                return Some(model);
            }
        }
    }

    record
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| extract_json_string(metadata.get("model")))
}

fn parse_codex_usage_record(
    line: &str,
    context: &mut CodexUsageParseContext,
) -> Option<ParsedAgentUsageEvent> {
    let parsed = serde_json::from_str::<Value>(line).ok()?;
    let record_type = parsed.get("type").and_then(Value::as_str)?;
    let payload = parsed.get("payload")?;

    if record_type == "session_meta" {
        if let Some(session_id) = extract_json_string(payload.get("id")) {
            context.session_id = session_id;
        }
        context.session_cwd = extract_json_string(payload.get("cwd"));
        if context.current_cwd.is_none() {
            context.current_cwd = context.session_cwd.clone();
        }
        return None;
    }

    if record_type == "turn_context" {
        context.current_cwd = extract_json_string(payload.get("cwd"))
            .or_else(|| context.current_cwd.clone())
            .or_else(|| context.session_cwd.clone());
        context.current_model =
            extract_codex_model(Some(payload)).or_else(|| context.current_model.clone());
        return None;
    }

    if record_type != "event_msg"
        || payload.get("type").and_then(Value::as_str) != Some("token_count")
    {
        return None;
    }

    let timestamp_raw = parsed.get("timestamp").and_then(Value::as_str)?;
    let info = payload.get("info")?;
    if !info.is_object() {
        return None;
    }

    let total_usage = normalize_raw_token_usage(info.get("total_token_usage"));
    let last_usage = normalize_raw_token_usage(info.get("last_token_usage"));
    if context.total_only_baseline_pending {
        context.total_only_baseline_pending = false;
        if total_usage.is_some() && last_usage.is_none() && context.previous_totals.is_none() {
            context.previous_totals = total_usage;
            return None;
        }
    }

    let resolved = resolve_usage_delta(total_usage, last_usage, context.previous_totals)?;
    let delta = match resolved {
        TokenDeltaResolution::Baseline { next_totals } => {
            context.previous_totals = Some(next_totals);
            return None;
        }
        TokenDeltaResolution::Event { delta, next_totals } => {
            if delta.input_tokens == 0
                && delta.cached_input_tokens == 0
                && delta.output_tokens == 0
                && delta.reasoning_output_tokens == 0
                && delta.total_tokens == 0
            {
                return None;
            }
            context.previous_totals = next_totals;
            delta
        }
    };

    let total_tokens = delta.total_tokens;
    let timestamp = parse_timestamp_utc(timestamp_raw)?;
    let model = extract_codex_model(Some(payload))
        .or_else(|| context.current_model.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let mut token_breakdown = AgentUsageTokenBreakdown::default();
    token_breakdown.add_codex_usage(delta, total_tokens);

    Some(ParsedAgentUsageEvent {
        session_id: context.session_id.clone(),
        timestamp,
        model,
        total_tokens,
        token_breakdown,
    })
}

pub(crate) fn build_codex_usage_session_stats(
    path: &Path,
    cleared_at_ms: Option<i64>,
) -> Result<AggregatedTranscriptStats, String> {
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::<String, UsageSessionSpan>::new();

    let file = fs::File::open(path).map_err(|error| format!("无法读取 Codex 用量日志: {error}"))?;
    let session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut context = CodexUsageParseContext {
        session_id,
        session_cwd: None,
        current_cwd: None,
        current_model: None,
        previous_totals: None,
        total_only_baseline_pending: false,
    };

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| format!("读取 Codex 用量日志失败: {error}"))?;
        if let Some(event) = parse_codex_usage_record(&line, &mut context) {
            if cleared_at_ms.is_some_and(|cutoff| event.timestamp.timestamp_millis() <= cutoff) {
                continue;
            }
            record_generic_usage_event(&mut aggregate, &mut sessions, event);
        }
    }

    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

#[derive(Debug, Clone)]
struct OpenCodeUsageRow {
    id: String,
    session_id: String,
    time_created: Option<i64>,
    time_updated: Option<i64>,
    session_model: Option<String>,
    data: String,
}

fn opencode_data_home() -> PathBuf {
    if let Some(value) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(value);
    }
    if cfg!(windows) {
        if let Some(value) = env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
            return PathBuf::from(value);
        }
        if let Some(value) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            return PathBuf::from(value);
        }
        if let Some(home_dir) = dirs_next::home_dir() {
            return home_dir.join("AppData").join("Local");
        }
    }
    dirs_next::home_dir()
        .map(|home_dir| home_dir.join(".local").join("share"))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn opencode_data_dir() -> PathBuf {
    opencode_data_home().join("opencode")
}

fn collect_opencode_database_paths() -> Vec<PathBuf> {
    if let Some(raw_path) = env::var_os("OPENCODE_DB").filter(|value| !value.is_empty()) {
        if raw_path == ":memory:" {
            return Vec::new();
        }
        let path = PathBuf::from(raw_path);
        let resolved = if path.is_absolute() {
            path
        } else {
            opencode_data_dir().join(path)
        };
        return resolved.exists().then_some(resolved).into_iter().collect();
    }

    let Ok(entries) = fs::read_dir(opencode_data_dir()) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let is_database =
                name == "opencode.db" || (name.starts_with("opencode-") && name.ends_with(".db"));
            (entry.file_type().ok()?.is_file() && is_database).then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn sqlite_table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            [table],
            |_| Ok(()),
        )
        .is_ok()
}

fn sqlite_column_exists(connection: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut statement) = connection.prepare(&sql) else {
        return false;
    };
    let Ok(mut rows) = statement.query([]) else {
        return false;
    };
    while let Ok(Some(row)) = rows.next() {
        let Ok(name) = row.get::<_, String>(1) else {
            continue;
        };
        if name == column {
            return true;
        }
    }
    false
}

fn sqlite_select_column(connection: &Connection, table: &str, alias: &str, column: &str) -> String {
    if sqlite_column_exists(connection, table, column) {
        format!("{alias}.{column} AS {column}")
    } else {
        format!("NULL AS {column}")
    }
}

fn opencode_project_join(connection: &Connection) -> &'static str {
    if sqlite_table_exists(connection, "project")
        && sqlite_column_exists(connection, "session", "project_id")
    {
        "LEFT JOIN project p ON p.id = s.project_id"
    } else {
        "LEFT JOIN (SELECT NULL AS worktree) p ON 1 = 0"
    }
}

fn opencode_session_model_select(connection: &Connection) -> &'static str {
    if sqlite_column_exists(connection, "session", "model") {
        "s.model AS session_model"
    } else {
        "NULL AS session_model"
    }
}

fn row_optional_string(row: &rusqlite::Row<'_>, column: &str) -> Option<String> {
    row.get::<_, Option<String>>(column).ok().flatten()
}

fn row_optional_i64(row: &rusqlite::Row<'_>, column: &str) -> Option<i64> {
    row.get::<_, Option<i64>>(column).ok().flatten()
}

fn row_u64(row: &rusqlite::Row<'_>, column: &str) -> u64 {
    row.get::<_, Option<i64>>(column)
        .ok()
        .flatten()
        .filter(|value| *value > 0)
        .map(|value| value as u64)
        .unwrap_or(0)
}

fn row_f64(row: &rusqlite::Row<'_>, column: &str) -> f64 {
    row.get::<_, Option<f64>>(column)
        .ok()
        .flatten()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

fn map_opencode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpenCodeUsageRow> {
    Ok(OpenCodeUsageRow {
        id: row_optional_string(row, "id").unwrap_or_else(|| "unknown".to_string()),
        session_id: row_optional_string(row, "session_id").unwrap_or_else(|| "unknown".to_string()),
        time_created: row_optional_i64(row, "time_created"),
        time_updated: row_optional_i64(row, "time_updated"),
        session_model: row_optional_string(row, "session_model"),
        data: row_optional_string(row, "data").unwrap_or_else(|| "{}".to_string()),
    })
}

fn can_read_opencode_session_usage_rows(connection: &Connection) -> bool {
    sqlite_table_exists(connection, "session")
        && [
            "cost",
            "tokens_input",
            "tokens_output",
            "tokens_reasoning",
            "tokens_cache_read",
        ]
        .iter()
        .all(|column| sqlite_column_exists(connection, "session", column))
}

fn opencode_session_usage_row_count(connection: &Connection) -> u64 {
    if !can_read_opencode_session_usage_rows(connection) {
        return 0;
    }
    connection
        .query_row(
            "SELECT COUNT(*) FROM session
             WHERE COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)
                   + COALESCE(tokens_reasoning, 0) + COALESCE(tokens_cache_read, 0) > 0",
            [],
            |row| row.get::<_, u64>(0),
        )
        .unwrap_or(0)
}

fn select_opencode_session_usage_rows(
    connection: &Connection,
) -> Result<Vec<OpenCodeUsageRow>, String> {
    let project_join = opencode_project_join(connection);
    let session_model_select = opencode_session_model_select(connection);
    let time_created_select = sqlite_select_column(connection, "session", "s", "time_created");
    let time_updated_select = sqlite_select_column(connection, "session", "s", "time_updated");
    let directory_select = sqlite_select_column(connection, "session", "s", "directory");
    let order_by = if sqlite_column_exists(connection, "session", "time_created") {
        "s.time_created"
    } else {
        "s.id"
    };
    let sql = format!(
        "SELECT s.id AS id, s.id AS session_id, {time_created_select}, {time_updated_select},
                {directory_select}, p.worktree AS worktree, {session_model_select},
                s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read
         FROM session s
         {project_join}
         WHERE COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0)
               + COALESCE(s.tokens_reasoning, 0) + COALESCE(s.tokens_cache_read, 0) > 0
         ORDER BY {order_by}, s.id"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("读取 OpenCode session 统计失败: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let input_tokens = row_u64(row, "tokens_input");
            let output_tokens = row_u64(row, "tokens_output");
            let reasoning_tokens = row_u64(row, "tokens_reasoning");
            let cache_read_tokens = row_u64(row, "tokens_cache_read");
            Ok(OpenCodeUsageRow {
                id: row_optional_string(row, "id").unwrap_or_else(|| "unknown".to_string()),
                session_id: row_optional_string(row, "session_id")
                    .unwrap_or_else(|| "unknown".to_string()),
                time_created: row_optional_i64(row, "time_created"),
                time_updated: row_optional_i64(row, "time_updated"),
                session_model: row_optional_string(row, "session_model"),
                data: json!({
                    "cost": row_f64(row, "cost"),
                    "tokens": {
                        "input": input_tokens,
                        "output": output_tokens,
                        "reasoning": reasoning_tokens,
                        "total": input_tokens + output_tokens + reasoning_tokens,
                        "cache": {
                            "read": cache_read_tokens,
                            "write": 0
                        }
                    }
                })
                .to_string(),
            })
        })
        .map_err(|error| format!("读取 OpenCode session 统计失败: {error}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn opencode_table_has_rows(connection: &Connection, table: &str) -> bool {
    if !sqlite_table_exists(connection, table) {
        return false;
    }
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE data IS NOT NULL");
    connection
        .query_row(&sql, [], |row| row.get::<_, u64>(0))
        .unwrap_or(0)
        > 0
}

fn select_opencode_message_rows(
    connection: &Connection,
    table: &str,
    alias: &str,
) -> Result<Vec<OpenCodeUsageRow>, String> {
    let project_join = opencode_project_join(connection);
    let session_model_select = opencode_session_model_select(connection);
    let time_created_select = sqlite_select_column(connection, table, alias, "time_created");
    let time_updated_select = sqlite_select_column(connection, table, alias, "time_updated");
    let directory_select = sqlite_select_column(connection, "session", "s", "directory");
    let assistant_predicate = if sqlite_column_exists(connection, table, "type") {
        format!("{alias}.type = 'assistant'")
    } else {
        format!("{alias}.data IS NOT NULL")
    };
    let order_by = if sqlite_column_exists(connection, table, "time_created") {
        format!("{alias}.time_created")
    } else {
        format!("{alias}.id")
    };
    let sql = format!(
        "SELECT {alias}.id AS id, {alias}.session_id AS session_id,
                {time_created_select}, {time_updated_select}, {alias}.data AS data,
                {directory_select}, p.worktree AS worktree, {session_model_select}
         FROM {table} {alias}
         JOIN session s ON s.id = {alias}.session_id
         {project_join}
         WHERE {assistant_predicate}
         ORDER BY {order_by}, {alias}.id"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("读取 OpenCode message 统计失败: {error}"))?;
    let rows = statement
        .query_map([], map_opencode_row)
        .map_err(|error| format!("读取 OpenCode message 统计失败: {error}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn select_opencode_usage_rows(connection: &Connection) -> Result<Vec<OpenCodeUsageRow>, String> {
    if !sqlite_table_exists(connection, "session") {
        return Ok(Vec::new());
    }
    if opencode_session_usage_row_count(connection) > 0 {
        return select_opencode_session_usage_rows(connection);
    }
    if opencode_table_has_rows(connection, "session_message") {
        return select_opencode_message_rows(connection, "session_message", "sm");
    }
    if opencode_table_has_rows(connection, "message") {
        return select_opencode_message_rows(connection, "message", "m");
    }
    Ok(Vec::new())
}

fn parse_json_object(value: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn extract_model_label_from_object(record: &serde_json::Map<String, Value>) -> Option<String> {
    let model_id = extract_json_string(record.get("modelID"))
        .or_else(|| extract_json_string(record.get("modelId")))
        .or_else(|| extract_json_string(record.get("id")));
    let provider_id = extract_json_string(record.get("providerID"))
        .or_else(|| extract_json_string(record.get("providerId")));
    model_id.map(|model| match provider_id {
        Some(provider) => format!("{provider}/{model}"),
        None => model,
    })
}

fn extract_opencode_model(data: &Value, session_model: Option<&str>) -> Option<String> {
    let data_object = data.as_object()?;
    if let Some(model) = extract_model_label_from_object(data_object) {
        return Some(model);
    }
    if let Some(model_object) = parse_json_object(data_object.get("model")) {
        if let Some(model) = extract_model_label_from_object(model_object) {
            return Some(model);
        }
    }
    if let Some(model_raw) = data_object.get("model").and_then(Value::as_str) {
        if let Ok(parsed) = serde_json::from_str::<Value>(model_raw) {
            if let Some(model_object) = parsed.as_object() {
                if let Some(model) = extract_model_label_from_object(model_object) {
                    return Some(model);
                }
            }
        }
    }
    let session_model = session_model?.trim();
    if session_model.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(session_model) {
        if let Some(model_object) = parsed.as_object() {
            return extract_model_label_from_object(model_object);
        }
    }
    Some(session_model.to_string())
}

fn normalize_millis(value: Option<i64>) -> Option<i64> {
    let value = value?;
    if value <= 0 {
        return None;
    }
    Some(if value < 10_000_000_000 {
        value * 1000
    } else {
        value
    })
}

fn extract_opencode_timestamp(data: &Value, row: &OpenCodeUsageRow) -> Option<DateTime<Utc>> {
    let time_data = data.get("time").and_then(Value::as_object);
    let millis = normalize_millis(time_data.and_then(|time| json_i64(time.get("completed"))))
        .or_else(|| normalize_millis(time_data.and_then(|time| json_i64(time.get("created")))))
        .or_else(|| normalize_millis(row.time_updated))
        .or_else(|| normalize_millis(row.time_created))?;
    Utc.timestamp_millis_opt(millis).single()
}

fn parse_opencode_usage_row(row: OpenCodeUsageRow) -> Option<ParsedAgentUsageEvent> {
    let data = serde_json::from_str::<Value>(&row.data).ok()?;
    let tokens = data.get("tokens")?.as_object()?;
    let cache = tokens.get("cache").and_then(Value::as_object);
    let input_tokens = json_u64(tokens.get("input"));
    let output_tokens = json_u64(tokens.get("output"));
    let reasoning_tokens = json_u64(tokens.get("reasoning"));
    let cached_input_tokens = json_u64(cache.and_then(|cache| cache.get("read")));
    let explicit_total = json_u64(tokens.get("total"));
    let categorized_total = input_tokens + output_tokens + reasoning_tokens + cached_input_tokens;
    let total_tokens = explicit_total.max(categorized_total);

    if input_tokens + output_tokens + reasoning_tokens + cached_input_tokens + total_tokens == 0 {
        return None;
    }

    let timestamp = extract_opencode_timestamp(&data, &row)?;
    let raw_usage = RawTokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens: reasoning_tokens,
        total_tokens,
    };
    let mut token_breakdown = AgentUsageTokenBreakdown::default();
    token_breakdown.add_opencode_usage(raw_usage, total_tokens);

    Some(ParsedAgentUsageEvent {
        session_id: if row.session_id == "unknown" {
            row.id
        } else {
            row.session_id
        },
        timestamp,
        model: extract_opencode_model(&data, row.session_model.as_deref())
            .unwrap_or_else(|| "unknown".to_string()),
        total_tokens,
        token_breakdown,
    })
}

fn build_opencode_usage_stats() -> Result<AggregatedTranscriptStats, String> {
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::<String, UsageSessionSpan>::new();

    for db_path in collect_opencode_database_paths() {
        let connection = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| {
                format!(
                    "打开 OpenCode 数据库失败 {}: {error}",
                    display_path(&db_path)
                )
            })?;
        for row in select_opencode_usage_rows(&connection)? {
            if let Some(event) = parse_opencode_usage_row(row) {
                record_generic_usage_event(&mut aggregate, &mut sessions, event);
            }
        }
    }

    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

fn parse_ymd_prefix(input: &str) -> Option<(i32, u32, u32)> {
    let date = input.get(0..10)?;
    let year = date.get(0..4)?.parse::<i32>().ok()?;
    let month = date.get(5..7)?.parse::<u32>().ok()?;
    let day = date.get(8..10)?.parse::<u32>().ok()?;
    Some((year, month, day))
}

fn civil_to_days(year: i32, month: u32, day: u32) -> i64 {
    let mut year = year as i64;
    let month = month as i64;
    let day = day as i64;

    year -= if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn day_ordinal(input: &str) -> Option<i64> {
    let (year, month, day) = parse_ymd_prefix(input)?;
    Some(civil_to_days(year, month, day))
}

fn compute_streaks(activity_dates: &[String]) -> (u32, u32) {
    let mut ordinals = activity_dates
        .iter()
        .filter_map(|date| day_ordinal(date))
        .collect::<Vec<_>>();
    ordinals.sort_unstable();
    ordinals.dedup();

    if ordinals.is_empty() {
        return (0, 0);
    }

    let mut longest_streak = 1_u32;
    let mut current_run = 1_u32;
    for pair in ordinals.windows(2) {
        if pair[1] - pair[0] == 1 {
            current_run += 1;
        } else {
            longest_streak = longest_streak.max(current_run);
            current_run = 1;
        }
    }
    longest_streak = longest_streak.max(current_run);

    let Some(today_ordinal) = day_ordinal(&today_local_date_string()) else {
        return (0, longest_streak);
    };

    let mut current_streak = 0_u32;
    let mut expected = today_ordinal;
    for ordinal in ordinals.iter().rev() {
        if *ordinal == expected {
            current_streak += 1;
            expected -= 1;
        } else {
            if *ordinal < expected {
                break;
            }
        }
    }

    (current_streak, longest_streak)
}

fn compute_total_days(first_session_date: Option<&str>, last_session_date: Option<&str>) -> u32 {
    let Some(first) = first_session_date.and_then(day_ordinal) else {
        return 0;
    };
    let Some(last) = last_session_date.and_then(day_ordinal) else {
        return 0;
    };
    if last < first {
        return 0;
    }
    (last - first + 1) as u32
}

fn compute_total_tokens(usage_by_model: &BTreeMap<String, ClaudeStatsModelUsage>) -> u64 {
    usage_by_model
        .values()
        .map(ClaudeStatsModelUsage::total_tokens)
        .sum()
}

fn compute_favorite_model(
    usage_by_model: &BTreeMap<String, ClaudeStatsModelUsage>,
) -> Option<String> {
    usage_by_model
        .iter()
        .max_by_key(|(_, usage)| usage.total_tokens())
        .map(|(model, _)| model.clone())
}

fn compute_peak_hour(hour_counts: &BTreeMap<String, u64>) -> Option<u8> {
    hour_counts
        .iter()
        .filter_map(|(hour, count)| hour.parse::<u8>().ok().map(|parsed| (parsed, *count)))
        .max_by_key(|(_, count)| *count)
        .map(|(hour, _)| hour)
}

fn build_claude_usage_stats() -> Result<AggregatedTranscriptStats, String> {
    let cached_stats = load_claude_stats_cache()?;
    let incremental_from_date = cached_stats
        .as_ref()
        .and_then(|cache| cache.last_computed_date.as_deref())
        .and_then(next_date_string);
    let session_files = collect_claude_session_files()?;
    let incremental_stats =
        process_session_files(&session_files, incremental_from_date.as_deref(), None);

    let mut merged_stats = cached_stats.map(cache_to_aggregate).unwrap_or_default();
    merge_aggregated_stats(&mut merged_stats, incremental_stats);

    Ok(merged_stats)
}

fn build_usage_overview_from_aggregate(
    merged_stats: AggregatedTranscriptStats,
    providers: Vec<AgentUsageProviderSummary>,
) -> AgentUsageOverview {
    let peak_daily_tokens = merged_stats
        .daily_model_tokens
        .values()
        .map(|tokens_by_model| tokens_by_model.values().copied().sum())
        .max()
        .unwrap_or(0);
    let activity_dates = merged_stats
        .daily_activity
        .values()
        .filter(|entry| entry.message_count > 0 || entry.session_count > 0)
        .map(|entry| entry.date.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let (current_streak_days, longest_streak_days) = compute_streaks(&activity_dates);
    let effective_last_computed_date = Some(today_local_date_string());
    let total_tokens = compute_total_tokens(&merged_stats.model_usage);
    let mut token_breakdown = merged_stats.token_breakdown;
    if token_breakdown.total_tokens == 0 && total_tokens > 0 {
        token_breakdown.add_total_as_other(total_tokens);
    }
    let summary = AgentUsageOverviewSummary {
        total_tokens,
        total_messages: merged_stats.total_messages,
        peak_daily_tokens,
        longest_session_ms: merged_stats.longest_session_ms,
        current_streak_days,
        longest_streak_days,
        total_sessions: merged_stats.total_sessions,
        active_days: activity_dates.len() as u32,
        total_days: compute_total_days(
            merged_stats.first_session_date.as_deref(),
            merged_stats.last_session_date.as_deref(),
        ),
        favorite_model: compute_favorite_model(&merged_stats.model_usage),
        peak_hour: compute_peak_hour(&merged_stats.hour_counts),
    };

    let daily_activity = merged_stats
        .daily_activity
        .into_values()
        .collect::<Vec<_>>();
    let daily_model_tokens = merged_stats
        .daily_model_tokens
        .into_iter()
        .map(|(date, tokens_by_model)| AgentUsageDailyModelTokens {
            date,
            tokens_by_model,
        })
        .collect::<Vec<_>>();
    // 计算每天的总 token 数（从 daily_model_tokens 汇总）
    let daily_token_totals: std::collections::HashMap<String, u64> = daily_model_tokens
        .iter()
        .map(|entry| {
            let total = entry.tokens_by_model.values().sum();
            (entry.date.clone(), total)
        })
        .collect();

    let heatmap = daily_activity
        .iter()
        .map(|entry| AgentUsageHeatmapDay {
            date: entry.date.clone(),
            token_count: daily_token_totals.get(&entry.date).copied().unwrap_or(0),
        })
        .collect::<Vec<_>>();

    AgentUsageOverview {
        last_computed_date: effective_last_computed_date,
        summary,
        token_breakdown,
        heatmap,
        daily_activity,
        daily_model_tokens,
        providers,
    }
}

fn build_claude_usage_overview() -> Result<AgentUsageOverview, String> {
    let stats = build_claude_usage_stats()?;
    let providers = vec![build_provider_summary(
        "claude",
        "Claude",
        "full",
        "~/.claude/stats-cache.json + ~/.claude/projects/**/*.jsonl",
        &stats,
        None,
    )];
    Ok(build_usage_overview_from_aggregate(stats, providers))
}

pub(crate) fn build_agent_usage_overview(
    codex_usage: Result<AggregatedTranscriptStats, String>,
) -> AgentUsageOverview {
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut providers = Vec::new();

    match build_claude_usage_stats() {
        Ok(stats) => {
            providers.push(build_provider_summary(
                "claude",
                "Claude",
                "full",
                "~/.claude/stats-cache.json + ~/.claude/projects/**/*.jsonl",
                &stats,
                None,
            ));
            merge_aggregated_stats(&mut aggregate, stats);
        }
        Err(error) => providers.push(build_empty_provider_summary(
            "claude",
            "Claude",
            "full",
            "~/.claude/stats-cache.json + ~/.claude/projects/**/*.jsonl",
            Some(error),
        )),
    }

    match codex_usage {
        Ok(stats) => {
            providers.push(build_provider_summary(
                "codex",
                "Codex",
                "partial",
                "Codex homes: sessions/**/*.jsonl + archived_sessions/**/*.jsonl",
                &stats,
                None,
            ));
            merge_aggregated_stats(&mut aggregate, stats);
        }
        Err(error) => providers.push(build_empty_provider_summary(
            "codex",
            "Codex",
            "partial",
            "Codex homes: sessions/**/*.jsonl + archived_sessions/**/*.jsonl",
            Some(error),
        )),
    }

    match build_opencode_usage_stats() {
        Ok(stats) => {
            providers.push(build_provider_summary(
                "opencode",
                "OpenCode",
                "partial",
                "OPENCODE_DB or local opencode/opencode*.db",
                &stats,
                None,
            ));
            merge_aggregated_stats(&mut aggregate, stats);
        }
        Err(error) => providers.push(build_empty_provider_summary(
            "opencode",
            "OpenCode",
            "partial",
            "OPENCODE_DB or local opencode/opencode*.db",
            Some(error),
        )),
    }

    providers.push(build_empty_provider_summary(
        "antigravity",
        "Antigravity CLI",
        "unsupported",
        "No stable public Antigravity usage telemetry source",
        Some("Antigravity CLI 暂未提供可稳定读取的本地用量统计接口".to_string()),
    ));
    providers.push(build_empty_provider_summary(
        "qoder",
        "Qoder CLI",
        "unsupported",
        "No stable public Qoder CLI usage telemetry source",
        Some("Qoder CLI 暂未提供可稳定读取的本地用量统计接口".to_string()),
    ));

    build_usage_overview_from_aggregate(aggregate, providers)
}

fn normalize_effort_level(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "auto" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" => Some(normalized),
        _ => None,
    }
}

fn extract_effort_level(settings: &Value) -> Option<(String, &'static str)> {
    let env_level = settings
        .get("env")
        .and_then(|env| env.get("CLAUDE_CODE_EFFORT_LEVEL"))
        .and_then(Value::as_str)
        .and_then(normalize_effort_level);
    if let Some(level) = env_level {
        return Some((level, "env"));
    }

    settings
        .get("effortLevel")
        .and_then(Value::as_str)
        .and_then(normalize_effort_level)
        .map(|level| (level, "settings"))
}

fn resolve_effort_from_settings(
    config_path: &Path,
    source_prefix: &str,
) -> Result<Option<ClaudeEffortInfo>, String> {
    let settings = read_settings(config_path)?;
    let Some((level, source_kind)) = extract_effort_level(&settings) else {
        return Ok(None);
    };

    Ok(Some(ClaudeEffortInfo {
        effective_level: level.clone(),
        configured_level: Some(level),
        source: format!("{}-{}", source_prefix, source_kind),
        config_path: Some(display_path(config_path)),
    }))
}

fn resolve_claude_effort(project_path: Option<&str>) -> Result<ClaudeEffortInfo, String> {
    if let Some(level) = std::env::var("CLAUDE_CODE_EFFORT_LEVEL")
        .ok()
        .and_then(|value| normalize_effort_level(&value))
    {
        return Ok(ClaudeEffortInfo {
            effective_level: level.clone(),
            configured_level: Some(level),
            source: "process-env".to_string(),
            config_path: None,
        });
    }

    if let Some(project_path) = project_path {
        let local_path = get_local_claude_config_path(project_path);
        if let Some(info) = resolve_effort_from_settings(&local_path, "local")? {
            return Ok(info);
        }

        let workspace_path = get_scope_config_path("workspace", Some(project_path))?;
        if let Some(info) = resolve_effort_from_settings(&workspace_path, "workspace")? {
            return Ok(info);
        }
    }

    let user_path = get_user_claude_config_path()?;
    if let Some(info) = resolve_effort_from_settings(&user_path, "user")? {
        return Ok(info);
    }

    Ok(ClaudeEffortInfo {
        effective_level: "auto".to_string(),
        configured_level: None,
        source: "default".to_string(),
        config_path: None,
    })
}

fn set_effort_level_in_settings(settings: &mut Value, level: &str) {
    if !settings.is_object() {
        *settings = json!({});
    }

    if let Some(map) = settings.as_object_mut() {
        map.insert("effortLevel".to_string(), Value::String(level.to_string()));
        if let Some(env) = map.get_mut("env").and_then(Value::as_object_mut) {
            env.remove("CLAUDE_CODE_EFFORT_LEVEL");
            if env.is_empty() {
                map.remove("env");
            }
        }
    }
}

fn resolve_default_effort_target(project_path: Option<&str>) -> Result<PathBuf, String> {
    match project_path {
        Some(path) => Ok(get_local_claude_config_path(path)),
        None => get_user_claude_config_path(),
    }
}

pub(crate) fn write_settings(config_path: &Path, settings: &Value) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(settings).map_err(|e| format!("序列化配置失败: {}", e))?;
    fs::write(config_path, content).map_err(|e| format!("写入配置文件失败: {}", e))
}

fn remove_legacy_disabled_hooks_file(config_path: &Path) -> Result<(), String> {
    let Some(parent) = config_path.parent() else {
        return Ok(());
    };
    let disabled_path = parent.join("termflow-hooks-disabled.json");
    if disabled_path.exists() {
        fs::remove_file(&disabled_path)
            .map_err(|e| format!("清理旧版 Hook 停用备份失败: {}", e))?;
    }
    Ok(())
}

fn read_markdown_file(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| format!("读取 CLAUDE.md 失败: {}", e))
}

fn build_claude_md_detail(
    scope: &str,
    project_path: Option<&str>,
) -> Result<ClaudeMdDetail, String> {
    let (path, source) = resolve_claude_md_path(scope, project_path)?;
    let exists = path.exists();
    let content = read_markdown_file(&path)?;
    let directory_path = path
        .parent()
        .map(display_path)
        .unwrap_or_else(|| display_path(&path));

    Ok(ClaudeMdDetail {
        scope: scope.to_string(),
        file_path: display_path(&path),
        directory_path,
        exists,
        content,
        source,
        updated_at: if exists {
            resolve_updated_at(&path)
        } else {
            None
        },
    })
}

fn build_hook_id(scope: &str, event: &str, matcher: &str, command: &str) -> String {
    format!(
        "{}:{}:{}:{}",
        scope,
        event.to_lowercase(),
        matcher.trim(),
        command.trim()
    )
}

fn format_hook_name(event: &str, matcher: &str, position: usize) -> String {
    let event_label = match event.to_ascii_lowercase().as_str() {
        "stop" => "Stop Hook".to_string(),
        "permissionrequest" => "PermissionRequest Hook".to_string(),
        "pretooluse" => "PreToolUse Hook".to_string(),
        _ => format!("{} Hook", event),
    };

    if matcher.trim().is_empty() {
        if position <= 1 {
            event_label
        } else {
            format!("{} #{}", event_label, position)
        }
    } else {
        format!("{} · {}", event_label, matcher)
    }
}

fn command_preview(command: &str) -> String {
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let max_len = 92;
    if normalized.chars().count() <= max_len {
        normalized
    } else {
        format!(
            "{}...",
            normalized.chars().take(max_len).collect::<String>()
        )
    }
}

fn resolve_updated_at(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn collect_active_hook_records(
    scope: &str,
    config_path: &Path,
    settings: &Value,
) -> Vec<HookRecord> {
    collect_active_hook_records_for_agent("claude", scope, config_path, settings)
}

fn collect_active_hook_records_for_agent(
    agent: &str,
    scope: &str,
    config_path: &Path,
    settings: &Value,
) -> Vec<HookRecord> {
    let mut records = Vec::new();
    let Some(events) = settings.get("hooks").and_then(Value::as_object) else {
        return records;
    };

    let updated_at = resolve_updated_at(config_path);
    for (event, entries_value) in events {
        let Some(entries) = entries_value.as_array() else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let matcher = entry
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let Some(actions) = entry.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (action_index, action) in actions.iter().enumerate() {
                let command = action
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if command.is_empty() {
                    continue;
                }
                let timeout = action.get("timeout").and_then(Value::as_u64);
                let id = build_hook_id(scope, event, &matcher, &command);
                let name = format_hook_name(event, &matcher, entry_index + action_index + 1);
                let raw_config = json!({
                    "event": event,
                    "matcher": matcher,
                    "action": action,
                });
                records.push(HookRecord {
                    info: HookInfo {
                        agent: agent.to_string(),
                        id,
                        name,
                        enabled: true,
                        scope: scope.to_string(),
                        event: event.to_string(),
                        matcher: matcher.clone(),
                        command: command.clone(),
                        command_preview: command_preview(&command),
                        timeout,
                        config_path: display_path(config_path),
                        updated_at,
                    },
                    raw_config,
                });
            }
        }
    }

    records
}

fn collect_hook_records(scope: &str, config_path: &Path) -> Result<Vec<HookRecord>, String> {
    let settings = read_settings(config_path)?;
    let mut records = collect_active_hook_records(scope, config_path, &settings);
    records.sort_by(|a, b| a.info.name.to_lowercase().cmp(&b.info.name.to_lowercase()));
    Ok(records)
}

fn find_active_hook_position(
    settings: &Value,
    scope: &str,
    id: &str,
) -> Option<(String, usize, usize, StoredHookEntry)> {
    let events = settings.get("hooks")?.as_object()?;
    for (event, entries_value) in events {
        let entries = entries_value.as_array()?;
        for (entry_index, entry) in entries.iter().enumerate() {
            let matcher = entry
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let actions = entry.get("hooks")?.as_array()?;
            for (action_index, action) in actions.iter().enumerate() {
                let command = action
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if command.is_empty() {
                    continue;
                }
                let candidate_id = build_hook_id(scope, event, &matcher, &command);
                if candidate_id == id {
                    return Some((
                        event.clone(),
                        entry_index,
                        action_index,
                        StoredHookEntry {
                            event: event.clone(),
                            matcher,
                            action_type: action
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("command")
                                .to_string(),
                            command,
                            timeout: action.get("timeout").and_then(Value::as_u64),
                        },
                    ));
                }
            }
        }
    }
    None
}

fn remove_active_hook(settings: &mut Value, scope: &str, id: &str) -> Result<(), String> {
    let (event_key, entry_index, action_index, _) =
        find_active_hook_position(settings, scope, id).ok_or("未找到要删除的 Hook")?;

    let hooks_obj = settings
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .ok_or("Claude 配置中不存在 hooks 节点")?;

    let remove_event = {
        let entries = hooks_obj
            .get_mut(&event_key)
            .and_then(Value::as_array_mut)
            .ok_or("Claude Hook 结构异常")?;
        let entry = entries
            .get_mut(entry_index)
            .ok_or("Claude Hook 条目不存在")?;
        let actions = entry
            .get_mut("hooks")
            .and_then(Value::as_array_mut)
            .ok_or("Claude Hook 动作结构异常")?;
        if action_index >= actions.len() {
            return Err("Claude Hook 动作索引越界".to_string());
        }
        actions.remove(action_index);
        if actions.is_empty() {
            entries.remove(entry_index);
        }
        entries.is_empty()
    };

    if remove_event {
        hooks_obj.remove(&event_key);
    }

    Ok(())
}

fn insert_hook(settings: &mut Value, entry: &StoredHookEntry) -> Result<(), String> {
    // 修复 H-01: 原实现用 .expect() 处理用户控制的 settings.json,
    // 一旦 hooks / event_entries 是数组/字符串/null 就会 panic。
    // 改为防御性检查 + 类型重置,保证结构合法后再写入。

    // 1) 确保 settings 是 object
    if !settings.is_object() {
        *settings = json!({});
    }
    let settings_obj = settings
        .as_object_mut()
        .ok_or_else(|| "Claude 配置结构异常: settings 不是对象".to_string())?;

    // 2) 确保 settings.hooks 是 object,若不是则重置
    let hooks = settings_obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| "Claude 配置结构异常: hooks 不是对象".to_string())?;

    // 3) 确保 event_entries 是 array,若不是则重置
    let event_entries = hooks_obj
        .entry(entry.event.clone())
        .or_insert_with(|| json!([]));
    if !event_entries.is_array() {
        *event_entries = json!([]);
    }
    let event_array = event_entries
        .as_array_mut()
        .ok_or_else(|| "Claude 配置结构异常: event hooks 不是数组".to_string())?;

    event_array.push(json!({
        "matcher": entry.matcher,
        "hooks": [
            {
                "type": entry.action_type,
                "command": entry.command,
                "timeout": entry.timeout.unwrap_or(3000),
            }
        ]
    }));

    Ok(())
}

fn default_hook_entries() -> Result<Vec<StoredHookEntry>, String> {
    let hook_script = get_claude_hook_script_path()?;
    if let Some(parent) = hook_script.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 hook 目录失败: {}", e))?;
    }
    let script_content = build_hook_script_content();
    if fs::read_to_string(&hook_script).ok().as_deref() != Some(script_content.as_str()) {
        fs::write(&hook_script, script_content)
            .map_err(|e| format!("写入 hook 脚本失败: {}", e))?;
    }
    Ok(default_hook_entries_for_path(&hook_script))
}

fn default_hook_entries_for_path(hook_script: &Path) -> Vec<StoredHookEntry> {
    let hook_script_str = hook_script.to_string_lossy().replace('\\', "\\\\");

    vec![
        StoredHookEntry {
            event: "UserPromptSubmit".to_string(),
            matcher: "".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" userpromptsubmit", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "SubagentStart".to_string(),
            matcher: "".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" subagentstart", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "SubagentStop".to_string(),
            matcher: "".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" subagentstop", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "Stop".to_string(),
            matcher: "".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" stop", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "PermissionRequest".to_string(),
            matcher: "".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" permissionrequest", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "PreToolUse".to_string(),
            matcher: "*".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" pretooluse", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "PostToolUse".to_string(),
            matcher: "*".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" posttooluse", hook_script_str),
            timeout: Some(3000),
        },
        StoredHookEntry {
            event: "PostToolUseFailure".to_string(),
            matcher: "*".to_string(),
            action_type: "command".to_string(),
            command: format!("node \"{}\" posttoolusefailure", hook_script_str),
            timeout: Some(3000),
        },
    ]
}

fn get_claude_hook_script_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir
        .join(".claude")
        .join("hooks")
        .join("termflow-hook.cjs"))
}

pub(crate) fn ensure_claude_statusline_bridge() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    let bridge_dir = home_dir.join(".claude").join("hooks");
    fs::create_dir_all(&bridge_dir)
        .map_err(|error| format!("创建 Claude status line bridge 目录失败: {error}"))?;

    let script_path = bridge_dir.join("termflow-statusline.cjs");
    let script_content = build_statusline_bridge_content();
    if fs::read_to_string(&script_path).ok().as_deref() != Some(script_content.as_str()) {
        fs::write(&script_path, script_content)
            .map_err(|error| format!("写入 Claude status line bridge 失败: {error}"))?;
    }

    let settings_path = bridge_dir.join("termflow-statusline-settings.json");
    let command = format!("node \"{}\"", script_path.to_string_lossy());
    let settings = json!({
        "statusLine": {
            "type": "command",
            "command": command
        }
    });
    let settings_content = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("序列化 Claude status line bridge 配置失败: {error}"))?;
    if fs::read_to_string(&settings_path).ok().as_deref() != Some(settings_content.as_str()) {
        fs::write(&settings_path, settings_content)
            .map_err(|error| format!("写入 Claude status line bridge 配置失败: {error}"))?;
    }
    Ok(settings_path)
}

fn build_statusline_bridge_content() -> String {
    r#"#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let inputData = '';
try {
  inputData = fs.readFileSync(0, 'utf8');
} catch {}

let input = {};
try {
  input = inputData ? JSON.parse(inputData) : {};
} catch {}

function readSettings(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveOriginalStatusLine() {
  const projectDir = input?.workspace?.project_dir;
  const candidates = [path.join(os.homedir(), '.claude', 'settings.json')];
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    candidates.push(
      path.join(projectDir, '.claude', 'settings.json'),
      path.join(projectDir, '.claude', 'settings.local.json'),
    );
  }

  let resolved = null;
  for (const candidate of candidates) {
    const settings = readSettings(candidate);
    if (settings && Object.prototype.hasOwnProperty.call(settings, 'statusLine')) {
      resolved = settings.statusLine;
    }
  }
  return resolved;
}

function normalizeWindow(window) {
  if (!window || !Number.isFinite(Number(window.used_percentage))) return null;
  const resetsAt = Number(window.resets_at);
  return {
    usedPercent: Number(window.used_percentage),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

function reportRateLimits() {
  const sessionId = process.env.TERMFLOW_SESSION_ID || '';
  const port = Number(process.env.TERMFLOW_INGEST_PORT);
  const token = process.env.TERMFLOW_INGEST_TOKEN || '';
  if (!sessionId || !Number.isFinite(port) || port <= 0 || !token) return;

  const body = JSON.stringify({
    sessionId,
    fiveHour: normalizeWindow(input?.rate_limits?.five_hour),
    sevenDay: normalizeWindow(input?.rate_limits?.seven_day),
    updatedAt: Date.now(),
  });
  const request = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/internal/claude-rate-limits',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-TERMFLOW-TOKEN': token,
    },
    timeout: 1200,
  });
  request.on('error', () => {});
  request.on('timeout', () => request.destroy());
  request.end(body);
}

function renderOriginalStatusLine() {
  const original = resolveOriginalStatusLine();
  const command = original && original.type === 'command' && typeof original.command === 'string'
    ? original.command.trim()
    : '';
  if (!command || command.includes('termflow-statusline.cjs')) return;

  const result = spawnSync(command, {
    input: inputData,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
}

reportRateLimits();
renderOriginalStatusLine();
"#
    .to_string()
}

fn build_hook_script_content() -> String {
    r#"#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const hookName = (process.argv[2] || 'stop').toLowerCase();
let inputData = '';
try {
  inputData = fs.readFileSync(0, 'utf8');
} catch {}
let input = {};
try {
  input = inputData ? JSON.parse(inputData) : {};
} catch {}

const eventTypeByHook = {
  userpromptsubmit: 'user_prompt_submit',
  stop: 'assistant_complete',
  subagentstart: 'subagent_start',
  subagentstop: 'subagent_stop',
  permissionrequest: 'permission_request',
  pretooluse: 'pre_tool_use',
  posttooluse: 'post_tool_use',
  posttoolusefailure: 'post_tool_use_failure',
};

const eventType = eventTypeByHook[hookName];
const stateByHook = {
  userpromptsubmit: 'running',
  stop: 'completed',
  subagentstart: 'running',
  subagentstop: 'running',
  permissionrequest: 'waiting',
  pretooluse: 'running',
  posttooluse: 'running',
  posttoolusefailure: 'running',
};
const port = process.env.TERMFLOW_INGEST_PORT;
const token = process.env.TERMFLOW_INGEST_TOKEN;

if (!port || !token || !eventType || !stateByHook[hookName]) {
  process.exit(0);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value) {
  return crypto.createHmac('sha256', token).update(stableJson(value)).digest('hex');
}

const toolUseId = typeof input.tool_use_id === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(input.tool_use_id)
  ? input.tool_use_id
  : undefined;
const agentId = typeof input.agent_id === 'string' ? input.agent_id : '';
const agentType = typeof input.agent_type === 'string' ? input.agent_type : '';
const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
const hasExplicitActor = agentId.length > 0 || agentType.length > 0;
const actorFingerprint = hasExplicitActor ? digest({ agentId, agentType }) : undefined;
const hasToolContext = toolName.length > 0 && ['pretooluse', 'permissionrequest', 'posttooluse', 'posttoolusefailure'].includes(hookName);
const isSubagentLifecycle = ['subagentstart', 'subagentstop'].includes(hookName);
const safePayload = hasToolContext
  ? {
      toolUseId,
      toolFingerprint: digest({ agentId, agentType, toolName, toolInput: input.tool_input ?? null }),
      actorFingerprint,
      hasExplicitActor,
    }
  : (isSubagentLifecycle || hookName === 'stop') && hasExplicitActor
    ? { actorFingerprint, hasExplicitActor }
    : {};

const payload = {
  version: '1.0',
  agent: 'claude',
  state: stateByHook[hookName],
  event_id: `claude:${process.env.TERMFLOW_SESSION_ID || ''}:${hookName}:${crypto.randomUUID()}`,
  event_type: eventType,
  session_id: process.env.TERMFLOW_SESSION_ID || '',
  project_path: process.env.TERMFLOW_PROJECT_PATH || process.cwd(),
  session_name: process.env.TERMFLOW_SESSION_ID || '',
  source: 'hook',
  created_at: Date.now(),
  // Only keyed digests and opaque IDs leave this process. Raw hook stdin can
  // contain prompts, commands, paths, environment data, or credentials.
  payload: safePayload,
};

const body = JSON.stringify(payload);
const req = http.request(
  {
    hostname: '127.0.0.1',
    port: Number(port),
    path: '/internal/session-events',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-TERMFLOW-TOKEN': token,
    },
    timeout: 1200,
  },
  () => process.exit(0)
);

req.on('error', () => process.exit(0));
req.on('timeout', () => {
  req.destroy();
  process.exit(0);
});
req.write(body);
req.end();
"#
    .to_string()
}

fn list_hooks_for_scope(scope: &str, project_path: Option<&str>) -> Result<Vec<HookInfo>, String> {
    let config_path = get_scope_config_path(scope, project_path)?;
    Ok(collect_hook_records(scope, &config_path)?
        .into_iter()
        .map(|record| record.info)
        .collect())
}

fn collect_agent_json_hook_records(
    agent: &str,
    scope: &str,
    config_path: &Path,
) -> Result<Vec<HookRecord>, String> {
    let settings = read_settings(config_path)?;
    let mut records = collect_active_hook_records_for_agent(agent, scope, config_path, &settings);
    records.sort_by(|a, b| a.info.name.to_lowercase().cmp(&b.info.name.to_lowercase()));
    Ok(records)
}

fn collect_antigravity_hook_records(
    scope: &str,
    config_path: &Path,
) -> Result<Vec<HookRecord>, String> {
    let settings = read_settings(config_path)?;
    let groups = settings
        .as_object()
        .ok_or("Antigravity hooks.json 的根节点必须是对象")?;
    let updated_at = resolve_updated_at(config_path);
    let mut records = Vec::new();

    for (group_name, group_value) in groups {
        let Some(group) = group_value.as_object() else {
            continue;
        };
        let enabled = group
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        for (event, entries_value) in group {
            if event == "enabled" {
                continue;
            }
            let Some(entries) = entries_value.as_array() else {
                continue;
            };
            for (entry_index, entry) in entries.iter().enumerate() {
                let matcher = entry
                    .get("matcher")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let actions = entry
                    .get("hooks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![entry.clone()]);
                for (action_index, action) in actions.iter().enumerate() {
                    let command = action
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if command.is_empty() {
                        continue;
                    }
                    let timeout = action.get("timeout").and_then(Value::as_u64);
                    let identity_event = format!("{group_name}:{event}");
                    let id = build_hook_id(scope, &identity_event, &matcher, &command);
                    let event_name =
                        format_hook_name(event, &matcher, entry_index + action_index + 1);
                    records.push(HookRecord {
                        info: HookInfo {
                            agent: "antigravity".to_string(),
                            id,
                            name: format!("{group_name} · {event_name}"),
                            enabled,
                            scope: scope.to_string(),
                            event: event.to_string(),
                            matcher: matcher.clone(),
                            command: command.clone(),
                            command_preview: command_preview(&command),
                            timeout,
                            config_path: display_path(config_path),
                            updated_at,
                        },
                        raw_config: json!({
                            "group": group_name,
                            "enabled": enabled,
                            "event": event,
                            "matcher": matcher,
                            "action": action,
                        }),
                    });
                }
            }
        }
    }

    records.sort_by(|a, b| a.info.name.to_lowercase().cmp(&b.info.name.to_lowercase()));
    Ok(records)
}

fn collect_opencode_plugin_record(
    scope: &str,
    config_path: &Path,
) -> Result<Vec<HookRecord>, String> {
    if !config_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(config_path)
        .map_err(|error| format!("读取 OpenCode Plugin 失败: {error}"))?;
    let updated_at = resolve_updated_at(config_path);
    Ok(vec![HookRecord {
        info: HookInfo {
            agent: "opencode".to_string(),
            id: build_hook_id(scope, "plugin", "", &display_path(config_path)),
            name: "Termflow OpenCode Status Plugin".to_string(),
            enabled: true,
            scope: scope.to_string(),
            event: "plugin:event".to_string(),
            matcher: "session.status | session.idle | permission.asked".to_string(),
            command: display_path(config_path),
            command_preview: "OpenCode plugin subscribes to session, permission, and error events"
                .to_string(),
            timeout: Some(1200),
            config_path: display_path(config_path),
            updated_at,
        },
        raw_config: Value::String(content),
    }])
}

fn list_agent_hook_records_for_scope(
    agent: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<Vec<HookRecord>, String> {
    let agent = normalize_hook_agent(agent)?;
    let config_path = get_agent_scope_config_path(agent, scope, project_path)?;
    match agent {
        "opencode" => collect_opencode_plugin_record(scope, &config_path),
        "antigravity" => collect_antigravity_hook_records(scope, &config_path),
        _ => collect_agent_json_hook_records(agent, scope, &config_path),
    }
}

#[tauri::command]
pub fn list_agent_hooks(
    agent: String,
    project_path: Option<String>,
) -> Result<HookCatalog, String> {
    let agent = normalize_hook_agent(&agent)?;
    let user_config_path = get_agent_scope_config_path(agent, "user", None)?;
    let workspace_config_path = project_path
        .as_deref()
        .map(|path| get_agent_scope_config_path(agent, "workspace", Some(path)).map(display_path))
        .transpose()?;

    let mut records = list_agent_hook_records_for_scope(agent, "user", None)?;
    if let Some(path) = project_path.as_deref() {
        records.extend(list_agent_hook_records_for_scope(
            agent,
            "workspace",
            Some(path),
        )?);
    }
    records.sort_by(|a, b| a.info.name.to_lowercase().cmp(&b.info.name.to_lowercase()));

    Ok(HookCatalog {
        hooks: records.into_iter().map(|record| record.info).collect(),
        workspace_config_path,
        user_config_path: display_path(&user_config_path),
    })
}

#[tauri::command]
pub fn get_agent_hook_detail(
    agent: String,
    scope: String,
    id: String,
    project_path: Option<String>,
) -> Result<HookDetail, String> {
    let agent = normalize_hook_agent(&agent)?;
    let records = list_agent_hook_records_for_scope(agent, &scope, project_path.as_deref())?;
    let record = records
        .into_iter()
        .find(|record| record.info.id == id)
        .ok_or("未找到 Hook 详情")?;
    let raw_config = match record.raw_config {
        Value::String(content) => content,
        value => serde_json::to_string_pretty(&value)
            .map_err(|error| format!("序列化 Hook 详情失败: {error}"))?,
    };
    Ok(HookDetail {
        hook: record.info,
        raw_config,
    })
}

#[tauri::command]
pub fn repair_agent_hooks(
    agent: String,
    scope: String,
    project_path: Option<String>,
) -> Result<HookCatalog, String> {
    let agent = normalize_hook_agent(&agent)?;
    if agent == "claude" {
        return repair_claude_hooks(scope, project_path);
    }
    if scope != "user" {
        return Err("该智能体当前只支持修复全局 Hook/Plugin 配置".to_string());
    }
    super::agent_hooks::ensure_agent_status_hook(agent.to_string())?;
    list_agent_hooks(agent.to_string(), project_path)
}

#[tauri::command]
pub fn list_claude_hooks(project_path: Option<String>) -> Result<HookCatalog, String> {
    let user_config_path = get_scope_config_path("user", None)?;
    let workspace_config_path = project_path
        .as_deref()
        .map(|path| get_scope_config_path("workspace", Some(path)).map(display_path))
        .transpose()?;

    let mut hooks = list_hooks_for_scope("user", None)?;
    if let Some(path) = project_path.as_deref() {
        hooks.extend(list_hooks_for_scope("workspace", Some(path))?);
    }
    hooks.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(HookCatalog {
        hooks,
        workspace_config_path,
        user_config_path: display_path(&user_config_path),
    })
}

#[tauri::command]
pub fn get_claude_hook_detail(
    scope: String,
    id: String,
    project_path: Option<String>,
) -> Result<HookDetail, String> {
    let config_path = get_scope_config_path(&scope, project_path.as_deref())?;
    let records = collect_hook_records(&scope, &config_path)?;
    let record = records
        .into_iter()
        .find(|record| record.info.id == id)
        .ok_or("未找到 Hook 详情")?;

    Ok(HookDetail {
        hook: record.info,
        raw_config: serde_json::to_string_pretty(&record.raw_config)
            .map_err(|e| format!("序列化 Hook 详情失败: {}", e))?,
    })
}

#[tauri::command]
pub fn delete_claude_hook(
    scope: String,
    id: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let config_path = get_scope_config_path(&scope, project_path.as_deref())?;
    let mut settings = read_settings(&config_path)?;
    if !settings.is_object() {
        settings = json!({});
    }
    remove_active_hook(&mut settings, &scope, &id)?;

    write_settings(&config_path, &settings)?;
    remove_legacy_disabled_hooks_file(&config_path)?;
    Ok(())
}

#[tauri::command]
pub fn repair_claude_hooks(
    scope: String,
    project_path: Option<String>,
) -> Result<HookCatalog, String> {
    let config_path = get_scope_config_path(&scope, project_path.as_deref())?;
    let mut settings = read_settings(&config_path)?;
    if !settings.is_object() {
        settings = json!({});
    }
    let defaults = default_hook_entries()?;
    for entry in &defaults {
        let target_id = build_hook_id(&scope, &entry.event, &entry.matcher, &entry.command);
        let already_exists = collect_active_hook_records(&scope, &config_path, &settings)
            .into_iter()
            .any(|record| record.info.id == target_id);
        if !already_exists {
            insert_hook(&mut settings, entry)?;
        }
    }

    write_settings(&config_path, &settings)?;
    remove_legacy_disabled_hooks_file(&config_path)?;
    list_claude_hooks(project_path)
}

#[tauri::command]
pub fn check_claude_hook_status() -> Result<HookStatus, String> {
    let config_path = get_user_claude_config_path()?;
    let records = collect_hook_records("user", &config_path)?;
    let configured = CLAUDE_REQUIRED_STATUS_EVENTS.iter().all(|required_event| {
        records.iter().any(|record| {
            record.info.enabled
                && record.info.event.eq_ignore_ascii_case(required_event)
                && record.info.command.contains("termflow-hook.cjs")
        })
    });
    let hook_command = records
        .iter()
        .find(|record| {
            record.info.enabled
                && record.info.event.eq_ignore_ascii_case("stop")
                && record.info.command.contains("termflow-hook.cjs")
        })
        .map(|record| record.info.command.clone());

    Ok(HookStatus {
        configured,
        config_path: display_path(&config_path),
        hook_command,
    })
}

#[tauri::command]
pub fn get_hook_ingest_config(ingest: State<'_, Arc<HookIngestConfig>>) -> HookIngestClientConfig {
    HookIngestClientConfig {
        port: ingest.port,
        token: ingest.token.clone(),
    }
}

#[tauri::command]
pub fn get_claude_effort_info(project_path: Option<String>) -> Result<ClaudeEffortInfo, String> {
    resolve_claude_effort(project_path.as_deref())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeThemeInfo {
    pub theme: String,
    pub configured_theme: Option<String>,
    pub config_path: String,
}

fn resolve_claude_theme(project_path: Option<&str>) -> Result<ClaudeThemeInfo, String> {
    // Check local config first, then workspace, then user
    if let Some(path) = project_path {
        let local_path = get_local_claude_config_path(path);
        let local_settings = read_settings(&local_path)?;
        if let Some(theme) = local_settings.get("theme").and_then(Value::as_str) {
            return Ok(ClaudeThemeInfo {
                theme: theme.to_string(),
                configured_theme: Some(theme.to_string()),
                config_path: display_path(&local_path),
            });
        }

        let workspace_path = get_scope_config_path("workspace", Some(path))?;
        let workspace_settings = read_settings(&workspace_path)?;
        if let Some(theme) = workspace_settings.get("theme").and_then(Value::as_str) {
            return Ok(ClaudeThemeInfo {
                theme: theme.to_string(),
                configured_theme: Some(theme.to_string()),
                config_path: display_path(&workspace_path),
            });
        }
    }

    let user_path = get_user_claude_config_path()?;
    let user_settings = read_settings(&user_path)?;
    if let Some(theme) = user_settings.get("theme").and_then(Value::as_str) {
        return Ok(ClaudeThemeInfo {
            theme: theme.to_string(),
            configured_theme: Some(theme.to_string()),
            config_path: display_path(&user_path),
        });
    }

    Ok(ClaudeThemeInfo {
        theme: "dark".to_string(),
        configured_theme: None,
        config_path: display_path(&user_path),
    })
}

#[tauri::command]
pub fn get_claude_theme(project_path: Option<String>) -> Result<ClaudeThemeInfo, String> {
    resolve_claude_theme(project_path.as_deref())
}

#[tauri::command]
pub fn set_claude_theme(
    theme: String,
    project_path: Option<String>,
) -> Result<ClaudeThemeInfo, String> {
    let valid_themes = ["dark", "light", "light-daltonized", "dark-daltonized"];
    if !valid_themes.contains(&theme.as_str()) {
        return Err(format!("无效的主题: {}，可选值: {:?}", theme, valid_themes));
    }

    let target_path = match project_path.as_deref() {
        Some(path) => get_local_claude_config_path(path),
        None => get_user_claude_config_path()?,
    };

    let mut settings = read_settings(&target_path)?;
    if !settings.is_object() {
        settings = json!({});
    }
    settings
        .as_object_mut()
        .unwrap()
        .insert("theme".to_string(), Value::String(theme));
    write_settings(&target_path, &settings)?;

    resolve_claude_theme(project_path.as_deref())
}

#[tauri::command]
pub fn get_claude_usage_overview() -> Result<AgentUsageOverview, String> {
    build_claude_usage_overview()
}

#[tauri::command]
pub fn get_claude_md_detail(
    scope: String,
    project_path: Option<String>,
) -> Result<ClaudeMdDetail, String> {
    build_claude_md_detail(&scope, project_path.as_deref())
}

#[tauri::command]
pub fn save_claude_md(
    scope: String,
    content: String,
    project_path: Option<String>,
) -> Result<ClaudeMdDetail, String> {
    let (target_path, _) = resolve_claude_md_path(&scope, project_path.as_deref())?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 CLAUDE.md 目录失败: {}", e))?;
    }
    fs::write(&target_path, content).map_err(|e| format!("写入 CLAUDE.md 失败: {}", e))?;
    build_claude_md_detail(&scope, project_path.as_deref())
}

#[tauri::command]
pub fn set_claude_effort_setting(
    level: String,
    project_path: Option<String>,
) -> Result<ClaudeEffortInfo, String> {
    let Some(level) = normalize_effort_level(&level) else {
        return Err("无效的 effort 等级".to_string());
    };

    if level == "max" || level == "ultracode" {
        return Err(format!("{} 仅适用于当前会话，不能写入默认配置", level));
    }

    let target_path = resolve_default_effort_target(project_path.as_deref())?;
    let mut settings = read_settings(&target_path)?;
    set_effort_level_in_settings(&mut settings, &level);
    write_settings(&target_path, &settings)?;

    resolve_claude_effort(project_path.as_deref())
}

#[tauri::command]
pub fn configure_claude_hook() -> Result<HookStatus, String> {
    let catalog = repair_claude_hooks("user".to_string(), None)?;
    let configured = CLAUDE_REQUIRED_STATUS_EVENTS.iter().all(|required_event| {
        catalog.hooks.iter().any(|hook| {
            hook.scope == "user"
                && hook.enabled
                && hook.event.eq_ignore_ascii_case(required_event)
                && hook.command.contains("termflow-hook.cjs")
        })
    });
    let stop_hook = catalog
        .hooks
        .iter()
        .find(|hook| {
            hook.scope == "user"
                && hook.enabled
                && hook.event.eq_ignore_ascii_case("stop")
                && hook.command.contains("termflow-hook.cjs")
        })
        .map(|hook| hook.command.clone());

    Ok(HookStatus {
        configured,
        config_path: catalog.user_config_path,
        hook_command: stop_hook,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_claude_hooks_cover_permission_resume_lifecycle() {
        let entries = default_hook_entries_for_path(Path::new(
            "C:/Users/test/.claude/hooks/termflow-hook.cjs",
        ));
        let events = entries
            .iter()
            .map(|entry| entry.event.as_str())
            .collect::<BTreeSet<_>>();

        assert_eq!(
            events,
            BTreeSet::from([
                "PermissionRequest",
                "PostToolUse",
                "PostToolUseFailure",
                "PreToolUse",
                "Stop",
                "SubagentStart",
                "SubagentStop",
                "UserPromptSubmit",
            ])
        );
        assert!(entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry.event.as_str(),
                    "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
                )
            })
            .all(|entry| entry.matcher == "*"));
        assert!(entries
            .iter()
            .filter(|entry| matches!(entry.event.as_str(), "SubagentStart" | "SubagentStop"))
            .all(|entry| entry.matcher.is_empty()));
    }

    #[test]
    fn statusline_bridge_preserves_user_output_and_sends_only_rate_limit_fields() {
        let script = build_statusline_bridge_content();

        assert!(script.contains("spawnSync(command"));
        assert!(script.contains("settings.local.json"));
        assert!(script.contains("input?.rate_limits?.five_hour"));
        assert!(script.contains("input?.rate_limits?.seven_day"));
        assert!(!script.contains("input?.context_window?.current_usage"));
        assert!(!script.contains("input?.transcript_path"));
    }

    #[test]
    fn managed_claude_hook_hashes_tool_context_instead_of_forwarding_it() {
        let script = build_hook_script_content();

        assert!(script.contains("posttooluse: 'post_tool_use'"));
        assert!(script.contains("posttoolusefailure: 'post_tool_use_failure'"));
        assert!(script.contains("subagentstart: 'subagent_start'"));
        assert!(script.contains("subagentstop: 'subagent_stop'"));
        assert!(script.contains("crypto.randomUUID()"));
        assert!(script.contains("crypto.createHmac('sha256', token)"));
        assert!(script.contains("toolFingerprint"));
        assert!(script.contains("payload: safePayload"));
        assert!(!script.contains("payload: inputData"));
        assert!(!script.contains("payload: input,"));
    }

    #[test]
    fn adding_managed_post_tool_hook_preserves_user_hooks() {
        let mut settings = json!({
            "hooks": {
                "PostToolUse": [{
                    "matcher": "Write",
                    "hooks": [{"type": "command", "command": "node user-hook.js"}]
                }]
            }
        });
        let managed = default_hook_entries_for_path(Path::new("C:/termflow-hook.cjs"))
            .into_iter()
            .find(|entry| entry.event == "PostToolUse")
            .unwrap();

        insert_hook(&mut settings, &managed).unwrap();

        let hooks = settings["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(hooks.len(), 2);
        assert_eq!(hooks[0]["hooks"][0]["command"], "node user-hook.js");
        assert!(hooks[1]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("termflow-hook.cjs"));
    }

    #[test]
    fn antigravity_workspace_hooks_use_agents_directory() {
        assert_eq!(
            get_agent_scope_config_path("antigravity", "workspace", Some("project")).unwrap(),
            Path::new("project").join(".agents").join("hooks.json")
        );
        assert!(get_agent_scope_config_path("gemini", "workspace", Some("project")).is_err());
    }

    #[test]
    fn qoder_hooks_use_official_user_and_workspace_settings_paths() {
        let user_path = get_agent_scope_config_path("qoder", "user", None).unwrap();
        assert_eq!(
            user_path.file_name().and_then(|name| name.to_str()),
            Some("settings.json")
        );
        assert_eq!(
            user_path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str()),
            Some(".qoder-cn")
        );
        assert_eq!(
            get_agent_scope_config_path("qoder", "workspace", Some("project")).unwrap(),
            Path::new("project").join(".qoder").join("settings.json")
        );
    }

    #[test]
    fn parses_antigravity_top_level_hook_groups() {
        let directory =
            std::env::temp_dir().join(format!("termflow-antigravity-hooks-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("hooks.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "termflow-agent-status": {
                    "PreInvocation": [{
                        "type": "command",
                        "command": "node termflow-agent-hook.cjs antigravity PreInvocation",
                        "timeout": 10
                    }],
                    "Stop": [{
                        "type": "command",
                        "command": "node termflow-agent-hook.cjs antigravity Stop",
                        "timeout": 10
                    }]
                },
                "user-linter": {
                    "enabled": false,
                    "PostToolUse": [{
                        "matcher": "write_to_file",
                        "hooks": [{"command": "node lint.js"}]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let records = collect_antigravity_hook_records("user", &path).unwrap();
        assert_eq!(records.len(), 3);
        assert!(records
            .iter()
            .all(|record| record.info.agent == "antigravity"));
        assert!(records.iter().any(|record| {
            record.info.event == "PreInvocation" && record.info.matcher.is_empty()
        }));
        assert!(records.iter().any(|record| {
            record.info.event == "PostToolUse"
                && record.info.matcher == "write_to_file"
                && !record.info.enabled
        }));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn normalize_codex_usage_treats_detail_tokens_as_details() {
        let usage = serde_json::json!({
            "input_tokens": 100,
            "cached_input_tokens": 180,
            "output_tokens": 25,
            "reasoning_output_tokens": 15
        });

        let normalized = normalize_raw_token_usage(Some(&usage)).unwrap();

        assert_eq!(normalized.input_tokens, 100);
        assert_eq!(normalized.cached_input_tokens, 100);
        assert_eq!(normalized.output_tokens, 25);
        assert_eq!(normalized.reasoning_output_tokens, 15);
        assert_eq!(normalized.total_tokens, 125);
    }

    #[test]
    fn parse_codex_usage_record_does_not_add_cached_or_reasoning_to_total() {
        let record = serde_json::json!({
            "type": "event_msg",
            "timestamp": "2026-07-10T00:35:00Z",
            "payload": {
                "type": "token_count",
                "model": "gpt-5.5",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 80,
                        "output_tokens": 25,
                        "reasoning_output_tokens": 15
                    }
                }
            }
        })
        .to_string();
        let mut context = CodexUsageParseContext {
            session_id: "session-test".to_string(),
            session_cwd: None,
            current_cwd: Some("D:/3.project/Termflow".to_string()),
            current_model: None,
            previous_totals: None,
            total_only_baseline_pending: false,
        };

        let event = parse_codex_usage_record(&record, &mut context).unwrap();

        assert_eq!(event.model, "gpt-5.5");
        assert_eq!(event.total_tokens, 125);
        assert_eq!(event.token_breakdown.input_tokens, 20);
        assert_eq!(event.token_breakdown.output_tokens, 10);
        assert_eq!(event.token_breakdown.cache_read_tokens, 80);
        assert_eq!(event.token_breakdown.reasoning_output_tokens, 15);
        assert_eq!(event.token_breakdown.total_tokens, event.total_tokens);
    }

    #[test]
    fn parse_opencode_usage_keeps_separate_categories_additive() {
        let row = OpenCodeUsageRow {
            id: "message-test".to_string(),
            session_id: "session-test".to_string(),
            time_created: Some(1_752_109_300_000),
            time_updated: None,
            session_model: Some("claude-sonnet".to_string()),
            data: serde_json::json!({
                "tokens": {
                    "input": 20,
                    "output": 25,
                    "reasoning": 15,
                    "cache": { "read": 80 }
                },
                "time": { "created": 1_752_109_300_000_i64 }
            })
            .to_string(),
        };

        let event = parse_opencode_usage_row(row).unwrap();

        assert_eq!(event.total_tokens, 140);
        assert_eq!(event.token_breakdown.input_tokens, 20);
        assert_eq!(event.token_breakdown.output_tokens, 25);
        assert_eq!(event.token_breakdown.cache_read_tokens, 80);
        assert_eq!(event.token_breakdown.reasoning_output_tokens, 15);
        assert_eq!(event.token_breakdown.total_tokens, event.total_tokens);
    }
}
