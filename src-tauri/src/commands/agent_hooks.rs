use crate::qoder_config::qoder_user_config_root;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MANAGED_SCRIPT_NAME: &str = "termflow-agent-hook.cjs";
const ANTIGRAVITY_STATUSLINE_SCRIPT_NAME: &str = "termflow-antigravity-statusline.cjs";
const ANTIGRAVITY_STATUSLINE_MARKER: &str = "termflow-antigravity-statusline.cjs";
const ANTIGRAVITY_ORIGINAL_STATUSLINE_NAME: &str = "antigravity-statusline-original.json";
const OWNED_MARKER: &str = "termflow-agent-hook.cjs";
const ANTIGRAVITY_HOOK_GROUP: &str = "termflow-agent-status";
const TRUST_BEGIN: &str = "# BEGIN TERMFLOW AGENT STATUS HOOKS";
const TRUST_END: &str = "# END TERMFLOW AGENT STATUS HOOKS";
const QODER_HOOK_EVENTS: [&str; 11] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "Elicitation",
    "ElicitationResult",
    "Stop",
    "StopFailure",
];
static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn supports_agent_status_hook(agent_id: &str) -> bool {
    matches!(
        agent_id,
        "claude" | "codex" | "qoder" | "antigravity" | "opencode"
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    pub agent: String,
    pub configured: bool,
    pub config_path: String,
    pub detail: Option<String>,
}

#[tauri::command]
pub fn ensure_agent_status_hook(agent_id: String) -> Result<AgentHookStatus, String> {
    let _guard = INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Agent Hook 安装锁不可用".to_string())?;
    match agent_id.as_str() {
        "claude" => super::claude_config::configure_claude_hook().map(|status| AgentHookStatus {
            agent: agent_id,
            configured: status.configured,
            config_path: status.config_path,
            detail: None,
        }),
        "codex" => install_codex_hook(),
        "qoder" => install_qoder_hook(),
        "antigravity" => install_antigravity_hook(),
        "opencode" => install_opencode_plugin(),
        _ => Ok(AgentHookStatus {
            agent: agent_id,
            configured: false,
            config_path: String::new(),
            detail: Some("该终端类型不需要 Agent 状态 Hook".to_string()),
        }),
    }
}

fn managed_script_path() -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or("无法读取用户主目录")?;
    Ok(home
        .join(".termflow")
        .join("agent-hooks")
        .join(MANAGED_SCRIPT_NAME))
}

fn write_managed_script() -> Result<PathBuf, String> {
    let path = managed_script_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 Agent Hook 目录失败: {error}"))?;
    }
    write_if_changed(&path, managed_hook_script().as_bytes())?;
    Ok(path)
}

fn install_codex_hook() -> Result<AgentHookStatus, String> {
    let home = dirs_next::home_dir().ok_or("无法读取用户主目录")?;
    let config_path = home.join(".codex").join("hooks.json");
    let toml_path = home.join(".codex").join("config.toml");
    let script_path = write_managed_script()?;
    let command = node_command(&script_path, "codex", None);
    let events = [
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "Stop",
    ];
    let mut config = read_json_object(&config_path)?;
    remove_owned_json_hooks(&mut config, &["SessionStart"])?;
    install_json_hooks(&mut config, &events, &command, 10, "")?;
    write_json(&config_path, &config)?;
    remove_legacy_codex_trust(&toml_path)?;
    Ok(AgentHookStatus {
        agent: "codex".into(),
        configured: true,
        config_path: config_path.to_string_lossy().into_owned(),
        detail: Some(
            "已通过原生 Hooks 接入完整授权生命周期，并按 tool_use_id/执行者关联恢复状态".into(),
        ),
    })
}

fn install_qoder_hook() -> Result<AgentHookStatus, String> {
    let config_path = qoder_user_config_root()?.join("settings.json");
    let script_path = write_managed_script()?;
    let command = node_command(&script_path, "qoder", None);
    let mut config = read_json_object(&config_path)?;
    install_json_hooks(&mut config, &QODER_HOOK_EVENTS, &command, 10, "*")?;
    write_json(&config_path, &config)?;
    Ok(AgentHookStatus {
        agent: "qoder".into(),
        configured: true,
        config_path: config_path.to_string_lossy().into_owned(),
        detail: Some(
            "Qoder CLI status is connected through its native lifecycle, permission, elicitation, stop, and failure hooks."
                .into(),
        ),
    })
}

fn install_antigravity_hook() -> Result<AgentHookStatus, String> {
    let home = dirs_next::home_dir().ok_or("无法读取用户主目录")?;
    let config_path = home.join(".gemini").join("config").join("hooks.json");
    let script_path = write_managed_script()?;
    let pre_invocation_command = node_command(&script_path, "antigravity", Some("PreInvocation"));
    let stop_command = node_command(&script_path, "antigravity", Some("Stop"));
    let mut config = read_json_object(&config_path)?;
    install_antigravity_hook_group(&mut config, &pre_invocation_command, &stop_command)?;
    write_json(&config_path, &config)?;
    install_antigravity_statusline(&home)?;
    remove_legacy_gemini_hook()?;
    Ok(AgentHookStatus {
        agent: "antigravity".into(),
        configured: true,
        config_path: config_path.to_string_lossy().into_owned(),
        detail: Some(
            "Antigravity CLI 已通过 PreInvocation/Stop 原生 Hook 接入运行、完成和错误状态；官方 Hook 暂无独立权限等待事件"
                .into(),
        ),
    })
}

fn install_antigravity_statusline(home: &Path) -> Result<(), String> {
    let managed_root = home.join(".termflow").join("agent-hooks");
    let script_path = managed_root.join(ANTIGRAVITY_STATUSLINE_SCRIPT_NAME);
    let original_path = managed_root.join(ANTIGRAVITY_ORIGINAL_STATUSLINE_NAME);
    let settings_path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("settings.json");
    write_if_changed(&script_path, antigravity_statusline_script().as_bytes())?;
    let mut settings = read_json_object(&settings_path)?;
    let command = node_statusline_command(&script_path);
    install_antigravity_statusline_config(&mut settings, &command, &original_path)?;
    write_json(&settings_path, &settings)
}

fn install_antigravity_statusline_config(
    settings: &mut Value,
    command: &str,
    original_path: &Path,
) -> Result<(), String> {
    let root = settings
        .as_object_mut()
        .ok_or("Antigravity settings.json 的根节点必须是对象")?;
    if let Some(existing) = root.get("statusLine") {
        let is_owned = existing
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|value| value.contains(ANTIGRAVITY_STATUSLINE_MARKER));
        if !is_owned {
            write_json(original_path, existing)?;
        }
    }
    root.insert(
        "statusLine".into(),
        json!({
            "type": "command",
            "command": command,
            "enabled": true,
            "stack_with_default": true,
        }),
    );
    Ok(())
}

fn node_statusline_command(script: &Path) -> String {
    // Antigravity 1.1.26 tokenizes this setting itself on Windows and keeps
    // double quotes as literal filename characters. The managed path normally
    // has no spaces, so use a slash-normalized, unquoted command.
    format!("node {}", script.to_string_lossy().replace('\\', "/"))
}

fn antigravity_statusline_script() -> &'static str {
    r#"#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const originalPath = path.join(__dirname, 'antigravity-statusline-original.json');
const snapshotPath = path.join(__dirname, 'antigravity-usage.json');
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let input = {};
try { input = raw ? JSON.parse(raw) : {}; } catch {}
const definitions = {
  'gemini-5h': ['Gemini', 'session'],
  'gemini-weekly': ['Gemini', 'weekly'],
  '3p-5h': ['Claude and GPT', 'session'],
  '3p-weekly': ['Claude and GPT', 'weekly'],
};
const windows = [];
for (const [id, definition] of Object.entries(definitions)) {
  const value = input.quota && input.quota[id];
  const fraction = Number(value && value.remaining_fraction);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
  windows.push({ id, scope: definition[0], window: definition[1], remainingPercent: Math.round(fraction * 10000) / 100, resetDescription: typeof value.reset_time === 'string' ? value.reset_time : null });
}
if (input.quota && typeof input.quota === 'object' && snapshotPath) {
  const snapshot = {
    version: 1,
    accountHash: typeof input.email === 'string' ? crypto.createHash('sha256').update(input.email.trim().toLowerCase()).digest('hex') : null,
    planTier: typeof input.plan_tier === 'string' ? input.plan_tier : null,
    windows,
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const temporary = `${snapshotPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, snapshotPath);
  } catch {}
}
try {
  if (originalPath && fs.existsSync(originalPath)) {
    const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
    if (original && original.type === 'command' && typeof original.command === 'string') {
      const result = childProcess.spawnSync(original.command, { shell: true, input: raw, encoding: 'utf8' });
      if (result.stdout) process.stdout.write(result.stdout);
    }
  }
} catch {}
"#
}

fn install_antigravity_hook_group(
    config: &mut Value,
    pre_invocation_command: &str,
    stop_command: &str,
) -> Result<(), String> {
    let root = config
        .as_object_mut()
        .ok_or("Antigravity hooks.json 的根节点必须是对象")?;
    if let Some(existing) = root.get(ANTIGRAVITY_HOOK_GROUP) {
        if !value_contains_owned_command(existing) {
            return Err(format!(
                "Antigravity Hook 名称 {ANTIGRAVITY_HOOK_GROUP} 已被用户配置占用"
            ));
        }
    }
    root.insert(
        ANTIGRAVITY_HOOK_GROUP.to_string(),
        json!({
            "PreInvocation": [{
                "type": "command",
                "command": pre_invocation_command,
                "timeout": 10,
            }],
            "Stop": [{
                "type": "command",
                "command": stop_command,
                "timeout": 10,
            }],
        }),
    );
    Ok(())
}

fn remove_legacy_gemini_hook() -> Result<(), String> {
    let Some(home) = dirs_next::home_dir() else {
        return Ok(());
    };
    let path = home.join(".gemini").join("settings.json");
    if !path.exists() {
        return Ok(());
    }
    let mut config = read_json_object(&path)?;
    let previous = config.clone();
    remove_owned_json_hooks(
        &mut config,
        &["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"],
    )?;
    if config != previous {
        write_json(&path, &config)?;
    }
    Ok(())
}

fn install_opencode_plugin() -> Result<AgentHookStatus, String> {
    let config_root = opencode_config_root()?;
    let plugin_path = config_root.join("plugins").join("termflow-status.js");
    if let Some(parent) = plugin_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 OpenCode 插件目录失败: {error}"))?;
    }
    write_if_changed(&plugin_path, opencode_plugin_source().as_bytes())?;
    remove_legacy_opencode_plugin(&plugin_path);
    Ok(AgentHookStatus {
        agent: "opencode".into(),
        configured: true,
        config_path: plugin_path.to_string_lossy().into_owned(),
        detail: Some(
            "已通过官方插件事件接入权限回复与工具生命周期，并按 permissionID/callID 关联恢复状态"
                .into(),
        ),
    })
}

fn opencode_config_root() -> Result<PathBuf, String> {
    resolve_opencode_config_root(
        std::env::var_os("OPENCODE_CONFIG_DIR").map(PathBuf::from),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        dirs_next::home_dir(),
    )
}

fn resolve_opencode_config_root(
    explicit: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        return Ok(path);
    }
    if let Some(path) = xdg_config_home {
        return Ok(path.join("opencode"));
    }
    // OpenCode uses the XDG-style ~/.config/opencode location on Windows too.
    // dirs_next::config_dir() resolves to AppData/Roaming there, which looks
    // plausible but is not scanned by OpenCode.
    home.map(|home| home.join(".config").join("opencode"))
        .ok_or_else(|| "无法读取 OpenCode 配置目录".to_string())
}

fn remove_legacy_opencode_plugin(active_plugin_path: &Path) {
    let Some(legacy_path) = dirs_next::config_dir().map(|path| {
        path.join("opencode")
            .join("plugins")
            .join("termflow-status.js")
    }) else {
        return;
    };
    if legacy_path == active_plugin_path {
        return;
    }
    let owned_source = opencode_plugin_source().as_bytes();
    if fs::read(&legacy_path).ok().as_deref() == Some(owned_source) {
        let _ = fs::remove_file(legacy_path);
    }
}

fn install_json_hooks(
    config: &mut Value,
    events: &[&str],
    command: &str,
    timeout: u64,
    matcher: &str,
) -> Result<(), String> {
    let root = config.as_object_mut().ok_or("Hook 配置根节点必须是对象")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("Hook 配置中的 hooks 必须是对象")?;
    for event in events {
        let definitions = hooks
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        let definitions = definitions
            .as_array_mut()
            .ok_or_else(|| format!("Hook 事件 {event} 必须是数组"))?;
        remove_owned_json_hook_actions(definitions);
        definitions.push(json!({
            "matcher": matcher,
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": timeout,
            }]
        }));
    }
    Ok(())
}

fn remove_owned_json_hooks(config: &mut Value, events: &[&str]) -> Result<(), String> {
    let Some(hooks) = config.get_mut("hooks") else {
        return Ok(());
    };
    let hooks = hooks
        .as_object_mut()
        .ok_or("Hook 配置中的 hooks 必须是对象")?;
    for event in events {
        let Some(definitions) = hooks.get_mut(*event) else {
            continue;
        };
        let definitions = definitions
            .as_array_mut()
            .ok_or_else(|| format!("Hook 事件 {event} 必须是数组"))?;
        remove_owned_json_hook_actions(definitions);
    }
    Ok(())
}

fn remove_owned_json_hook_actions(definitions: &mut Vec<Value>) {
    for definition in definitions.iter_mut() {
        let Some(hooks) = definition.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        hooks.retain(|hook| !hook_action_contains_owned_command(hook));
    }
    definitions.retain(|definition| {
        definition
            .get("hooks")
            .and_then(Value::as_array)
            .map_or(true, |hooks| !hooks.is_empty())
    });
}

fn hook_action_contains_owned_command(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .map(|command| command.replace('\\', "/").contains(OWNED_MARKER))
        .unwrap_or(false)
}

#[cfg(test)]
fn definition_contains_owned_command(definition: &Value) -> bool {
    definition
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| hooks.iter().any(hook_action_contains_owned_command))
        .unwrap_or(false)
}

fn value_contains_owned_command(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (key == "command"
                && value
                    .as_str()
                    .is_some_and(|command| command.replace('\\', "/").contains(OWNED_MARKER)))
                || value_contains_owned_command(value)
        }),
        Value::Array(values) => values.iter().any(value_contains_owned_command),
        _ => false,
    }
}

fn remove_legacy_codex_trust(toml_path: &Path) -> Result<(), String> {
    let Ok(mut content) = fs::read_to_string(toml_path) else {
        return Ok(());
    };
    let Some(start) = content.find(TRUST_BEGIN) else {
        return Ok(());
    };
    let Some(relative_end) = content[start..].find(TRUST_END) else {
        return Ok(());
    };
    let mut end = start + relative_end + TRUST_END.len();
    if content.as_bytes().get(end) == Some(&b'\r') {
        end += 1;
    }
    if content.as_bytes().get(end) == Some(&b'\n') {
        end += 1;
    }
    content.replace_range(start..end, "");
    write_if_changed(toml_path, content.as_bytes())
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} 不是有效 JSON: {error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{} 的根节点必须是对象", path.display()));
    }
    Ok(value)
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    write_if_changed(path, &bytes)
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 {} 失败: {error}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

fn node_command(script_path: &Path, agent: &str, event: Option<&str>) -> String {
    let escaped = script_path.to_string_lossy().replace('"', "\\\"");
    match event {
        Some(event) => format!("node \"{escaped}\" {agent} {event}"),
        None => format!("node \"{escaped}\" {agent}"),
    }
}

fn managed_hook_script() -> &'static str {
    r#"#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const agent = String(process.argv[2] || 'claude').toLowerCase();
const explicitEvent = String(process.argv[3] || '');
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let input = {};
try { input = raw ? JSON.parse(raw) : {}; } catch {}
const eventName = explicitEvent || input.hook_event_name || input.hookEventName || input.event_name || input.eventName || '';
const normalizedEvent = String(eventName).replace(/[^a-z]/gi, '').toLowerCase();
const maps = {
  claude: { userpromptsubmit: 'running', pretooluse: 'running', posttooluse: 'running', permissionrequest: 'waiting', stop: 'completed' },
  codex: { userpromptsubmit: 'running', pretooluse: 'running', posttooluse: 'running', permissionrequest: 'waiting', stop: 'completed' },
  qoder: { sessionstart: 'waiting', userpromptsubmit: 'running', pretooluse: 'running', permissionrequest: 'waiting', permissiondenied: 'running', posttooluse: 'running', posttoolusefailure: 'running', elicitation: 'waiting', elicitationresult: 'running', stop: 'completed', stopfailure: 'error' },
  antigravity: { preinvocation: 'running', stop: 'completed' },
};
const eventTypes = {
  sessionstart: 'session_start',
  userpromptsubmit: 'user_prompt_submit',
  pretooluse: 'pre_tool_use',
  posttooluse: 'post_tool_use',
  posttoolusefailure: 'post_tool_use_failure',
  permissionrequest: 'permission_request',
  permissiondenied: 'permission_denied',
  elicitation: 'waiting_input',
  elicitationresult: 'working',
  stop: 'assistant_complete',
  stopfailure: 'process_error',
  preinvocation: 'working',
};
let state = maps[agent]?.[normalizedEvent];
let eventType = eventTypes[normalizedEvent];
if (agent === 'qoder' && normalizedEvent === 'sessionstart' && String(input.source || '').toLowerCase() === 'compact') {
  state = 'running';
  eventType = 'working';
}
if (agent === 'antigravity' && normalizedEvent === 'stop') {
  const terminationReason = String(input.terminationReason || '').toLowerCase();
  const failed = Boolean(input.error) || terminationReason === 'error' || terminationReason === 'max_steps_exceeded';
  if (failed) {
    state = 'error';
    eventType = 'process_error';
  } else if (input.fullyIdle === false) {
    state = 'running';
    eventType = 'working';
  }
}
if (agent === 'antigravity') {
  process.stdout.write(normalizedEvent === 'stop' ? '{"decision":""}\n' : '{"injectSteps":[]}\n');
}
const port = process.env.TERMFLOW_INGEST_PORT;
const token = process.env.TERMFLOW_INGEST_TOKEN;
if (!state || !port || !token || !process.env.TERMFLOW_SESSION_ID) process.exit(0);
const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};
const digest = (value) => crypto.createHmac('sha256', token).update(stable(value)).digest('hex');
const firstString = (...values) => values.find((value) => typeof value === 'string' && value.length > 0) || '';
const rawToolUseId = firstString(input.tool_use_id, input.toolUseId, input.call_id, input.callID);
const toolUseId = /^[a-zA-Z0-9._:-]{1,256}$/.test(rawToolUseId) ? rawToolUseId : undefined;
const toolName = firstString(input.tool_name, input.toolName);
const toolInput = input.tool_input ?? input.toolInput ?? {};
const actorId = firstString(input.agent_id, input.agentId, input.turn_id, input.turnId);
const actorType = firstString(input.agent_type, input.agentType);
const hasExplicitActor = actorId.length > 0 || actorType.length > 0;
const hasToolContext = toolName.length > 0 && ['pretooluse', 'permissionrequest', 'permissiondenied', 'posttooluse', 'posttoolusefailure'].includes(normalizedEvent);
const correlationPayload = hasToolContext ? {
  ...(toolUseId ? { toolUseId } : {}),
  toolFingerprint: digest({ agent, toolName, toolInput }),
  actorFingerprint: digest({ agent, actorId, actorType }),
  hasExplicitActor,
} : {};
const createdAt = Date.now();
const rawProviderSessionId = firstString(input.session_id, input.sessionId, input.conversationId);
const providerSessionId = /^[a-zA-Z0-9-]{8,128}$/.test(rawProviderSessionId)
  ? rawProviderSessionId
  : undefined;
const payload = JSON.stringify({
  agent,
  state,
  event_type: eventType,
  event_id: `${agent}:${process.env.TERMFLOW_SESSION_ID}:${eventName}:${createdAt}`,
  session_id: process.env.TERMFLOW_SESSION_ID,
  project_path: process.env.TERMFLOW_PROJECT_PATH || process.cwd(),
  source: agent,
  created_at: createdAt,
  provider_session_id: providerSessionId,
  payload: correlationPayload,
});
const req = http.request({ hostname: '127.0.0.1', port: Number(port), path: '/internal/session-events', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-TERMFLOW-TOKEN': token }, timeout: 1200 }, () => process.exit(0));
req.on('error', () => process.exit(0));
req.on('timeout', () => { req.destroy(); process.exit(0); });
req.end(payload);
"#
}

fn opencode_plugin_source() -> &'static str {
    r#"import { createHmac } from 'node:crypto';
let lastState = 'completed';
let lastEventType = 'assistant_complete';
let eventSequence = 0;
const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};
const firstString = (...values) => values.find((value) => typeof value === 'string' && value.length > 0) || '';
const safeId = (value) => /^[a-zA-Z0-9._:-]{1,256}$/.test(value) ? value : undefined;
function digest(value) {
  const token = process.env.TERMFLOW_INGEST_TOKEN;
  return token ? createHmac('sha256', token).update(stable(value)).digest('hex') : '';
}
function correlation({ sessionID, callID, tool, args, permissionID } = {}) {
  const actorFingerprint = digest({ agent: 'opencode', sessionID: firstString(sessionID) });
  const permissionFingerprint = permissionID ? digest({ agent: 'opencode', permissionID }) : '';
  const toolFingerprint = tool ? digest({ agent: 'opencode', tool, args: args ?? {} }) : '';
  return {
    ...(safeId(firstString(callID)) ? { toolUseId: safeId(firstString(callID)) } : {}),
    ...(toolFingerprint ? { toolFingerprint } : {}),
    ...(permissionFingerprint ? { permissionFingerprint } : {}),
    ...(actorFingerprint ? { actorFingerprint } : {}),
    hasExplicitActor: Boolean(firstString(sessionID)),
  };
}
async function post(state, eventType, safePayload = {}) {
  const port = process.env.TERMFLOW_INGEST_PORT;
  const token = process.env.TERMFLOW_INGEST_TOKEN;
  const sessionId = process.env.TERMFLOW_SESSION_ID;
  if (!port || !token || !sessionId) return;
  const createdAt = Date.now();
  eventSequence += 1;
  try {
    await fetch(`http://127.0.0.1:${port}/internal/session-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-termflow-token': token },
      body: JSON.stringify({ agent: 'opencode', state, event_type: eventType, event_id: `opencode:${sessionId}:${eventType}:${createdAt}:${eventSequence}`, session_id: sessionId, project_path: process.env.TERMFLOW_PROJECT_PATH || process.cwd(), source: 'opencode', created_at: createdAt, payload: safePayload }),
      signal: AbortSignal.timeout(1200),
    });
  } catch {}
}
async function setState(state, eventType, safePayload = {}, force = false) {
  if (!force && lastState === state && lastEventType === eventType) return;
  lastState = state;
  lastEventType = eventType;
  await post(state, eventType, safePayload);
}
export const TermflowStatusPlugin = async () => ({
  event: async ({ event }) => {
    if (!event?.type) return;
    const properties = event.properties || {};
    const sessionID = firstString(properties.sessionID, properties.sessionId);
    if (event.type === 'permission.asked' || event.type === 'permission.updated') {
      const permissionID = firstString(properties.id, properties.permissionID, properties.permissionId, properties.requestID, properties.requestId);
      const callID = firstString(properties.callID, properties.callId);
      return setState('waiting', 'permission_request', correlation({ sessionID, callID, permissionID }), true);
    }
    if (event.type === 'permission.replied') {
      const permissionID = firstString(properties.permissionID, properties.permissionId, properties.id, properties.requestID, properties.requestId);
      return setState('running', 'permission_replied', correlation({ sessionID, permissionID }), true);
    }
    if (event.type === 'question.asked') return setState('waiting', 'waiting_input', correlation({ sessionID }), true);
    if (event.type === 'question.replied' || event.type === 'question.rejected') return setState('running', 'working', correlation({ sessionID }), true);
    if (event.type === 'session.error') return setState('error', 'process_error', correlation({ sessionID }));
    if (event.type === 'session.idle') return setState('completed', 'assistant_complete', correlation({ sessionID }));
    if (event.type === 'session.status') {
      const type = properties.status?.type ?? event.status?.type;
      if (type === 'busy' || type === 'retry') return setState('running', 'working', correlation({ sessionID }));
      if (type === 'idle') return setState('completed', 'assistant_complete', correlation({ sessionID }));
    }
  },
  'tool.execute.before': async (input, output) => {
    const sessionID = firstString(input?.sessionID, input?.sessionId);
    const callID = firstString(input?.callID, input?.callId);
    const tool = firstString(input?.tool);
    await setState('running', 'pre_tool_use', correlation({ sessionID, callID, tool, args: output?.args }), true);
  },
  'tool.execute.after': async (input) => {
    const sessionID = firstString(input?.sessionID, input?.sessionId);
    const callID = firstString(input?.callID, input?.callId);
    const tool = firstString(input?.tool);
    await setState('running', 'post_tool_use', correlation({ sessionID, callID, tool, args: input?.args }), true);
  },
});
"#
}

#[cfg(test)]
mod tests {
    use super::{
        antigravity_statusline_script, definition_contains_owned_command,
        hook_action_contains_owned_command, install_antigravity_hook_group,
        install_antigravity_statusline_config, install_json_hooks, managed_hook_script,
        opencode_plugin_source, remove_legacy_codex_trust, remove_owned_json_hooks,
        resolve_opencode_config_root, supports_agent_status_hook, ANTIGRAVITY_HOOK_GROUP,
        QODER_HOOK_EVENTS,
    };
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn pi_does_not_attempt_an_unsupported_status_hook_install() {
        assert!(!supports_agent_status_hook("pi"));
        assert!(supports_agent_status_hook("claude"));
    }

    #[test]
    fn recognizes_only_termflow_owned_definitions() {
        assert!(definition_contains_owned_command(&json!({
            "hooks": [{"command": "node C:\\\\x\\\\termflow-agent-hook.cjs codex"}]
        })));
        assert!(!definition_contains_owned_command(&json!({
            "hooks": [{"command": "node user-hook.js"}]
        })));
    }

    #[test]
    fn antigravity_hook_uses_native_top_level_group_and_preserves_user_groups() {
        let mut config = json!({
            "user-linter": {
                "PostToolUse": [{
                    "matcher": "write_to_file",
                    "hooks": [{"command": "node user-hook.js"}]
                }]
            }
        });
        install_antigravity_hook_group(
            &mut config,
            "node termflow-agent-hook.cjs antigravity PreInvocation",
            "node termflow-agent-hook.cjs antigravity Stop",
        )
        .unwrap();

        assert!(config.get("user-linter").is_some());
        let managed = &config[ANTIGRAVITY_HOOK_GROUP];
        assert!(managed.get("PreInvocation").unwrap().is_array());
        assert!(managed.get("Stop").unwrap().is_array());
        assert!(managed.get("hooks").is_none());
    }

    #[test]
    fn antigravity_hook_does_not_overwrite_an_unowned_group() {
        let mut config = json!({
            (ANTIGRAVITY_HOOK_GROUP): {
                "Stop": [{"command": "node user-hook.js"}]
            }
        });
        assert!(install_antigravity_hook_group(
            &mut config,
            "node termflow-agent-hook.cjs antigravity PreInvocation",
            "node termflow-agent-hook.cjs antigravity Stop",
        )
        .is_err());
    }

    #[test]
    fn antigravity_statusline_preserves_user_command_and_installs_bridge() {
        let directory = tempfile::tempdir().unwrap();
        let original_path = directory.path().join("original.json");
        let mut settings = json!({
            "theme": "dark",
            "statusLine": { "type": "command", "command": "user-statusline" }
        });
        install_antigravity_statusline_config(
            &mut settings,
            "node termflow-antigravity-statusline.cjs",
            &original_path,
        )
        .unwrap();

        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["statusLine"]["stack_with_default"], true);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(original_path).unwrap()
            )
            .unwrap()["command"],
            "user-statusline"
        );
    }

    #[test]
    fn antigravity_statusline_snapshot_is_sanitized_and_atomic() {
        let source = antigravity_statusline_script();
        assert!(source.contains("input.quota"));
        assert!(source.contains("remaining_fraction"));
        assert!(source.contains("createHash('sha256')"));
        assert!(source.contains("fs.renameSync(temporary, snapshotPath)"));
        assert!(!source.contains("email: input.email"));
    }

    #[test]
    fn removes_only_the_legacy_termflow_codex_trust_block() {
        let path = std::env::temp_dir().join(format!(
            "termflow-codex-trust-migration-{}.toml",
            std::process::id()
        ));
        let content = concat!(
            "model = \"gpt-5\"\n\n",
            "[hooks.state.\"user-owned\"]\n",
            "enabled = true\n\n",
            "# BEGIN TERMFLOW AGENT STATUS HOOKS\n",
            "[hooks.state.\"managed\"]\n",
            "enabled = true\n",
            "trusted_hash = \"sha256:stale\"\n",
            "# END TERMFLOW AGENT STATUS HOOKS\n\n",
            "[projects.\"C:/project\"]\n",
            "trust_level = \"trusted\"\n"
        );
        std::fs::write(&path, content).unwrap();

        remove_legacy_codex_trust(&path).unwrap();

        let migrated = std::fs::read_to_string(&path).unwrap();
        assert!(migrated.contains("[hooks.state.\"user-owned\"]"));
        assert!(migrated.contains("[projects.\"C:/project\"]"));
        assert!(!migrated.contains("TERMFLOW AGENT STATUS HOOKS"));
        assert!(!migrated.contains("[hooks.state.\"managed\"]"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn opencode_defaults_to_xdg_style_home_on_windows_too() {
        let home = PathBuf::from(r"C:\Users\tester");
        assert_eq!(
            resolve_opencode_config_root(None, None, Some(home)).unwrap(),
            PathBuf::from(r"C:\Users\tester\.config\opencode")
        );
    }

    #[test]
    fn opencode_honors_explicit_config_directory() {
        let explicit = PathBuf::from(r"D:\custom-opencode");
        assert_eq!(
            resolve_opencode_config_root(Some(explicit.clone()), None, None).unwrap(),
            explicit
        );
    }

    #[test]
    fn codex_session_start_no_longer_starts_breathing() {
        assert!(!managed_hook_script().contains("sessionstart: 'running'"));
    }

    #[test]
    fn managed_hook_preserves_permission_event_type() {
        let source = managed_hook_script();
        assert!(source.contains("permissionrequest: 'permission_request'"));
        assert!(source.contains("pretooluse: 'pre_tool_use'"));
        assert!(source.contains("posttooluse: 'post_tool_use'"));
        assert!(source.contains("event_type: eventType"));
    }

    #[test]
    fn codex_hook_hashes_tool_context_and_forwards_only_safe_correlation() {
        let source = managed_hook_script();
        assert!(source.contains("crypto.createHmac('sha256', token)"));
        assert!(source.contains("toolFingerprint: digest({ agent, toolName, toolInput })"));
        assert!(source.contains("actorFingerprint: digest({ agent, actorId, actorType })"));
        assert!(source.contains("payload: correlationPayload"));
        assert!(!source.contains("payload: input"));
        assert!(!source.contains("stdin_raw"));
    }

    #[test]
    fn managed_hook_maps_antigravity_native_events_without_persisting_stdin() {
        let source = managed_hook_script();
        assert!(source.contains("antigravity: { preinvocation: 'running', stop: 'completed' }"));
        assert!(source.contains("input.fullyIdle === false"));
        assert!(source.contains("terminationReason === 'max_steps_exceeded'"));
        assert!(source.contains("provider_session_id: providerSessionId"));
        assert!(source.contains("payload: correlationPayload"));
        assert!(!source.contains("gemini: {"));
        assert!(!source.contains("payload: input"));
    }

    #[test]
    fn qoder_hooks_are_idempotent_and_preserve_user_definitions() {
        let mut config = json!({
            "theme": "dark",
            "hooks": {
                "SessionStart": [{
                    "matcher": "startup",
                    "hooks": [{"command": "node user-hook.js"}]
                }]
            }
        });
        let command = "node C:\\termflow-agent-hook.cjs qoder";

        install_json_hooks(&mut config, &QODER_HOOK_EVENTS, command, 10, "*").unwrap();
        install_json_hooks(&mut config, &QODER_HOOK_EVENTS, command, 10, "*").unwrap();

        assert_eq!(config["theme"], "dark");
        for event in QODER_HOOK_EVENTS {
            let definitions = config["hooks"][event].as_array().unwrap();
            assert_eq!(
                definitions
                    .iter()
                    .filter(|definition| definition_contains_owned_command(definition))
                    .count(),
                1,
                "managed {event} hook must not be duplicated"
            );
            let managed = definitions
                .iter()
                .find(|definition| definition_contains_owned_command(definition))
                .unwrap();
            assert_eq!(managed["matcher"], "*");
        }
        let session_start = config["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session_start.len(), 2);
        assert!(session_start
            .iter()
            .any(|definition| definition["hooks"][0]["command"] == "node user-hook.js"));
    }

    #[test]
    fn reinstalling_hooks_preserves_user_actions_in_a_mixed_definition() {
        let command = "node C:\\termflow-agent-hook.cjs qoder";
        let mut config = json!({
            "hooks": {
                "PermissionRequest": [{
                    "matcher": "*",
                    "hooks": [
                        {"type": "command", "command": command, "timeout": 10},
                        {"type": "command", "command": "node user-hook.js", "timeout": 20}
                    ]
                }]
            }
        });

        install_json_hooks(&mut config, &["PermissionRequest"], command, 10, "*").unwrap();

        let definitions = config["hooks"]["PermissionRequest"].as_array().unwrap();
        assert_eq!(definitions.len(), 2);
        assert!(definitions.iter().any(|definition| {
            definition["hooks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|hook| hook["command"] == "node user-hook.js")
        }));
        assert_eq!(
            definitions
                .iter()
                .flat_map(|definition| definition["hooks"].as_array().unwrap())
                .filter(|hook| hook_action_contains_owned_command(hook))
                .count(),
            1
        );
    }

    #[test]
    fn managed_hook_maps_qoder_native_lifecycle_without_raw_provider_data() {
        let source = managed_hook_script();

        assert!(source.contains("qoder: { sessionstart: 'waiting'"));
        assert!(source.contains("posttoolusefailure: 'running'"));
        assert!(source.contains("permissiondenied: 'running'"));
        assert!(source.contains("elicitation: 'waiting'"));
        assert!(source.contains("elicitationresult: 'running'"));
        assert!(source.contains("stopfailure: 'error'"));
        assert!(source.contains("sessionstart: 'session_start'"));
        assert!(source.contains("posttoolusefailure: 'post_tool_use_failure'"));
        assert!(source.contains("permissiondenied: 'permission_denied'"));
        assert!(source.contains("stopfailure: 'process_error'"));
        assert!(source.contains("input.source || '').toLowerCase() === 'compact'"));
        assert!(
            source.contains("firstString(input.session_id, input.sessionId, input.conversationId)")
        );
        assert!(source.contains("payload: correlationPayload"));
        assert!(!source.contains("payload: input"));
        assert!(!source.contains("prompt: input"));
    }

    #[test]
    fn opencode_correlates_permission_reply_and_tool_lifecycle() {
        let source = opencode_plugin_source();
        assert!(source.contains("event.type === 'permission.replied'"));
        assert!(source.contains("permissionFingerprint"));
        assert!(source.contains("'tool.execute.before'"));
        assert!(source.contains("'tool.execute.after'"));
        assert!(source.contains("event.type === 'permission.asked'"));
        assert!(source.contains("setState('running', 'permission_replied'"));
        assert!(source.contains("lastEventType = eventType"));
    }

    #[test]
    fn opencode_plugin_hashes_provider_context_before_transport() {
        let source = opencode_plugin_source();
        assert!(source.contains("createHmac('sha256', token)"));
        assert!(source.contains("payload: safePayload"));
        assert!(!source.contains("payload: properties"));
        assert!(!source.contains("payload: event.properties"));
    }

    #[test]
    fn removes_only_owned_codex_session_start_hook() {
        let mut config = json!({
            "hooks": {
                "SessionStart": [
                    {"hooks": [{"command": "node termflow-agent-hook.cjs codex"}]},
                    {"hooks": [{"command": "node user-hook.js"}]}
                ]
            }
        });
        remove_owned_json_hooks(&mut config, &["SessionStart"]).unwrap();
        let definitions = config["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0]["hooks"][0]["command"], "node user-hook.js");
    }
}
