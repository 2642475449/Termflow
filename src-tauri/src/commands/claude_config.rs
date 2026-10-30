mod claude_transcript_stats;
mod local_provider_stats;

use crate::hook_ingest::HookIngestConfig;
use crate::path_utils::{display_path, normalize_input_path};
use crate::qoder_config::{qoder_user_config_root, qoder_workspace_config_root};
use chrono::{DateTime, Local, NaiveDate, TimeZone, Timelike, Utc};
use regex::Regex;
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

const CLAUDE_REQUIRED_STATUS_EVENTS: [&str; 14] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "PermissionDenied",
    "Elicitation",
    "ElicitationResult",
    "SessionEnd",
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
    pub estimated_tokens: u64,
    pub undated_tokens: u64,
    pub token_data_incomplete: bool,
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
    pub estimated_tokens: u64,
    pub undated_tokens: u64,
    pub token_data_incomplete: bool,
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
        let cache_creation_tokens = usage
            .cache_write_input_tokens
            .min(usage.input_tokens - cache_read_tokens);
        let reasoning_output_tokens = usage.reasoning_output_tokens.min(usage.output_tokens);
        self.input_tokens += usage.input_tokens - cache_read_tokens - cache_creation_tokens;
        self.output_tokens += usage.output_tokens - reasoning_output_tokens;
        self.cache_read_tokens += cache_read_tokens;
        self.cache_creation_tokens += cache_creation_tokens;
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
        self.cache_creation_tokens += usage.cache_write_input_tokens;
        self.reasoning_output_tokens += usage.reasoning_output_tokens;

        // OpenCode persists cache reads and reasoning as separate usage
        // categories, unlike the detail subsets reported by Codex.
        let known_total = usage.input_tokens
            + usage.output_tokens
            + usage.cached_input_tokens
            + usage.cache_write_input_tokens
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
pub struct WorkspaceHookMigrationResult {
    pub removed_count: usize,
    pub catalog: HookCatalog,
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
        "pi" => Ok("pi"),
        _ => Err("该智能体不支持 Hook 设置".to_string()),
    }
}

fn get_user_codex_hooks_path() -> Result<PathBuf, String> {
    Ok(crate::agent_paths::user_path(crate::agent_paths::AgentPath::Codex)?.join("hooks.json"))
}

fn get_user_qoder_settings_path() -> Result<PathBuf, String> {
    Ok(qoder_user_config_root()?.join("settings.json"))
}

fn get_user_antigravity_hooks_path() -> Result<PathBuf, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home_dir.join(".gemini").join("config").join("hooks.json"))
}

fn get_user_opencode_plugin_path() -> Result<PathBuf, String> {
    Ok(
        crate::agent_paths::user_path(crate::agent_paths::AgentPath::OpenCode)?
            .join("plugins")
            .join("termflow-status.js"),
    )
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
        ("pi", "user") => Ok(
            crate::agent_paths::user_path(crate::agent_paths::AgentPath::Pi)?
                .join("extensions")
                .join(super::agent_hooks::PI_EXTENSION_SCRIPT_NAME),
        ),
        ("pi", "workspace") => {
            let project_path = project_path.ok_or("当前未打开项目，无法读取项目级 Pi 扩展配置")?;
            Ok(normalize_input_path(project_path)
                .join(".pi")
                .join("extensions")
                .join(super::agent_hooks::PI_EXTENSION_SCRIPT_NAME))
        }
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
    #[serde(default)]
    estimated_tokens: u64,
    #[serde(default)]
    undated_tokens: u64,
    #[serde(default)]
    pub(crate) token_data_incomplete: bool,
    #[serde(default)]
    historical_active_dates: BTreeSet<String>,
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
    Ok(crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?.join("settings.json"))
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
    Ok(crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?.join("CLAUDE.md"))
}

fn get_claude_stats_cache_path() -> Result<PathBuf, String> {
    Ok(
        crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?
            .join("stats-cache.json"),
    )
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
    Ok(crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?.join("projects"))
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
    destination.estimated_tokens += source.estimated_tokens;
    destination.undated_tokens += source.undated_tokens;
    destination.token_data_incomplete |= source.token_data_incomplete;
    destination
        .historical_active_dates
        .extend(source.historical_active_dates);

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
        .map(|entry| entry.date.clone())
        .chain(stats.historical_active_dates.iter().cloned())
        .collect::<BTreeSet<_>>()
        .len() as u32
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
        capability: if capability == "full"
            && (stats.token_data_incomplete
                || stats.undated_tokens > 0
                || stats.estimated_tokens > 0)
        {
            "partial".to_string()
        } else {
            capability.to_string()
        },
        source: source.to_string(),
        total_tokens: compute_total_tokens(&stats.model_usage),
        total_sessions: stats.total_sessions,
        total_messages: stats.total_messages,
        active_days: active_day_count(stats),
        favorite_model: compute_favorite_model(&stats.model_usage),
        last_error,
        estimated_tokens: stats.estimated_tokens,
        undated_tokens: stats.undated_tokens,
        token_data_incomplete: stats.token_data_incomplete,
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
    let hour_key = local_hour_string(&event.timestamp);
    *aggregate.hour_counts.entry(hour_key).or_insert(0) += 1;

    // Codex and OpenCode expose provider-normalized totals; keep them in the
    // aggregate total bucket so cached-input subsets are not double-counted.
    if event.total_tokens > 0 {
        aggregate
            .model_usage
            .entry(event.model.clone())
            .or_default()
            .input_tokens += event.total_tokens;
        aggregate.token_breakdown.merge(event.token_breakdown);

        let day_tokens = aggregate.daily_model_tokens.entry(date_key).or_default();
        *day_tokens.entry(event.model).or_insert(0) += event.total_tokens;
    }

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
    // 同一响应的流式分块与分叉副本保留 message.id；requestId 在部分记录中缺失。
    let message_id = entry.get("message")?.get("id")?.as_str()?.trim();
    (!message_id.is_empty()).then(|| format!("message:{message_id}"))
}

#[derive(Debug, Clone, Copy, Default)]
struct RawTokenUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_write_input_tokens: u64,
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

#[derive(Debug, Clone, Default)]
struct CodexUsageParseContext {
    session_id: String,
    session_id_locked: bool,
    fork_timestamp: Option<DateTime<Utc>>,
    session_cwd: Option<String>,
    current_cwd: Option<String>,
    current_model: Option<String>,
    previous_totals: Option<RawTokenUsage>,
    total_only_baseline_pending: bool,
    seen_response_ids: BTreeSet<String>,
    last_event_is_request_record: bool,
    last_legacy_is_cumulative_only: bool,
    previous_legacy_timestamp: Option<DateTime<Utc>>,
    last_legacy_window_start: Option<DateTime<Utc>>,
    last_compaction_timestamp: Option<DateTime<Utc>>,
    last_event_provider_totals: Option<RawTokenUsage>,
}

struct CodexUsageCandidate {
    event: ParsedAgentUsageEvent,
    authoritative: bool,
    compaction: bool,
    cumulative_only: bool,
    window_start: Option<DateTime<Utc>>,
    provider_totals: Option<RawTokenUsage>,
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
    let cache_write_input_tokens =
        json_u64(record.get("cache_write_input_tokens")).min(input_tokens - cached_input_tokens);
    let output_tokens = json_u64(record.get("output_tokens"));
    let reasoning_output_tokens = json_u64(record.get("reasoning_output_tokens"));
    let total_tokens = json_u64(record.get("total_tokens"));

    Some(RawTokenUsage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
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
        cache_write_input_tokens: current.cache_write_input_tokens.saturating_sub(
            previous
                .map(|value| value.cache_write_input_tokens)
                .unwrap_or(0),
        ),
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
        cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
        output_tokens: left.output_tokens + right.output_tokens,
        reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
        total_tokens: left.total_tokens + right.total_tokens,
    }
}

fn raw_token_usage_equals(left: RawTokenUsage, right: RawTokenUsage) -> bool {
    left.input_tokens == right.input_tokens
        && left.cached_input_tokens == right.cached_input_tokens
        && left.cache_write_input_tokens == right.cache_write_input_tokens
        && left.output_tokens == right.output_tokens
        && left.reasoning_output_tokens == right.reasoning_output_tokens
}

fn raw_token_usage_is_monotonic(current: RawTokenUsage, previous: RawTokenUsage) -> bool {
    current.input_tokens >= previous.input_tokens
        && current.cached_input_tokens >= previous.cached_input_tokens
        && current.cache_write_input_tokens >= previous.cache_write_input_tokens
        && current.output_tokens >= previous.output_tokens
        && current.reasoning_output_tokens >= previous.reasoning_output_tokens
}

fn raw_token_usage_magnitude(usage: RawTokenUsage) -> u64 {
    usage.input_tokens
        + usage.cached_input_tokens
        + usage.cache_write_input_tokens
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
    context.last_compaction_timestamp = None;

    if record_type == "compacted" {
        context.last_compaction_timestamp = parsed
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_utc);
        return None;
    }

    if record_type == "session_meta" {
        // 子代理日志可携带父线程的历史 meta；文件首个线程身份才是当前线程。
        if context.session_id_locked {
            return None;
        }
        if let Some(session_id) = extract_json_string(payload.get("id")) {
            context.session_id = session_id;
            context.session_id_locked = true;
        }
        if extract_json_string(payload.get("forked_from_id")).is_some() {
            context.fork_timestamp = parsed
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_timestamp_utc);
            context.total_only_baseline_pending = true;
        }
        context.session_cwd = extract_json_string(payload.get("cwd"));
        if context.current_cwd.is_none() {
            context.current_cwd = context.session_cwd.clone();
        }
        return None;
    }

    if record_type == "token_usage_record" {
        let timestamp = parsed
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_utc)?;
        if context
            .fork_timestamp
            .is_some_and(|start| timestamp < start)
            || extract_json_string(payload.get("thread_id")).is_some_and(|thread_id| {
                context.session_id_locked && thread_id != context.session_id
            })
        {
            return None;
        }
        let usage = normalize_raw_token_usage(payload.get("usage"))?;
        let response_id = extract_json_string(payload.get("response_id"))?;
        if usage.total_tokens == 0 || !context.seen_response_ids.insert(response_id) {
            return None;
        }
        let mut token_breakdown = AgentUsageTokenBreakdown::default();
        token_breakdown.add_codex_usage(usage, usage.total_tokens);
        context.last_event_is_request_record = true;
        context.last_event_provider_totals =
            normalize_raw_token_usage(payload.get("thread_token_usage"));
        return Some(ParsedAgentUsageEvent {
            session_id: context.session_id.clone(),
            timestamp,
            model: extract_codex_model(Some(payload))
                .or_else(|| context.current_model.clone())
                .unwrap_or_else(|| "unknown".to_string()),
            total_tokens: usage.total_tokens,
            token_breakdown,
        });
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
    let timestamp = parse_timestamp_utc(timestamp_raw)?;
    let info = payload.get("info")?;
    if !info.is_object() {
        return None;
    }

    let total_usage = normalize_raw_token_usage(info.get("total_token_usage"));
    let last_usage = normalize_raw_token_usage(info.get("last_token_usage"));
    // 压缩后该旧事件的 last.total_tokens 可能只是新上下文大小，不是一次请求用量。
    if last_usage.is_some_and(|usage| {
        usage.input_tokens == 0 && usage.output_tokens == 0 && usage.total_tokens > 0
    }) {
        if total_usage.is_some() {
            context.previous_totals = total_usage;
        }
        return None;
    }
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
    context.last_legacy_is_cumulative_only = last_usage.is_none();
    context.last_legacy_window_start = context.previous_legacy_timestamp;
    context.previous_legacy_timestamp = Some(timestamp);
    if context
        .fork_timestamp
        .is_some_and(|start| timestamp < start)
    {
        return None;
    }
    let model = extract_codex_model(Some(payload))
        .or_else(|| context.current_model.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let mut token_breakdown = AgentUsageTokenBreakdown::default();
    token_breakdown.add_codex_usage(delta, total_tokens);
    context.last_event_is_request_record = false;
    context.last_event_provider_totals = total_usage;

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
        ..CodexUsageParseContext::default()
    };

    let mut candidates = Vec::<CodexUsageCandidate>::new();
    let mut last_request_line = None;
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("读取 Codex 用量日志失败: {error}"))?;
        if let Some(event) = parse_codex_usage_record(&line, &mut context) {
            if context.last_event_is_request_record {
                last_request_line = Some(line_index);
            }
            candidates.push(CodexUsageCandidate {
                event,
                authoritative: context.last_event_is_request_record,
                compaction: false,
                cumulative_only: context.last_legacy_is_cumulative_only,
                window_start: context.last_legacy_window_start,
                provider_totals: context.last_event_provider_totals,
            });
        } else if context.last_compaction_timestamp.is_some() {
            if let Some(candidate) = candidates.last_mut().filter(|candidate| {
                candidate.authoritative && line_index.checked_sub(1) == last_request_line
            }) {
                candidate.compaction = true;
            }
        }
    }

    // 新旧记录描述同一请求时只计一次。现代线程累计包含压缩，旧累计不包含压缩；
    // 先剔除该差异再匹配请求累计状态，工具耗时不会导致同一请求被重复计数。
    let mut compaction_totals = RawTokenUsage::default();
    for candidate in &mut candidates {
        if !candidate.authoritative {
            continue;
        }
        if candidate.compaction {
            compaction_totals = add_raw_token_usage(
                compaction_totals,
                codex_raw_usage_from_event(&candidate.event),
            );
            candidate.provider_totals = None;
        } else if let Some(totals) = candidate.provider_totals {
            candidate.provider_totals =
                Some(subtract_raw_token_usage(totals, Some(compaction_totals)));
        }
    }
    // 缺累计元数据时仅覆盖同用量、完成时间相邻的一条旧记录，
    // 保留升级前的历史及混合日志中没有现代记录的请求；不能按文件一刀切。
    let mut request_records = BTreeMap::<[u64; 5], Vec<usize>>::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if candidate.authoritative {
            request_records
                .entry(codex_usage_match_key(&candidate.event))
                .or_default()
                .push(index);
        }
    }
    let first_request_timestamp = candidates
        .iter()
        .filter(|candidate| candidate.authoritative)
        .map(|candidate| candidate.event.timestamp)
        .min();
    let mut covered_legacy = BTreeSet::new();
    let mut matched_requests = BTreeSet::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if candidate.authoritative {
            continue;
        }
        let event = &candidate.event;
        let Some(matches) = request_records.get(&codex_usage_match_key(event)) else {
            continue;
        };
        let matched = matches
            .iter()
            .copied()
            .filter(|request_index| {
                !matched_requests.contains(request_index)
                    && !candidates[*request_index].compaction
                    && match (
                        candidates[*request_index].provider_totals,
                        candidate.provider_totals,
                    ) {
                        (Some(request_total), Some(legacy_total)) => {
                            codex_provider_totals_equal(request_total, legacy_total)
                        }
                        _ => {
                            (candidates[*request_index].event.timestamp - event.timestamp)
                                .num_milliseconds()
                                .unsigned_abs()
                                <= 1_000
                        }
                    }
            })
            .min_by_key(|request_index| {
                (
                    (candidates[*request_index].event.timestamp - event.timestamp)
                        .num_milliseconds()
                        .unsigned_abs(),
                    request_index.abs_diff(index),
                )
            });
        if let Some(request_index) = matched {
            if (candidate.provider_totals.is_none()
                || candidates[request_index].provider_totals.is_none())
                && !cleared_at_ms.is_some_and(|cutoff| {
                    candidates[request_index].event.timestamp.timestamp_millis() <= cutoff
                })
            {
                aggregate.token_data_incomplete = true;
            }
            matched_requests.insert(request_index);
            covered_legacy.insert(index);
        }
    }
    // 只有累计值的旧事件可能跨过多条现代请求；从该区间差分中扣除已知现代请求，
    // 压缩请求不属于旧累计值，必须保留为独立用量。
    let mut cumulative_remainders = BTreeMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if candidate.authoritative || !candidate.cumulative_only || covered_legacy.contains(&index)
        {
            continue;
        }
        let mut covered = RawTokenUsage::default();
        for (request_index, request) in candidates.iter().enumerate() {
            if !request.authoritative
                || request.compaction
                || matched_requests.contains(&request_index)
                || request.event.timestamp > candidate.event.timestamp
                || candidate
                    .window_start
                    .is_some_and(|start| request.event.timestamp <= start)
            {
                continue;
            }
            covered = add_raw_token_usage(covered, codex_raw_usage_from_event(&request.event));
            matched_requests.insert(request_index);
        }
        if covered.total_tokens > 0 {
            cumulative_remainders.insert(
                index,
                subtract_raw_token_usage(
                    codex_raw_usage_from_event(&candidate.event),
                    Some(covered),
                ),
            );
        }
    }
    for (index, candidate) in candidates.into_iter().enumerate() {
        let mut event = candidate.event;
        if covered_legacy.contains(&index)
            || cleared_at_ms.is_some_and(|cutoff| event.timestamp.timestamp_millis() <= cutoff)
        {
            continue;
        }
        // 旧 schema 没有 response_id，现代记录出现后的未匹配回退无法证明完整性。
        if !candidate.authoritative
            && first_request_timestamp.is_some_and(|start| event.timestamp >= start)
        {
            aggregate.token_data_incomplete = true;
        }
        if let Some(usage) = cumulative_remainders.remove(&index) {
            event.total_tokens = usage.total_tokens;
            event.token_breakdown = AgentUsageTokenBreakdown::default();
            event
                .token_breakdown
                .add_codex_usage(usage, usage.total_tokens);
        }
        record_generic_usage_event(&mut aggregate, &mut sessions, event);
    }
    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

fn codex_raw_usage_from_event(event: &ParsedAgentUsageEvent) -> RawTokenUsage {
    let usage = event.token_breakdown;
    RawTokenUsage {
        input_tokens: usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens,
        cached_input_tokens: usage.cache_read_tokens,
        cache_write_input_tokens: usage.cache_creation_tokens,
        output_tokens: usage.output_tokens + usage.reasoning_output_tokens,
        reasoning_output_tokens: usage.reasoning_output_tokens,
        total_tokens: event.total_tokens,
    }
}

fn codex_usage_match_key(event: &ParsedAgentUsageEvent) -> [u64; 5] {
    let usage = codex_raw_usage_from_event(event);
    // 旧版可能没有 cache_write 细分，但输入总量相同；以现代记录保留完整分类。
    [
        usage.input_tokens,
        usage.output_tokens,
        usage.cached_input_tokens,
        usage.reasoning_output_tokens,
        usage.total_tokens,
    ]
}

fn codex_provider_totals_equal(left: RawTokenUsage, right: RawTokenUsage) -> bool {
    left.input_tokens == right.input_tokens
        && left.output_tokens == right.output_tokens
        && left.cached_input_tokens == right.cached_input_tokens
        && left.reasoning_output_tokens == right.reasoning_output_tokens
        && left.total_tokens == right.total_tokens
}

#[cfg(test)]
mod codex_usage_v2_tests {
    use super::*;
    use serde_json::json;

    fn usage(input: u64, output: u64) -> Value {
        json!({"input_tokens": input, "output_tokens": output,
            "cached_input_tokens": 0, "reasoning_output_tokens": 0,
            "total_tokens": input + output})
    }

    fn legacy(timestamp: &str, total: Value, last: Option<Value>) -> Value {
        let mut info = json!({"total_token_usage": total});
        if let Some(last) = last {
            info["last_token_usage"] = last;
        }
        json!({"timestamp": timestamp, "type": "event_msg",
            "payload": {"type": "token_count", "info": info}})
    }

    fn request(timestamp: &str, id: &str, usage: Value) -> Value {
        json!({"timestamp": timestamp, "type": "token_usage_record",
            "payload": {"response_id": id, "thread_id": "thread", "model": "codex-test",
                "usage": usage}})
    }

    fn stats(records: Vec<Value>, cutoff: Option<i64>) -> AggregatedTranscriptStats {
        let file = tempfile::NamedTempFile::new().unwrap();
        let content = records
            .into_iter()
            .map(|record| record.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(file.path(), content).unwrap();
        build_codex_usage_session_stats(file.path(), cutoff).unwrap()
    }

    #[test]
    fn codex_v2_keeps_legacy_prefix_gaps_and_compaction_without_double_counting() {
        let result = stats(
            vec![
                legacy("2026-10-29T00:00:00Z", usage(100, 0), Some(usage(100, 0))),
                request("2026-10-29T00:00:10Z", "response-normal", usage(200, 0)),
                legacy(
                    "2026-10-29T00:00:10.100Z",
                    usage(300, 0),
                    Some(usage(200, 0)),
                ),
                request("2026-10-29T00:00:20Z", "response-compact", usage(40, 10)),
                legacy(
                    "2026-10-29T00:00:20.100Z",
                    usage(300, 0),
                    Some(json!({"input_tokens": 0, "output_tokens": 0, "total_tokens": 50_000})),
                ),
                legacy("2026-10-29T00:00:30Z", usage(325, 0), Some(usage(25, 0))),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 375);
        assert_eq!(result.total_messages(), 4);
        assert_eq!(result.token_breakdown.total_tokens, 375);
        assert_eq!(result.token_breakdown.other_tokens, 0);
    }

    #[test]
    fn codex_v2_deduplicates_response_ids_but_keeps_equal_distinct_requests() {
        let result = stats(
            vec![
                request("2026-10-29T00:00:00Z", "same-id", usage(100, 20)),
                request("2026-10-29T00:00:10Z", "same-id", usage(100, 20)),
                request("2026-10-29T00:00:20Z", "different-id", usage(100, 20)),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 240);
        assert_eq!(result.total_messages(), 2);
    }

    #[test]
    fn codex_v2_matches_legacy_before_request_and_keeps_unrelated_equal_usage() {
        let result = stats(
            vec![
                legacy("2026-10-29T00:00:00Z", usage(100, 20), Some(usage(100, 20))),
                request("2026-10-29T00:00:00.100Z", "response", usage(100, 20)),
                legacy("2026-10-29T00:00:10Z", usage(200, 40), Some(usage(100, 20))),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 240);
        assert_eq!(result.total_messages(), 2);
    }

    #[test]
    fn codex_v2_cumulative_evidence_matches_delayed_tool_completion_after_compaction() {
        let mut first = request("2026-10-29T00:00:10Z", "slow-tool", usage(200, 0));
        first["payload"]["thread_token_usage"] = usage(300, 0);
        let mut compact = request("2026-10-29T00:04:00Z", "compact", usage(50, 0));
        compact["payload"]["thread_token_usage"] = usage(350, 0);
        let mut later = request("2026-10-29T00:05:00Z", "later", usage(25, 0));
        later["payload"]["thread_token_usage"] = usage(375, 0);
        let result = stats(
            vec![
                legacy("2026-10-29T00:00:00Z", usage(100, 0), Some(usage(100, 0))),
                first,
                legacy("2026-10-29T00:03:00Z", usage(300, 0), Some(usage(200, 0))),
                compact,
                json!({"type": "compacted", "timestamp": "2026-10-29T00:04:00.100Z", "payload": {}}),
                later,
                legacy("2026-10-29T00:06:00Z", usage(325, 0), Some(usage(25, 0))),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 375);
        assert_eq!(result.total_messages(), 4);
        assert!(!result.token_data_incomplete);
    }

    #[test]
    fn codex_v2_cutoff_uses_request_time_even_when_legacy_copy_crosses_cutoff() {
        let cutoff = parse_timestamp_utc("2026-10-29T00:00:10.050Z")
            .unwrap()
            .timestamp_millis();
        let result = stats(
            vec![
                request("2026-10-29T00:00:10Z", "before-clear", usage(100, 0)),
                legacy(
                    "2026-10-29T00:00:10.100Z",
                    usage(100, 0),
                    Some(usage(100, 0)),
                ),
                request("2026-10-29T00:00:20Z", "after-clear", usage(50, 0)),
                legacy(
                    "2026-10-29T00:00:20.100Z",
                    usage(150, 0),
                    Some(usage(50, 0)),
                ),
            ],
            Some(cutoff),
        );
        assert_eq!(result.total_tokens(), 50);
        assert_eq!(result.total_messages(), 1);
    }

    #[test]
    fn codex_v2_cache_writes_are_an_input_subset_and_modern_details_replace_legacy() {
        let modern_usage = json!({"input_tokens": 100, "cached_input_tokens": 60,
            "cache_write_input_tokens": 25, "output_tokens": 20,
            "reasoning_output_tokens": 5, "total_tokens": 120});
        let mut old_usage = modern_usage.clone();
        old_usage
            .as_object_mut()
            .unwrap()
            .remove("cache_write_input_tokens");
        let result = stats(
            vec![
                request("2026-10-29T00:00:00Z", "with-writes", modern_usage),
                legacy(
                    "2026-10-29T00:00:00.100Z",
                    old_usage.clone(),
                    Some(old_usage),
                ),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 120);
        assert_eq!(result.token_breakdown.input_tokens, 15);
        assert_eq!(result.token_breakdown.output_tokens, 15);
        assert_eq!(result.token_breakdown.cache_read_tokens, 60);
        assert_eq!(result.token_breakdown.cache_creation_tokens, 25);
        assert_eq!(result.token_breakdown.reasoning_output_tokens, 5);
        assert_eq!(result.token_breakdown.total_tokens, 120);
    }

    #[test]
    fn codex_v2_cumulative_only_legacy_subtracts_modern_requests_but_not_compaction() {
        let result = stats(
            vec![
                legacy("2026-10-29T00:00:00Z", usage(100, 0), None),
                request("2026-10-29T00:00:10Z", "normal", usage(200, 0)),
                request("2026-10-29T00:00:20Z", "compact", usage(50, 0)),
                json!({"type": "compacted", "timestamp": "2026-10-29T00:00:20.100Z", "payload": {}}),
                legacy("2026-10-29T00:00:30Z", usage(350, 0), None),
                legacy("2026-10-29T00:00:40Z", usage(350, 0), None),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 400);
        assert_eq!(result.total_messages(), 4);
        assert_eq!(result.token_breakdown.total_tokens, 400);
    }

    #[test]
    fn codex_v2_fork_identity_and_history_do_not_leak_from_parent_meta() {
        let result = stats(
            vec![
                json!({"type": "session_meta", "timestamp": "2026-10-29T00:00:10Z",
                "payload": {"id": "thread", "forked_from_id": "parent"}}),
                json!({"type": "session_meta", "timestamp": "2026-10-29T00:00:10Z",
                "payload": {"id": "parent"}}),
                legacy("2026-10-29T00:00:00Z", usage(100, 0), Some(usage(100, 0))),
                json!({"type": "token_usage_record", "timestamp": "2026-10-29T00:00:11Z",
                "payload": {"thread_id": "parent", "response_id": "parent-response", "usage": usage(100, 0)}}),
                request("2026-10-29T00:00:12Z", "child-response", usage(25, 0)),
                legacy(
                    "2026-10-29T00:00:12.100Z",
                    usage(125, 0),
                    Some(usage(25, 0)),
                ),
            ],
            None,
        );
        assert_eq!(result.total_tokens(), 25);
        assert_eq!(result.total_messages(), 1);
        assert_eq!(result.total_sessions, 1);
        let mut context = CodexUsageParseContext::default();
        for id in ["child", "parent"] {
            parse_codex_usage_record(
                &json!({"type": "session_meta", "payload": {"id": id}}).to_string(),
                &mut context,
            );
        }
        assert_eq!(context.session_id, "child");
    }

    #[test]
    #[ignore = "requires an explicit local rollout path; reads usage metadata only"]
    fn codex_v2_real_rollout_reconciles_compaction_usage() {
        let path = std::env::var("TERMFLOW_USAGE_TEST_ROLLOUT").expect("explicit rollout path");
        let result = build_codex_usage_session_stats(Path::new(&path), None).unwrap();
        assert_eq!(result.total_tokens(), 63_636_343);
        assert_eq!(result.total_messages(), 272);
        assert_eq!(result.token_breakdown.total_tokens, result.total_tokens());
        assert_eq!(result.token_breakdown.other_tokens, 0);
        assert!(!result.token_data_incomplete);
    }
}

#[derive(Debug, Clone)]
struct OpenCodeUsageRow {
    id: String,
    session_id: String,
    time_created: Option<i64>,
    time_updated: Option<i64>,
    session_model: Option<String>,
    data: String,
    is_session_total: bool,
}

fn resolve_opencode_data_home(xdg_data_home: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    // OpenCode 在 Windows 也遵循 XDG 默认目录，不使用 LocalAppData。
    xdg_data_home
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| home.map(|home| home.join(".local").join("share")))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn opencode_data_home() -> PathBuf {
    resolve_opencode_data_home(
        env::var_os("XDG_DATA_HOME").map(PathBuf::from),
        dirs_next::home_dir(),
    )
}

fn opencode_data_dir() -> PathBuf {
    opencode_data_home().join("opencode")
}

fn collect_opencode_database_paths() -> Vec<PathBuf> {
    collect_opencode_database_paths_at(
        &opencode_data_dir(),
        env::var_os("OPENCODE_DB").map(PathBuf::from),
    )
}

fn collect_opencode_database_paths_at(
    data_dir: &Path,
    database_override: Option<PathBuf>,
) -> Vec<PathBuf> {
    if let Some(path) = database_override.filter(|path| !path.as_os_str().is_empty()) {
        if path == Path::new(":memory:") {
            return Vec::new();
        }
        let resolved = if path.is_absolute() {
            path
        } else {
            data_dir.join(path)
        };
        return resolved.exists().then_some(resolved).into_iter().collect();
    }

    let Ok(entries) = fs::read_dir(data_dir) else {
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

fn opencode_session_model_select(connection: &Connection, session_table: &str) -> &'static str {
    if sqlite_column_exists(connection, session_table, "model") {
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

fn map_opencode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpenCodeUsageRow> {
    Ok(OpenCodeUsageRow {
        id: row_optional_string(row, "id").unwrap_or_else(|| "unknown".to_string()),
        session_id: row_optional_string(row, "session_id").unwrap_or_else(|| "unknown".to_string()),
        time_created: row_optional_i64(row, "time_created"),
        time_updated: row_optional_i64(row, "time_updated"),
        session_model: row_optional_string(row, "session_model"),
        data: row_optional_string(row, "data").unwrap_or_else(|| "{}".to_string()),
        is_session_total: false,
    })
}

fn select_opencode_session_usage_rows(
    connection: &Connection,
    session_table: &str,
) -> Result<Vec<OpenCodeUsageRow>, String> {
    let session_model_select = opencode_session_model_select(connection, session_table);
    let time_created_select = sqlite_select_column(connection, session_table, "s", "time_created");
    let time_updated_select = sqlite_select_column(connection, session_table, "s", "time_updated");
    let token_select = [
        "tokens_input",
        "tokens_output",
        "tokens_reasoning",
        "tokens_cache_read",
        "tokens_cache_write",
    ]
    .map(|column| sqlite_select_column(connection, session_table, "s", column))
    .join(", ");
    let sql = format!(
        "SELECT s.id AS id, s.id AS session_id, {time_created_select}, {time_updated_select},
                {session_model_select}, {token_select}
         FROM {session_table} s ORDER BY s.id"
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
            let cache_write_tokens = row_u64(row, "tokens_cache_write");
            Ok(OpenCodeUsageRow {
                id: row_optional_string(row, "id").unwrap_or_else(|| "unknown".to_string()),
                session_id: row_optional_string(row, "session_id")
                    .unwrap_or_else(|| "unknown".to_string()),
                time_created: row_optional_i64(row, "time_created"),
                time_updated: row_optional_i64(row, "time_updated"),
                session_model: row_optional_string(row, "session_model"),
                data: json!({
                    "tokens": {
                        "input": input_tokens,
                        "output": output_tokens,
                        "reasoning": reasoning_tokens,
                        "total": input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens,
                        "cache": {
                            "read": cache_read_tokens,
                            "write": cache_write_tokens
                        }
                    }
                })
                .to_string(),
                is_session_total: true,
            })
        })
        .map_err(|error| format!("读取 OpenCode session 统计失败: {error}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn select_opencode_message_rows(
    connection: &Connection,
    session_table: &str,
    table: &str,
    alias: &str,
) -> Result<Vec<OpenCodeUsageRow>, String> {
    let session_model_select = opencode_session_model_select(connection, session_table);
    let time_created_select = sqlite_select_column(connection, table, alias, "time_created");
    let time_updated_select = sqlite_select_column(connection, table, alias, "time_updated");
    let assistant_predicate = if sqlite_column_exists(connection, table, "type") {
        format!("{alias}.type = 'assistant'")
    } else {
        format!("json_valid({alias}.data) AND json_extract({alias}.data, '$.role') = 'assistant'")
    };
    let fork_predicate = if sqlite_column_exists(connection, session_table, "fork_session_id")
        && sqlite_column_exists(connection, session_table, "time_created")
        && sqlite_column_exists(connection, table, "time_created")
    {
        // v2 fork 复制历史时保留原消息时间，不能再次记成新模型调用。
        format!("(s.fork_session_id IS NULL OR {alias}.time_created >= s.time_created)")
    } else {
        "1 = 1".to_string()
    };
    let order_by = if sqlite_column_exists(connection, table, "time_created") {
        format!("{alias}.time_created")
    } else {
        format!("{alias}.id")
    };
    let sql = format!(
        "SELECT {alias}.id AS id, {alias}.session_id AS session_id,
                {time_created_select}, {time_updated_select}, {alias}.data AS data, {session_model_select}
         FROM {table} {alias}
         JOIN {session_table} s ON s.id = {alias}.session_id
         WHERE {assistant_predicate} AND {fork_predicate}
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
    let mut rows = Vec::new();
    let mut claimed_sessions = BTreeSet::new();
    let has_v2 = sqlite_table_exists(connection, "session_v2");
    for session_table in ["session_v2", "session"] {
        if !sqlite_table_exists(connection, session_table) {
            continue;
        }
        let session_rows = select_opencode_session_usage_rows(connection, session_table)?;
        let current_sessions = session_rows
            .iter()
            .map(|row| row.session_id.clone())
            .collect::<BTreeSet<_>>();
        let message_tables: &[&str] = if session_table == "session_v2" {
            &["session_message"]
        } else if has_v2 {
            &["message"]
        } else {
            &["session_message", "message"]
        };
        let mut claimed_message_sessions = BTreeSet::new();
        for message_table in message_tables {
            if !sqlite_table_exists(connection, message_table) {
                continue;
            }
            let messages =
                select_opencode_message_rows(connection, session_table, message_table, "m")?
                    .into_iter()
                    .filter(|row| {
                        !claimed_sessions.contains(&row.session_id)
                            && !claimed_message_sessions.contains(&row.session_id)
                            && parse_opencode_usage_row(row.clone()).is_some()
                    })
                    .collect::<Vec<_>>();
            claimed_message_sessions.extend(messages.iter().map(|row| row.session_id.clone()));
            rows.extend(messages);
        }
        // 迁移后新旧表可能并存，同一 session 只接受新投影。
        rows.extend(
            session_rows
                .into_iter()
                .filter(|row| !claimed_sessions.contains(&row.session_id)),
        );
        claimed_sessions.extend(current_sessions);
    }
    Ok(rows)
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
    let cache_write_input_tokens = json_u64(cache.and_then(|cache| cache.get("write")));
    let explicit_total = json_u64(tokens.get("total"));
    let categorized_total = input_tokens
        + output_tokens
        + reasoning_tokens
        + cached_input_tokens
        + cache_write_input_tokens;
    let total_tokens = explicit_total.max(categorized_total);

    if row.is_session_total && total_tokens == 0 {
        return None;
    }

    // 累计记录缺日期时仍保留总量，epoch 仅作内部占位，不写入每日统计。
    let timestamp = extract_opencode_timestamp(&data, &row).or_else(|| {
        row.is_session_total
            .then(|| Utc.timestamp_millis_opt(0).single())
            .flatten()
    })?;
    let raw_usage = RawTokenUsage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
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

fn build_opencode_usage_stats_from_paths(
    paths: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::<String, UsageSessionSpan>::new();
    let mut unique_rows = BTreeMap::<(bool, String, String), OpenCodeUsageRow>::new();

    for db_path in paths {
        let connection = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| {
                format!(
                    "打开 OpenCode 数据库失败 {}: {error}",
                    display_path(&db_path)
                )
            })?;
        for row in select_opencode_usage_rows(&connection)? {
            let Some(event) = parse_opencode_usage_row(row.clone()) else {
                continue;
            };
            let key = (row.is_session_total, row.session_id.clone(), row.id.clone());
            let replace = unique_rows.get(&key).is_none_or(|previous| {
                let previous_total = parse_opencode_usage_row(previous.clone())
                    .map(|event| event.total_tokens)
                    .unwrap_or(0);
                (row.time_updated.unwrap_or(0), event.total_tokens)
                    > (previous.time_updated.unwrap_or(0), previous_total)
            });
            if replace {
                unique_rows.insert(key, row);
            }
        }
    }

    let mut observed = BTreeMap::<String, AgentUsageTokenBreakdown>::new();
    for row in unique_rows.values().filter(|row| !row.is_session_total) {
        if let Some(event) = parse_opencode_usage_row(row.clone()) {
            observed
                .entry(event.session_id.clone())
                .or_default()
                .merge(event.token_breakdown.clone());
            record_generic_usage_event(&mut aggregate, &mut sessions, event);
        }
    }
    for row in unique_rows.into_values().filter(|row| row.is_session_total) {
        let Some(event) = parse_opencode_usage_row(row.clone()) else {
            continue;
        };
        let recorded = observed.get(&event.session_id).cloned().unwrap_or_default();
        let total = event.token_breakdown;
        let mut remainder = AgentUsageTokenBreakdown {
            input_tokens: total.input_tokens.saturating_sub(recorded.input_tokens),
            output_tokens: total.output_tokens.saturating_sub(recorded.output_tokens),
            cache_read_tokens: total
                .cache_read_tokens
                .saturating_sub(recorded.cache_read_tokens),
            cache_creation_tokens: total
                .cache_creation_tokens
                .saturating_sub(recorded.cache_creation_tokens),
            reasoning_output_tokens: total
                .reasoning_output_tokens
                .saturating_sub(recorded.reasoning_output_tokens),
            other_tokens: total.other_tokens.saturating_sub(recorded.other_tokens),
            total_tokens: 0,
        };
        remainder.recalculate_total();
        if remainder.total_tokens > 0 {
            // 累计剩余没有逐请求日期，不能冒充最后更新日的交互或用量。
            aggregate.undated_tokens += remainder.total_tokens;
            aggregate.token_data_incomplete = true;
            // session.model 只是当前选择，不能代表整段缺失历史实际使用的模型。
            aggregate
                .model_usage
                .entry("unknown".to_string())
                .or_default()
                .input_tokens += remainder.total_tokens;
            aggregate.token_breakdown.merge(remainder);
        }
        let first = normalize_millis(row.time_created)
            .and_then(|value| Utc.timestamp_millis_opt(value).single());
        let last = normalize_millis(row.time_updated)
            .and_then(|value| Utc.timestamp_millis_opt(value).single());
        if let Some(first) = first.or(last) {
            let span = sessions
                .entry(event.session_id)
                .or_insert_with(|| UsageSessionSpan::new(first));
            span.update(first);
            if let Some(last) = last {
                span.update(last);
            }
        }
    }
    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

fn build_opencode_usage_stats() -> Result<AggregatedTranscriptStats, String> {
    build_opencode_usage_stats_from_paths(collect_opencode_database_paths())
}

fn antigravity_gemini_home() -> Option<PathBuf> {
    for variable in [
        "TERMFLOW_ANTIGRAVITY_HOME",
        "ANTIGRAVITY_HOME",
        "GEMINI_HOME",
    ] {
        if let Some(value) = env::var_os(variable).filter(|value| !value.is_empty()) {
            return Some(PathBuf::from(value));
        }
    }
    dirs_next::home_dir().map(|home_dir| home_dir.join(".gemini"))
}

fn collect_antigravity_transcript_files(home: &Path) -> Vec<PathBuf> {
    let mut paths = BTreeMap::<String, PathBuf>::new();
    let Ok(variants) = fs::read_dir(home) else {
        return Vec::new();
    };
    for variant in variants.flatten() {
        if !variant
            .file_name()
            .to_string_lossy()
            .starts_with("antigravity")
        {
            continue;
        }
        let Ok(entries) = fs::read_dir(variant.path().join("brain")) else {
            continue;
        };
        for entry in entries.flatten() {
            let logs = entry.path().join(".system_generated").join("logs");
            let full = logs.join("transcript_full.jsonl");
            let transcript = if full.is_file() {
                full
            } else {
                logs.join("transcript.jsonl")
            };
            if let Ok(transcript) = transcript.canonicalize() {
                paths.insert(local_path_key(&transcript), transcript);
            }
        }
    }
    paths.into_values().collect()
}

fn estimate_antigravity_tokens(value: &str) -> u64 {
    let mut cjk_characters = 0_u64;
    let mut other_characters = 0_u64;
    for character in value.chars() {
        let codepoint = character as u32;
        if (0x3400..=0x4dbf).contains(&codepoint)
            || (0x4e00..=0x9fff).contains(&codepoint)
            || (0x3040..=0x30ff).contains(&codepoint)
        {
            cjk_characters += 1;
        } else {
            other_characters += 1;
        }
    }
    cjk_characters + other_characters.div_ceil(4)
}

fn estimate_antigravity_value_tokens(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::String(value)) => estimate_antigravity_tokens(value),
        Some(Value::Null) | None => 0,
        Some(value) => serde_json::to_string(value)
            .map(|serialized| estimate_antigravity_tokens(&serialized))
            .unwrap_or(0),
    }
}

fn normalize_antigravity_model(model: &str) -> Option<String> {
    let mut normalized = model
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|part| {
            !matches!(
                *part,
                "thinking" | "xhigh" | "high" | "medium" | "low" | "fast"
            )
        })
        .collect::<Vec<_>>()
        .join("-");
    normalized = normalized
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '.' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while normalized.contains("--") {
        normalized = normalized.replace("--", "-");
    }
    for suffix in ["-thinking", "-xhigh", "-high", "-medium", "-low", "-fast"] {
        if let Some(value) = normalized.strip_suffix(suffix) {
            normalized = value.to_string();
        }
    }
    let normalized = normalized.trim_matches('-');
    if normalized.is_empty() {
        return None;
    }
    for marker in ["gemini", "claude", "gpt"] {
        if let Some(index) = normalized.find(marker) {
            return Some(normalized[index..].to_string());
        }
    }
    Some(format!("antigravity-{normalized}"))
}

fn extract_antigravity_model_selection(content: &str) -> Option<String> {
    let pattern = Regex::new(
        r"(?i)changed setting `Model Selection` from .*? to ([^`\n]+?)(?:\s*\([^)]*\))?\.(?:\s+|$)",
    )
    .ok()?;
    normalize_antigravity_model(pattern.captures(content)?.get(1)?.as_str())
}

fn antigravity_default_model(transcript_path: &Path) -> Option<String> {
    let mut variant_directory = transcript_path.to_path_buf();
    for _ in 0..5 {
        variant_directory = variant_directory.parent()?.to_path_buf();
    }
    let settings = fs::read_to_string(variant_directory.join("settings.json")).ok()?;
    let parsed = serde_json::from_str::<Value>(&settings).ok()?;
    let model = parsed.get("model")?.as_str()?;
    normalize_antigravity_model(model)
}

fn antigravity_session_id(transcript_path: &Path) -> String {
    transcript_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn build_antigravity_usage_stats_from_files(
    transcript_files: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::<String, UsageSessionSpan>::new();

    for transcript_path in transcript_files {
        let file = fs::File::open(&transcript_path).map_err(|error| {
            format!(
                "无法读取 Antigravity transcript {}: {error}",
                display_path(&transcript_path)
            )
        })?;
        let session_id = antigravity_session_id(&transcript_path);
        let mut current_model = antigravity_default_model(&transcript_path);
        let mut context_tokens = 0_u64;
        let mut previous_context_tokens = 0_u64;

        for line in BufReader::new(file).lines() {
            let line =
                line.map_err(|error| format!("读取 Antigravity transcript 失败: {error}"))?;
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(record_type) = record.get("type").and_then(Value::as_str) else {
                continue;
            };
            if matches!(record_type, "USER_INPUT" | "USER_SETTINGS_CHANGE") {
                if let Some(model) = record
                    .get("content")
                    .and_then(Value::as_str)
                    .and_then(extract_antigravity_model_selection)
                {
                    current_model = Some(model);
                }
            }

            let event_context_tokens = estimate_antigravity_value_tokens(record.get("content"))
                + estimate_antigravity_value_tokens(record.get("tool_calls"));
            if record_type == "PLANNER_RESPONSE" {
                let timestamp = record
                    .get("created_at")
                    .and_then(Value::as_str)
                    .and_then(parse_timestamp_utc);
                if let Some(timestamp) = timestamp {
                    let input_tokens = context_tokens.saturating_sub(previous_context_tokens);
                    let output_tokens = estimate_antigravity_value_tokens(record.get("content"))
                        + estimate_antigravity_value_tokens(record.get("tool_calls"));
                    let reasoning_output_tokens =
                        estimate_antigravity_value_tokens(record.get("thinking"));
                    let total_tokens = input_tokens + output_tokens + reasoning_output_tokens;
                    if total_tokens > 0 {
                        // 旧 transcript 的字符估算不能恢复请求上下文和缓存用量。
                        // 保留独立估算值和真实活动，不把估算并入精确 Token 总量。
                        aggregate.estimated_tokens += total_tokens;
                        aggregate.token_data_incomplete = true;
                        record_generic_usage_event(
                            &mut aggregate,
                            &mut sessions,
                            ParsedAgentUsageEvent {
                                session_id: session_id.clone(),
                                timestamp,
                                model: current_model
                                    .clone()
                                    .unwrap_or_else(|| "antigravity-unknown".to_string()),
                                total_tokens: 0,
                                token_breakdown: AgentUsageTokenBreakdown::default(),
                            },
                        );
                    }
                    previous_context_tokens = context_tokens;
                }
            }
            context_tokens += event_context_tokens;
        }
    }

    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

fn build_antigravity_usage_stats() -> Result<(AggregatedTranscriptStats, bool, bool), String> {
    let Some(home) = antigravity_gemini_home() else {
        return Ok((AggregatedTranscriptStats::default(), false, false));
    };
    build_antigravity_usage_stats_at(&home)
}

fn build_antigravity_usage_stats_at(
    home: &Path,
) -> Result<(AggregatedTranscriptStats, bool, bool), String> {
    let scan = crate::database::antigravity::scan(home);
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::new();
    let mut covered = BTreeSet::new();
    for (path, conversation) in scan.conversations {
        if conversation.events.is_empty() {
            continue;
        }
        covered.insert(local_path_key(&path));
        for event in conversation.events {
            let Some(timestamp) = DateTime::from_timestamp(event.timestamp, 0) else {
                continue;
            };
            let total_tokens = event.input + event.output + event.cache;
            record_generic_usage_event(
                &mut aggregate,
                &mut sessions,
                ParsedAgentUsageEvent {
                    session_id: local_path_key(&path),
                    timestamp,
                    model: normalize_antigravity_model(&event.model).unwrap_or(event.model),
                    total_tokens,
                    token_breakdown: AgentUsageTokenBreakdown {
                        input_tokens: event.input,
                        output_tokens: event.output,
                        cache_read_tokens: event.cache,
                        total_tokens,
                        ..AgentUsageTokenBreakdown::default()
                    },
                },
            );
        }
    }
    finalize_generic_sessions(&mut aggregate, sessions);
    let mut estimated = false;
    let mut incomplete = scan.incomplete;
    for transcript in collect_antigravity_transcript_files(home) {
        let variant = transcript.ancestors().nth(5);
        let database = variant.map(|root| {
            root.join("conversations")
                .join(format!("{}.db", antigravity_session_id(&transcript)))
        });
        if database
            .and_then(|path| path.canonicalize().ok())
            .is_some_and(|path| covered.contains(&local_path_key(&path)))
        {
            continue;
        }
        match build_antigravity_usage_stats_from_files(vec![transcript]) {
            Ok(stats) => {
                estimated |= stats.estimated_tokens > 0;
                merge_aggregated_stats(&mut aggregate, stats);
            }
            Err(_) => incomplete = true,
        }
    }
    aggregate.token_data_incomplete |= incomplete;
    Ok((aggregate, estimated, incomplete))
}

#[derive(Debug, Clone)]
struct QoderUsageRow {
    id: String,
    session_id: String,
    token_info: String,
    model_info: Option<String>,
    created_at: Option<i64>,
    has_content: bool,
}

fn qoder_database_path(env_prefix: &str, app_directory: &str) -> Option<PathBuf> {
    let database_override = format!("{env_prefix}_DB_PATH");
    if let Some(value) = env::var_os(&database_override).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(value));
    }

    let home_override = format!("{env_prefix}_HOME");
    if let Some(value) = env::var_os(&home_override).filter(|value| !value.is_empty()) {
        return Some(
            PathBuf::from(value)
                .join("SharedClientCache")
                .join("cache")
                .join("db")
                .join("local.db"),
        );
    }

    let home_dir = dirs_next::home_dir()?;
    let root = if cfg!(windows) {
        env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home_dir.join("Library").join("Application Support")
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".config"))
    };
    Some(
        root.join(app_directory)
            .join("SharedClientCache")
            .join("cache")
            .join("db")
            .join("local.db"),
    )
}

fn local_path_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        key.to_ascii_lowercase()
    } else {
        key
    }
}

fn collect_qoder_database_paths() -> Vec<PathBuf> {
    let mut paths = BTreeMap::<String, PathBuf>::new();
    // Termflow starts qoderclicn, whose desktop client stores history under
    // QoderCN. Keep Qoder too: both desktop clients may coexist and each has
    // its own independent local history.
    for (env_prefix, app_directory) in [("QODER", "Qoder"), ("QODER_CN", "QoderCN")] {
        let Some(path) = qoder_database_path(env_prefix, app_directory) else {
            continue;
        };
        if path.is_file() {
            paths.insert(local_path_key(&path), path);
        }
    }
    paths.into_values().collect()
}

fn select_qoder_usage_rows(connection: &Connection) -> Result<Vec<QoderUsageRow>, String> {
    if !sqlite_table_exists(connection, "chat_message")
        || !["id", "session_id", "role", "token_info", "gmt_create"]
            .iter()
            .all(|column| sqlite_column_exists(connection, "chat_message", column))
    {
        return Ok(Vec::new());
    }

    let model_info_select = sqlite_select_column(connection, "chat_message", "cm", "model_info");
    let content_select = sqlite_select_column(connection, "chat_message", "cm", "content");
    let sql = format!(
        "SELECT cm.id, cm.session_id, cm.token_info, {model_info_select}, cm.gmt_create, {content_select}
         FROM chat_message cm
         WHERE cm.role = 'assistant'
         ORDER BY cm.gmt_create, cm.rowid"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("读取 Qoder 用量记录失败: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(QoderUsageRow {
                id: row_optional_string(row, "id").unwrap_or_else(|| "unknown".to_string()),
                session_id: row_optional_string(row, "session_id")
                    .unwrap_or_else(|| "unknown".to_string()),
                token_info: row_optional_string(row, "token_info").unwrap_or_default(),
                model_info: row_optional_string(row, "model_info"),
                created_at: row_optional_i64(row, "gmt_create"),
                has_content: row_optional_string(row, "content").is_some_and(|value| {
                    match serde_json::from_str::<Value>(&value) {
                        Ok(content) => local_provider_stats::has_content(Some(&content)),
                        Err(_) => !value.trim().is_empty(),
                    }
                }),
            })
        })
        .map_err(|error| format!("读取 Qoder 用量记录失败: {error}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn extract_qoder_model(model_info: Option<&str>) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(model_info?).ok()?;
    let record = parsed.as_object()?;
    extract_json_string(record.get("model_key"))
        .or_else(|| extract_json_string(record.get("modelKey")))
}

fn qoder_model_label(model_info: Option<&str>) -> String {
    let model = extract_qoder_model(model_info).unwrap_or_else(|| "agent".to_string());
    format!("Qoder / {model}")
}

fn parse_qoder_usage_row(row: QoderUsageRow) -> Option<ParsedAgentUsageEvent> {
    let token_info = serde_json::from_str::<Value>(&row.token_info).unwrap_or(Value::Null);
    let prompt_tokens = json_u64(token_info.get("prompt_tokens"));
    let cached_input_tokens = json_u64(token_info.get("cached_tokens")).min(prompt_tokens);
    let output_tokens = json_u64(token_info.get("completion_tokens"));
    let total_tokens = prompt_tokens + output_tokens;
    if total_tokens == 0 && !row.has_content {
        return None;
    }

    let timestamp = Utc
        .timestamp_millis_opt(normalize_millis(row.created_at)?)
        .single()?;
    let raw_usage = RawTokenUsage {
        input_tokens: prompt_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens: 0,
        total_tokens,
        ..Default::default()
    };
    let mut token_breakdown = AgentUsageTokenBreakdown::default();
    // Qoder's cached_tokens is a subset of prompt_tokens. Reuse the Codex
    // breakdown so cached input is displayed without inflating the total.
    token_breakdown.add_codex_usage(raw_usage, total_tokens);

    Some(ParsedAgentUsageEvent {
        session_id: if row.session_id == "unknown" {
            row.id
        } else {
            row.session_id
        },
        timestamp,
        // Keep the provider in the label so generic names such as `auto` do
        // not get merged with models from Codex, Claude, or other agents.
        model: qoder_model_label(row.model_info.as_deref()),
        total_tokens,
        token_breakdown,
    })
}

#[cfg(test)]
fn build_qoder_usage_stats_from_paths(
    database_paths: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    local_provider_stats::build_qoder_stats(database_paths, Vec::new())
}

fn build_qoder_usage_stats() -> Result<AggregatedTranscriptStats, String> {
    local_provider_stats::build_qoder_stats(
        collect_qoder_database_paths(),
        local_provider_stats::qoder_cli_files()?,
    )
}

fn collect_pi_session_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for project in fs::read_dir(root).map_err(|error| format!("读取 Pi 会话目录失败: {error}"))?
    {
        let project = project.map_err(|error| format!("读取 Pi 项目目录失败: {error}"))?;
        if !project
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        for entry in fs::read_dir(project.path())
            .map_err(|error| format!("读取 Pi 项目会话失败: {error}"))?
        {
            let entry = entry.map_err(|error| format!("读取 Pi 会话条目失败: {error}"))?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
            {
                files.push(entry.path());
            }
        }
    }
    Ok(files)
}

fn build_pi_usage_stats_from_files(
    session_files: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    local_provider_stats::build_pi_stats(session_files)
}

fn build_pi_usage_stats() -> Result<AggregatedTranscriptStats, String> {
    let root = env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            crate::agent_paths::user_path(crate::agent_paths::AgentPath::Pi)
                .map(|root| root.join("sessions"))
        })?;
    let files = collect_pi_session_files(&root)?;
    build_pi_usage_stats_from_files(files)
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
    let cache = load_claude_stats_cache()?;
    let files = collect_claude_session_files()?;
    Ok(claude_transcript_stats::reconcile_cache(cache, &files))
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
        .chain(merged_stats.historical_active_dates.iter().cloned())
        .chain(
            merged_stats
                .daily_model_tokens
                .iter()
                .filter(|(_, models)| models.values().any(|tokens| *tokens > 0))
                .map(|(date, _)| date.clone()),
        )
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
        estimated_tokens: merged_stats.estimated_tokens,
        undated_tokens: merged_stats.undated_tokens,
        token_data_incomplete: merged_stats.token_data_incomplete
            || providers
                .iter()
                .any(|provider| provider.last_error.is_some()),
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

    let heatmap = activity_dates
        .iter()
        .map(|date| AgentUsageHeatmapDay {
            date: date.clone(),
            token_count: daily_token_totals.get(date).copied().unwrap_or(0),
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

    match build_antigravity_usage_stats() {
        Ok((stats, estimated, incomplete)) => {
            providers.push(build_provider_summary(
                "antigravity",
                "Antigravity CLI",
                // 本地数据库仍依赖非公开格式，不能因成功解码就宣称完整覆盖。
                "partial",
                if estimated {
                    "~/.gemini/antigravity*/conversations/*.db + transcript activity (estimates excluded from exact totals)"
                } else {
                    "~/.gemini/antigravity*/conversations/*.db (generation token records)"
                },
                &stats,
                incomplete.then(|| "antigravity_usage_incomplete".to_string()),
            ));
            merge_aggregated_stats(&mut aggregate, stats);
        }
        Err(error) => providers.push(build_empty_provider_summary(
            "antigravity",
            "Antigravity CLI",
            "partial",
            "~/.gemini/antigravity*/conversations/*.db",
            Some(error),
        )),
    }
    match build_qoder_usage_stats() {
        Ok(stats) => {
            providers.push(build_provider_summary(
                "qoder",
                "Qoder CLI",
                "partial",
                "Qoder/QoderCN local.db + ~/.qoder{,-cn}/projects/**/*.jsonl (Token availability varies)",
                &stats,
                None,
            ));
            merge_aggregated_stats(&mut aggregate, stats);
        }
        Err(error) => providers.push(build_empty_provider_summary(
            "qoder",
            "Qoder CLI",
            "partial",
            "Qoder/QoderCN local.db + ~/.qoder{,-cn}/projects/**/*.jsonl (Token availability varies)",
            Some(error),
        )),
    }

    match build_pi_usage_stats() {
        Ok(stats) => {
            providers.push(build_provider_summary(
                "pi",
                "Pi",
                "partial",
                "~/.pi/agent/sessions/*/*.jsonl (deduplicated assistant, summary and usage entries)",
                &stats,
                None,
            ));
            merge_aggregated_stats(&mut aggregate, stats);
        }
        Err(error) => providers.push(build_empty_provider_summary(
            "pi",
            "Pi",
            "partial",
            "~/.pi/agent/sessions/*/*.jsonl (deduplicated assistant, summary and usage entries)",
            Some(error),
        )),
    }

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

fn is_termflow_managed_claude_hook(action: &Value) -> bool {
    action
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains("termflow-hook.cjs"))
}

fn remove_termflow_managed_claude_hooks(settings: &mut Value) -> usize {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };

    let event_names = hooks.keys().cloned().collect::<Vec<_>>();
    let mut removed_count = 0;
    for event_name in event_names {
        let Some(entries) = hooks.get_mut(&event_name).and_then(Value::as_array_mut) else {
            continue;
        };
        entries.retain_mut(|entry| {
            let Some(actions) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let previous_len = actions.len();
            actions.retain(|action| !is_termflow_managed_claude_hook(action));
            removed_count += previous_len - actions.len();
            !actions.is_empty()
        });
        if entries.is_empty() {
            hooks.remove(&event_name);
        }
    }

    removed_count
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

    let mut action = json!({
        "type": entry.action_type,
        "command": entry.command,
    });
    // 用户未指定超时时保留 CLI 默认行为；仅托管 Hook 显式使用 5 秒。
    if let Some(timeout) = entry.timeout {
        action["timeout"] = json!(timeout);
    }
    event_array.push(json!({
        "matcher": entry.matcher,
        "hooks": [action]
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

    CLAUDE_REQUIRED_STATUS_EVENTS
        .iter()
        .map(|event| StoredHookEntry {
            event: (*event).to_string(),
            matcher: if matches!(
                *event,
                "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionDenied"
            ) {
                "*"
            } else {
                ""
            }
            .to_string(),
            action_type: "command".to_string(),
            command: format!(
                "node \"{}\" {}",
                hook_script_str,
                event.to_ascii_lowercase()
            ),
            timeout: Some(5),
        })
        .collect()
}

fn get_claude_hook_script_path() -> Result<PathBuf, String> {
    Ok(
        crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?
            .join("hooks")
            .join("termflow-hook.cjs"),
    )
}

// Retained for a future opt-in usage-status integration. Claude sessions must
// not receive this settings file implicitly.
#[allow(dead_code)]
pub(crate) fn ensure_claude_statusline_bridge() -> Result<PathBuf, String> {
    let bridge_dir =
        crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?.join("hooks");
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
  const candidates = [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')];
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
  sessionstart: 'session_start',
  userpromptsubmit: 'user_prompt_submit',
  stop: 'assistant_complete',
  subagentstart: 'subagent_start',
  subagentstop: 'subagent_stop',
  permissionrequest: 'permission_request',
  pretooluse: 'pre_tool_use',
  posttooluse: 'post_tool_use',
  posttoolusefailure: 'post_tool_use_failure',
  permissiondenied: 'permission_denied',
  stopfailure: 'process_error',
  elicitation: 'waiting_input',
  elicitationresult: 'working',
  sessionend: 'session_end',
};

// A child failure must not mark the parent session as failed.
if (input.agent_id && ['stopfailure', 'sessionend'].includes(hookName)) process.exit(0);
const eventType = eventTypeByHook[hookName];
const stateByHook = {
  sessionstart: 'waiting',
  userpromptsubmit: 'running',
  stop: 'completed',
  subagentstart: 'running',
  subagentstop: 'running',
  permissionrequest: 'waiting',
  pretooluse: 'running',
  posttooluse: 'running',
  posttoolusefailure: 'running',
  permissiondenied: 'running',
  stopfailure: 'error',
  elicitation: 'waiting',
  elicitationresult: 'running',
  sessionend: 'waiting',
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
const hasToolContext = toolName.length > 0 && ['pretooluse', 'permissionrequest', 'permissiondenied', 'posttooluse', 'posttoolusefailure'].includes(hookName);
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

fn collect_pi_extension_record(scope: &str, config_path: &Path) -> Result<Vec<HookRecord>, String> {
    let content = match fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 Pi 状态扩展失败: {error}")),
    };
    Ok(vec![HookRecord {
        info: HookInfo {
            agent: "pi".to_string(),
            id: build_hook_id(scope, "extension:event", "", &display_path(config_path)),
            name: "Pi Status Extension".to_string(),
            enabled: true,
            scope: scope.to_string(),
            event: "extension:event".to_string(),
            matcher: String::new(),
            command: display_path(config_path),
            command_preview: "termflow-agent-status.js".to_string(),
            timeout: None,
            config_path: display_path(config_path),
            updated_at: resolve_updated_at(config_path),
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
        "pi" => collect_pi_extension_record(scope, &config_path),
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
    if scope != "user" {
        return Err("Termflow 默认 Hook 只允许安装到全局用户配置".to_string());
    }
    if agent == "claude" {
        return repair_claude_hooks(scope, project_path);
    }
    super::agent_hooks::ensure_agent_status_hook_blocking(agent.to_string())?;
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
    if scope != "user" {
        return Err("Termflow 默认 Hook 只允许安装到全局用户配置".to_string());
    }
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
pub fn migrate_workspace_claude_hooks(
    project_path: String,
) -> Result<WorkspaceHookMigrationResult, String> {
    if project_path.trim().is_empty() {
        return Err("当前未打开项目，无法迁移项目级 Hook".to_string());
    }

    repair_claude_hooks("user".to_string(), Some(project_path.clone()))?;

    let config_path = get_scope_config_path("workspace", Some(&project_path))?;
    let mut settings = read_settings(&config_path)?;
    let removed_count = remove_termflow_managed_claude_hooks(&mut settings);
    if removed_count > 0 {
        write_settings(&config_path, &settings)?;
        remove_legacy_disabled_hooks_file(&config_path)?;
    }

    Ok(WorkspaceHookMigrationResult {
        removed_count,
        catalog: list_claude_hooks(Some(project_path))?,
    })
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
pub async fn get_claude_usage_overview() -> Result<AgentUsageOverview, String> {
    // 兼容旧概览入口，同样避免历史文件扫描阻塞窗口响应。
    tauri::async_runtime::spawn_blocking(build_claude_usage_overview)
        .await
        .map_err(|error| format!("Claude 用量概览任务失败: {error}"))?
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
    fn pi_catalog_uses_global_and_project_extension_paths() {
        assert_eq!(normalize_hook_agent("pi").unwrap(), "pi");
        assert_eq!(
            get_agent_scope_config_path("pi", "user", None).unwrap(),
            crate::agent_paths::user_path(crate::agent_paths::AgentPath::Pi)
                .unwrap()
                .join("extensions")
                .join("termflow-agent-status.js")
        );
        assert_eq!(
            get_agent_scope_config_path("pi", "workspace", Some("project")).unwrap(),
            normalize_input_path("project")
                .join(".pi")
                .join("extensions")
                .join("termflow-agent-status.js")
        );
        assert!(get_agent_scope_config_path("pi", "workspace", None).is_err());
    }

    #[test]
    fn pi_catalog_reads_source_and_keeps_scope_identities_separate() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("termflow-agent-status.js");
        assert!(collect_pi_extension_record("user", &path)
            .unwrap()
            .is_empty());
        let source = "// Termflow managed Pi status extension\nexport default function(pi) {}";
        fs::write(&path, source).unwrap();
        let user = collect_pi_extension_record("user", &path).unwrap();
        let project = collect_pi_extension_record("workspace", &path).unwrap();
        assert_eq!(user.len(), 1);
        assert_eq!(user[0].info.agent, "pi");
        assert_eq!(user[0].info.scope, "user");
        assert_ne!(user[0].info.id, project[0].info.id);
        assert_eq!(user[0].raw_config, Value::String(source.into()));
        assert_eq!(user[0].info.command, display_path(&path));
        assert!(user[0].info.updated_at.is_some());
        // 无法读取的路径不能伪装成“未安装”。
        assert!(collect_pi_extension_record("user", temp.path()).is_err());
    }

    #[test]
    fn pi_usage_reads_assistant_messages_and_separate_cache_tokens() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("--project--");
        fs::create_dir(&project).unwrap();
        let path = project.join("session.jsonl");
        let records = [
            json!({"type":"session","id":"pi-session","timestamp":"2026-09-01T00:00:00Z"}),
            json!({"type":"model_change","modelId":"ignored","timestamp":"2026-09-01T00:01:00Z"}),
            json!({"type":"message","timestamp":"2026-09-01T00:02:00Z","message":{"role":"user","content":"hello"}}),
            json!({"type":"message","timestamp":"2026-09-01T00:03:00Z","message":{"role":"assistant","model":"model-a","usage":{"input":10,"output":5,"cacheRead":20,"cacheWrite":3,"reasoning":2,"totalTokens":38}}}),
            json!({"type":"message","timestamp":"2026-09-01T00:04:00Z","message":{"role":"assistant","model":"model-b","usage":{"input":4,"output":6,"cacheRead":0,"cacheWrite":0,"reasoning":1,"totalTokens":10}}}),
            json!({"type":"message","timestamp":"2026-09-01T00:05:00Z","message":{"role":"assistant","model":"model-b","usage":{"input":0,"output":0,"totalTokens":0}}}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let files = collect_pi_session_files(root.path()).unwrap();
        assert_eq!(files, vec![path]);
        let stats = build_pi_usage_stats_from_files(files).unwrap();
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.total_tokens(), 48);
        assert_eq!(stats.model_usage["model-a"].total_tokens(), 38);
        assert_eq!(stats.model_usage["model-b"].total_tokens(), 10);
        assert_eq!(stats.token_breakdown.input_tokens, 14);
        assert_eq!(stats.token_breakdown.output_tokens, 8);
        assert_eq!(stats.token_breakdown.reasoning_output_tokens, 3);
        assert_eq!(stats.token_breakdown.cache_read_tokens, 20);
        assert_eq!(stats.token_breakdown.cache_creation_tokens, 3);
        assert_eq!(stats.token_breakdown.total_tokens, 48);
        let date = local_date_string(&parse_timestamp_utc("2026-09-01T00:03:00Z").unwrap());
        assert_eq!(stats.daily_model_tokens[&date]["model-a"], 38);
        assert_eq!(stats.daily_model_tokens[&date]["model-b"], 10);
    }

    #[test]
    fn pi_usage_ignores_missing_session_root_and_malformed_records() {
        let root = tempfile::tempdir().unwrap();
        assert!(collect_pi_session_files(&root.path().join("missing"))
            .unwrap()
            .is_empty());
        let project = root.path().join("--project--");
        fs::create_dir(&project).unwrap();
        let path = project.join("session.jsonl");
        fs::write(&path, "not json\n{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"model\":\"model-a\",\"usage\":{\"totalTokens\":10}}}").unwrap();
        let stats = build_pi_usage_stats_from_files(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 0);
        assert_eq!(stats.total_sessions, 0);
    }

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
                "PermissionDenied",
                "StopFailure",
                "Elicitation",
                "ElicitationResult",
                "SessionEnd",
                "PostToolUse",
                "PostToolUseFailure",
                "PreToolUse",
                "SessionStart",
                "Stop",
                "SubagentStart",
                "SubagentStop",
                "UserPromptSubmit",
            ])
        );
        assert!(entries.iter().all(|entry| entry.timeout == Some(5)));
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
        assert!(entries
            .iter()
            .find(|entry| entry.event == "SessionStart")
            .is_some_and(|entry| entry.matcher.is_empty()));
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
        assert!(script.contains("sessionstart: 'session_start'"));
        assert!(script.contains("sessionstart: 'waiting'"));
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
    fn restored_user_hook_preserves_timeout_policy() {
        let mut entry = default_hook_entries_for_path(Path::new("C:/termflow-hook.cjs")).remove(0);
        entry.command = "node user-hook.js".to_string();
        for timeout in [None, Some(120)] {
            entry.timeout = timeout;
            let mut settings = json!({});
            insert_hook(&mut settings, &entry).unwrap();
            let action = &settings["hooks"][&entry.event][0]["hooks"][0];
            assert_eq!(action.get("timeout").and_then(Value::as_u64), timeout);
        }
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
    fn removing_workspace_managed_hooks_preserves_user_actions() {
        let mut settings = json!({
            "hooks": {
                "PostToolUse": [{
                    "matcher": "*",
                    "hooks": [
                        {"type": "command", "command": "node C:/Users/test/.claude/hooks/termflow-hook.cjs posttooluse"},
                        {"type": "command", "command": "node user-hook.js"}
                    ]
                }],
                "Stop": [{
                    "hooks": [{"type": "command", "command": "node C:/Users/test/.claude/hooks/termflow-hook.cjs stop"}]
                }]
            }
        });

        let removed = remove_termflow_managed_claude_hooks(&mut settings);

        assert_eq!(removed, 2);
        assert_eq!(
            settings["hooks"]["PostToolUse"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "node user-hook.js"
        );
        assert!(settings["hooks"].get("Stop").is_none());
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
            ..CodexUsageParseContext::default()
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
    fn opencode_data_directory_uses_xdg_or_home_on_every_platform() {
        let home = PathBuf::from("user-home");
        assert_eq!(
            resolve_opencode_data_home(None, Some(home.clone())),
            home.join(".local").join("share")
        );
        assert_eq!(
            resolve_opencode_data_home(Some(PathBuf::from("custom-data")), Some(home.clone())),
            PathBuf::from("custom-data")
        );
        assert_eq!(
            resolve_opencode_data_home(Some(PathBuf::new()), Some(home.clone())),
            home.join(".local").join("share")
        );
    }

    #[test]
    fn opencode_database_discovery_respects_absolute_relative_and_memory_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let default = directory.path().join("opencode.db");
        let custom = directory.path().join("custom.db");
        fs::write(&default, []).unwrap();
        fs::write(&custom, []).unwrap();
        assert_eq!(
            collect_opencode_database_paths_at(directory.path(), None),
            vec![default]
        );
        assert_eq!(
            collect_opencode_database_paths_at(directory.path(), Some(PathBuf::from("custom.db"))),
            vec![custom.clone()]
        );
        assert_eq!(
            collect_opencode_database_paths_at(directory.path(), Some(custom.clone())),
            vec![custom]
        );
        assert!(collect_opencode_database_paths_at(
            directory.path(),
            Some(PathBuf::from(":memory:"))
        )
        .is_empty());
    }

    fn create_opencode_usage_fixture(path: &Path, include_second_message: bool) {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT, time_created INTEGER, time_updated INTEGER,
                tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO session VALUES ('session-a', 'provider/model-a', 1788264000000, 1788436800000, 30, 3, 0, 50, 7);"
        ).unwrap();
        for (id, timestamp, input, output, cache_read, cache_write) in [
            ("m1", 1_788_264_000_000_i64, 10, 1, 20, 2),
            ("m2", 1_788_350_400_000_i64, 20, 2, 30, 5),
        ] {
            if id == "m2" && !include_second_message {
                continue;
            }
            let data = json!({"role":"assistant", "modelID":"model-a", "providerID":"provider",
                "time":{"created":timestamp}, "tokens":{"input":input,"output":output,"reasoning":0,"cache":{"read":cache_read,"write":cache_write}}});
            connection
                .execute(
                    "INSERT INTO message VALUES (?1, 'session-a', ?2, ?3)",
                    rusqlite::params![id, timestamp, data.to_string()],
                )
                .unwrap();
        }
    }

    #[test]
    fn opencode_requests_keep_actual_dates_and_do_not_add_session_totals_twice() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        create_opencode_usage_fixture(&path, true);
        let stats = build_opencode_usage_stats_from_paths(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 90);
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.daily_model_tokens.len(), 2);
        assert_eq!(
            stats
                .daily_model_tokens
                .values()
                .map(|models| models.values().sum::<u64>())
                .collect::<Vec<_>>(),
            vec![33, 57]
        );
        assert_eq!(stats.token_breakdown.cache_creation_tokens, 7);
        assert_eq!(stats.undated_tokens, 0);
    }

    #[test]
    fn opencode_partial_request_history_preserves_only_the_undated_remainder() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        create_opencode_usage_fixture(&path, false);
        let stats = build_opencode_usage_stats_from_paths(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 90);
        assert_eq!(stats.total_messages, 1);
        assert_eq!(stats.undated_tokens, 57);
        assert!(stats.token_data_incomplete);
        assert_eq!(
            stats
                .model_usage
                .get("unknown")
                .map(ClaudeStatsModelUsage::total_tokens),
            Some(57)
        );
        assert_eq!(
            stats
                .daily_model_tokens
                .values()
                .flat_map(|models| models.values())
                .sum::<u64>(),
            33
        );
    }

    #[test]
    fn opencode_duplicate_databases_do_not_repeat_requests_or_session_remainders() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.db");
        let second = directory.path().join("second.db");
        create_opencode_usage_fixture(&first, false);
        fs::copy(&first, &second).unwrap();
        let stats = build_opencode_usage_stats_from_paths(vec![first, second]).unwrap();
        assert_eq!(stats.total_tokens(), 90);
        assert_eq!(stats.total_messages, 1);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.undated_tokens, 57);
    }

    #[test]
    fn opencode_session_only_cache_writes_are_preserved_without_fabricated_daily_events() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT, time_created INTEGER, tokens_cache_write INTEGER);
            INSERT INTO session VALUES ('write-only', 1788264000000, 12);",
            )
            .unwrap();
        drop(connection);
        let stats = build_opencode_usage_stats_from_paths(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 12);
        assert_eq!(stats.token_breakdown.cache_creation_tokens, 12);
        assert_eq!(stats.total_messages, 0);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.undated_tokens, 12);
        assert!(stats.daily_model_tokens.is_empty());
        assert!(stats.hour_counts.is_empty());
    }

    #[test]
    fn opencode_session_v2_and_legacy_tables_prefer_the_new_projection_per_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(r#"CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, tokens_input INTEGER);
            CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, tokens_input INTEGER);
            CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
            INSERT INTO session_v2 VALUES ('migrated', 1788264000000, 10);
            INSERT INTO session VALUES ('migrated', 1788264000000, 999);
            INSERT INTO session VALUES ('legacy-only', 1788264000000, 20);
            INSERT INTO session_message VALUES ('new-message', 'migrated', 'assistant', 1788264000000, '{"tokens":{"input":10}}');
            INSERT INTO message VALUES ('old-message', 'migrated', 1788264000000, '{"role":"assistant","tokens":{"input":999}}');
            INSERT INTO message VALUES ('legacy-message', 'legacy-only', 1788264000000, '{"role":"assistant","tokens":{"input":20}}');"#).unwrap();
        drop(connection);
        let stats = build_opencode_usage_stats_from_paths(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 30);
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.undated_tokens, 0);
    }

    #[test]
    fn opencode_v2_forks_do_not_recount_copied_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(r#"CREATE TABLE session_v2 (id TEXT PRIMARY KEY, fork_session_id TEXT, time_created INTEGER, tokens_input INTEGER);
            CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
            INSERT INTO session_v2 VALUES ('original', NULL, 1788264000000, 10);
            INSERT INTO session_v2 VALUES ('fork', 'original', 1788350400000, 5);
            INSERT INTO session_message VALUES ('original-message', 'original', 'assistant', 1788264000000, '{"tokens":{"input":10}}');
            INSERT INTO session_message VALUES ('copied-message', 'fork', 'assistant', 1788264000000, '{"tokens":{"input":10}}');
            INSERT INTO session_message VALUES ('fresh-message', 'fork', 'assistant', 1788350400000, '{"tokens":{"input":5}}');"#).unwrap();
        drop(connection);
        let stats = build_opencode_usage_stats_from_paths(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 15);
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.undated_tokens, 0);
    }

    #[test]
    fn opencode_zero_token_requests_still_count_as_recorded_activity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(r#"CREATE TABLE session (id TEXT PRIMARY KEY);
            CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
            INSERT INTO session VALUES ('zero');
            INSERT INTO session_message VALUES ('zero-message', 'zero', 'assistant', 1788264000000, '{"tokens":{"input":0,"cache":{"write":0}}}');"#).unwrap();
        drop(connection);
        let stats = build_opencode_usage_stats_from_paths(vec![path]).unwrap();
        assert_eq!(stats.total_tokens(), 0);
        assert_eq!(stats.total_messages, 1);
        assert_eq!(stats.total_sessions, 1);
    }

    #[test]
    fn parse_opencode_cache_write_only_usage_is_not_lost_or_classified_as_other() {
        let row = OpenCodeUsageRow {
            id: "write-only".to_string(),
            session_id: "session".to_string(),
            time_created: Some(1_788_264_000_000),
            time_updated: None,
            session_model: None,
            data: json!({"tokens":{"cache":{"write":3}}}).to_string(),
            is_session_total: false,
        };
        let event = parse_opencode_usage_row(row).unwrap();
        assert_eq!(event.total_tokens, 3);
        assert_eq!(event.token_breakdown.cache_creation_tokens, 3);
        assert_eq!(event.token_breakdown.other_tokens, 0);
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
            is_session_total: false,
        };

        let event = parse_opencode_usage_row(row).unwrap();

        assert_eq!(event.total_tokens, 140);
        assert_eq!(event.token_breakdown.input_tokens, 20);
        assert_eq!(event.token_breakdown.output_tokens, 25);
        assert_eq!(event.token_breakdown.cache_read_tokens, 80);
        assert_eq!(event.token_breakdown.reasoning_output_tokens, 15);
        assert_eq!(event.token_breakdown.total_tokens, event.total_tokens);
    }

    #[test]
    fn reads_qoder_token_info_without_double_counting_cached_input() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("local.db");
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE chat_message (
                    id TEXT,
                    session_id TEXT,
                    role TEXT,
                    token_info TEXT,
                    model_info TEXT,
                    gmt_create INTEGER
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO chat_message (id, session_id, role, token_info, model_info, gmt_create)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    "message-1",
                    "session-1",
                    "assistant",
                    r#"{"prompt_tokens":1200,"cached_tokens":800,"completion_tokens":200}"#,
                    r#"{"model_key":"qoder-max"}"#,
                    1_752_109_300_000_i64,
                ],
            )
            .unwrap();
        drop(connection);

        let stats = build_qoder_usage_stats_from_paths(vec![database_path]).unwrap();

        assert_eq!(stats.total_tokens(), 1_400);
        assert_eq!(stats.total_messages(), 1);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.token_breakdown.input_tokens, 400);
        assert_eq!(stats.token_breakdown.cache_read_tokens, 800);
        assert_eq!(stats.token_breakdown.output_tokens, 200);
        assert_eq!(stats.token_breakdown.total_tokens, 1_400);
        assert_eq!(stats.daily_model_tokens.len(), 1);
        assert_eq!(
            stats
                .daily_model_tokens
                .values()
                .next()
                .and_then(|models| models.get("Qoder / qoder-max")),
            Some(&1_400)
        );
    }

    #[test]
    fn prefixes_qoder_model_labels_to_avoid_cross_provider_merging() {
        assert_eq!(
            qoder_model_label(Some(r#"{"model_key":"auto"}"#)),
            "Qoder / auto"
        );
        assert_eq!(qoder_model_label(None), "Qoder / agent");
    }

    #[test]
    fn estimates_antigravity_transcript_usage_without_persisting_transcript_content() {
        let directory = tempfile::tempdir().unwrap();
        let variant_directory = directory.path().join("antigravity-cli");
        let transcript_path = variant_directory
            .join("brain")
            .join("session-1")
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        fs::create_dir_all(transcript_path.parent().unwrap()).unwrap();
        fs::write(
            variant_directory.join("settings.json"),
            r#"{"model":"Gemini 2.5 Pro"}"#,
        )
        .unwrap();
        fs::write(
            &transcript_path,
            concat!(
                r#"{"type":"USER_INPUT","content":"abcdefgh","created_at":"2026-08-19T00:00:00Z"}"#,
                "\n",
                r#"{"type":"PLANNER_RESPONSE","content":"abcd","thinking":"efgh","created_at":"2026-08-19T00:01:00Z"}"#,
                "\n"
            ),
        )
        .unwrap();

        let stats = build_antigravity_usage_stats_from_files(vec![transcript_path]).unwrap();

        assert_eq!(estimate_antigravity_tokens("abcde"), 2);
        assert_eq!(estimate_antigravity_tokens("中文"), 2);
        assert_eq!(stats.total_tokens(), 0);
        assert_eq!(stats.estimated_tokens, 4);
        assert!(stats.token_data_incomplete);
        assert_eq!(stats.total_messages(), 1);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.token_breakdown.total_tokens, 0);
        assert_eq!(
            stats
                .daily_model_tokens
                .values()
                .next()
                .and_then(|models| models.get("gemini-2.5-pro")),
            None
        );
    }
    #[test]
    fn antigravity_database_replaces_transcript_and_preserves_legacy_fallback() {
        let home = tempfile::tempdir().expect("home");
        let variant = home.path().join("antigravity-cli");
        let db_path = variant.join("conversations/session.db");
        let _db = crate::database::antigravity::tests::create_database(&db_path);
        fs::write(
            variant.join("settings.json"),
            r#"{"model":"Gemini 3.8 Flash"}"#,
        )
        .expect("settings");
        let transcript = |id: &str| {
            let logs = variant
                .join("brain")
                .join(id)
                .join(".system_generated/logs");
            fs::create_dir_all(&logs).expect("logs");
            fs::write(logs.join("transcript_full.jsonl"), concat!(
                r#"{"type":"USER_INPUT","content":"abcdefgh","created_at":"2026-09-15T00:00:00Z"}"#, "\n",
                r#"{"type":"PLANNER_RESPONSE","content":"abcd","created_at":"2026-09-15T00:01:00Z"}"#, "\n"
            )).expect("transcript");
        };
        transcript("session");
        let (stats, estimated, _) = build_antigravity_usage_stats_at(home.path()).expect("stats");
        assert_eq!(stats.total_tokens(), 1130);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.token_breakdown.cache_read_tokens, 1000);
        assert!(!estimated);
        transcript("legacy");
        let (stats, estimated, _) = build_antigravity_usage_stats_at(home.path()).expect("stats");
        assert_eq!(stats.total_tokens(), 1130);
        assert_eq!(stats.estimated_tokens, 3);
        assert!(stats.token_data_incomplete);
        assert_eq!(stats.total_sessions, 2);
        assert!(estimated);
        assert_eq!(
            stats
                .daily_model_tokens
                .values()
                .flat_map(|models| models.values())
                .sum::<u64>(),
            1130
        );
    }

    #[test]
    #[ignore = "Manually reads local Antigravity usage; prints aggregate counts only"]
    fn antigravity_local_database_diagnostic() {
        let (stats, estimated, incomplete) = build_antigravity_usage_stats().expect("local usage");
        println!("Antigravity: tokens={}, cache={}, sessions={}, generations={}, estimated={}, incomplete={}",
            stats.total_tokens(), stats.token_breakdown.cache_read_tokens, stats.total_sessions,
            stats.total_messages(), estimated, incomplete);
        assert_eq!(stats.total_tokens(), stats.token_breakdown.total_tokens);
    }
}
