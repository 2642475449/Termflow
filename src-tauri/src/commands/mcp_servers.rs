use crate::path_utils::{display_path, normalize_input_path};
use crate::qoder_config::qoder_user_config_root;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const CLAUDE: &str = "claude";
const CODEX: &str = "codex";
const ANTIGRAVITY: &str = "antigravity";
const OPENCODE: &str = "opencode";
const QODER: &str = "qoder";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub server_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl McpServerConfig {
    fn effective_type(&self) -> &str {
        match self.server_type.as_deref() {
            Some("sse") => "sse",
            Some("http") => "http",
            Some("ws") => "ws",
            _ => "stdio",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub server_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub scope: String,
    pub config_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerCatalog {
    pub servers: Vec<McpServerInfo>,
    #[serde(default)]
    pub scope_config_paths: HashMap<String, String>,
    // Kept for non-Claude clients and older frontend builds.
    pub workspace_config_path: Option<String>,
    pub user_config_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerTestResult {
    pub success: bool,
    pub message: String,
}

fn empty_config() -> McpServerConfig {
    McpServerConfig {
        server_type: None,
        command: None,
        args: vec![],
        env: HashMap::new(),
        url: None,
        headers: HashMap::new(),
        cwd: None,
    }
}

fn validate_agent(agent: &str) -> Result<&str, String> {
    match agent {
        CLAUDE | CODEX | ANTIGRAVITY | OPENCODE | QODER => Ok(agent),
        _ => Err(format!("Unsupported MCP agent: {agent}")),
    }
}

fn validate_scope(agent: &str, scope: &str, project_path: Option<&str>) -> Result<(), String> {
    if matches!(agent, CLAUDE | QODER) {
        return match scope {
            "user" => Ok(()),
            "local" | "project" if project_path.is_some() => Ok(()),
            "local" | "project" => {
                Err("Open a project before managing local or project MCP servers".to_string())
            }
            _ => Err(format!("Unsupported {agent} MCP scope: {scope}")),
        };
    }
    match scope {
        "user" => Ok(()),
        "workspace" if project_path.is_some() => Ok(()),
        "workspace" => Err("Open a project before managing workspace MCP servers".to_string()),
        _ => Err(format!("Unsupported MCP scope: {scope}")),
    }
}

fn home_dir() -> Result<PathBuf, String> {
    dirs_next::home_dir().ok_or_else(|| "Unable to resolve the user home directory".to_string())
}

/// Return the native MCP configuration path for an agent and its supported scopes.
/// The page always keeps an agent selected, so configs never bleed between CLIs.
fn get_mcp_config_path(
    agent: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    validate_agent(agent)?;
    validate_scope(agent, scope, project_path)?;

    let project = || -> Result<PathBuf, String> {
        project_path
            .map(normalize_input_path)
            .ok_or_else(|| "Open a project before managing workspace MCP servers".to_string())
    };

    match (agent, scope) {
        (CLAUDE, "user" | "local") => Ok(home_dir()?.join(".claude.json")),
        (CLAUDE, "project") => Ok(project()?.join(".mcp.json")),
        (CODEX, "user") => Ok(home_dir()?.join(".codex").join("config.toml")),
        (CODEX, "workspace") => Ok(project()?.join(".codex").join("config.toml")),
        (ANTIGRAVITY, "user") => Ok(home_dir()?
            .join(".gemini")
            .join("config")
            .join("mcp_config.json")),
        (ANTIGRAVITY, "workspace") => Ok(project()?.join(".agents").join("mcp_config.json")),
        (OPENCODE, "user") => Ok(prefer_existing_config_path(
            home_dir()?.join(".config").join("opencode"),
            &["opencode.jsonc", "opencode.json"],
            "opencode.json",
        )),
        (OPENCODE, "workspace") => {
            let project = project()?;
            let nested = prefer_existing_config_path(
                project.join(".opencode"),
                &["opencode.jsonc", "opencode.json"],
                "opencode.json",
            );
            if nested.exists() {
                Ok(nested)
            } else {
                Ok(prefer_existing_config_path(
                    project,
                    &["opencode.jsonc", "opencode.json"],
                    ".opencode/opencode.json",
                ))
            }
        }
        (QODER, "user") => Ok(qoder_user_config_root()?.join("settings.json")),
        (QODER, "local") => Ok(project()?.join(".qoder").join("settings.local.json")),
        (QODER, "project") => Ok(project()?.join(".mcp.json")),
        _ => unreachable!("validated agent and scope"),
    }
}

fn prefer_existing_config_path(directory: PathBuf, names: &[&str], default: &str) -> PathBuf {
    names
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.exists())
        .unwrap_or_else(|| directory.join(default))
}

fn read_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let contents =
        fs::read_to_string(path).map_err(|error| format!("Failed to read MCP config: {error}"))?;
    parse_json_or_jsonc(&contents).map_err(|error| format!("Failed to parse MCP config: {error}"))
}

fn strip_jsonc_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut characters = source.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(character) = characters.next() {
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        if character == '"' {
            in_string = true;
            output.push(character);
        } else if character == '/' && characters.peek() == Some(&'/') {
            characters.next();
            for comment_character in characters.by_ref() {
                if comment_character == '\n' {
                    output.push('\n');
                    break;
                }
            }
        } else if character == '/' && characters.peek() == Some(&'*') {
            characters.next();
            let mut previous = '\0';
            for comment_character in characters.by_ref() {
                if comment_character == '\n' {
                    output.push('\n');
                }
                if previous == '*' && comment_character == '/' {
                    break;
                }
                previous = comment_character;
            }
        } else {
            output.push(character);
        }
    }
    output
}

fn strip_jsonc_trailing_commas(source: &str) -> String {
    let characters: Vec<char> = source.chars().collect();
    let mut output = String::with_capacity(source.len());
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in characters.iter().enumerate() {
        if in_string {
            output.push(*character);
            if escaped {
                escaped = false;
            } else if *character == '\\' {
                escaped = true;
            } else if *character == '"' {
                in_string = false;
            }
            continue;
        }
        if *character == '"' {
            in_string = true;
            output.push(*character);
            continue;
        }
        if *character == ',' {
            if let Some(next) = characters[index + 1..]
                .iter()
                .find(|next| !next.is_whitespace())
            {
                if matches!(*next, '}' | ']') {
                    output.push(' ');
                    continue;
                }
            }
        }
        output.push(*character);
    }
    output
}

fn parse_json_or_jsonc(contents: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(contents).or_else(|_| {
        let without_comments = strip_jsonc_comments(contents);
        serde_json::from_str(&strip_jsonc_trailing_commas(&without_comments))
    })
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create MCP config directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize MCP config: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("Failed to write MCP config: {error}"))
}

/// Claude Code keeps local and user MCP definitions inside its state file. That file
/// also contains session state owned by Claude Code, so never deserialize and rewrite
/// the entire document just to change one MCP entry. In particular, interrupted CLI
/// writes can leave unrelated state malformed while the MCP object's own JSON remains
/// usable. These helpers locate and replace only the relevant object value.
fn matching_json_object_end(source: &str, start: usize) -> Option<usize> {
    if source.as_bytes().get(start) != Some(&b'{') {
        return None;
    }
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in source[start..].char_indices() {
        let index = start + offset;
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index + character.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

fn json_object_value_range(
    source: &str,
    key: &str,
    start: usize,
    end: usize,
) -> Option<(usize, usize)> {
    let quoted_key = serde_json::to_string(key).ok()?;
    let mut cursor = start;
    while cursor < end {
        let relative = source.get(cursor..end)?.find(&quoted_key)?;
        let key_end = cursor + relative + quoted_key.len();
        let mut value_start = key_end;
        while source
            .as_bytes()
            .get(value_start)
            .is_some_and(u8::is_ascii_whitespace)
        {
            value_start += 1;
        }
        if source.as_bytes().get(value_start) != Some(&b':') {
            cursor = key_end;
            continue;
        }
        value_start += 1;
        while source
            .as_bytes()
            .get(value_start)
            .is_some_and(u8::is_ascii_whitespace)
        {
            value_start += 1;
        }
        if value_start < end && source.as_bytes().get(value_start) == Some(&b'{') {
            if let Some(value_end) = matching_json_object_end(source, value_start) {
                if value_end <= end {
                    return Some((value_start, value_end));
                }
            }
        }
        cursor = key_end;
    }
    None
}

fn claude_project_key_candidates(project_path: &str) -> Vec<String> {
    let normalized = display_path(normalize_input_path(project_path));
    let mut candidates = vec![
        normalized.clone(),
        normalized.replace('\\', "/"),
        project_path.to_string(),
        project_path.replace('\\', "/"),
    ];
    candidates.sort();
    candidates.dedup();
    candidates
}

fn claude_project_object_range(source: &str, project_path: &str) -> Option<(usize, usize)> {
    // Do not require the complete state file to be valid. Claude Code's state file
    // can contain unrelated, partially-written session metadata after this object.
    let projects = json_object_value_range(source, "projects", 0, source.len())?;
    for candidate in claude_project_key_candidates(project_path) {
        if let Some(project) =
            json_object_value_range(source, &candidate, projects.0 + 1, projects.1)
        {
            return Some(project);
        }
    }
    None
}

fn claude_mcp_object_range(
    source: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Option<(usize, usize)> {
    match scope {
        "user" => {
            let projects_start = source.find("\"projects\"").unwrap_or(source.len());
            json_object_value_range(source, "mcpServers", 0, projects_start)
        }
        "local" => {
            let project = claude_project_object_range(source, project_path?)?;
            json_object_value_range(source, "mcpServers", project.0 + 1, project.1)
        }
        _ => None,
    }
}

fn claude_mcp_container_range(
    source: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Option<(usize, usize)> {
    match scope {
        "user" => {
            let start = source.find('{')?;
            Some((start, matching_json_object_end(source, start)?))
        }
        "local" => claude_project_object_range(source, project_path?),
        _ => None,
    }
}

fn claude_servers_from_state(
    source: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<Vec<(String, McpServerConfig)>, String> {
    let Some((start, end)) = claude_mcp_object_range(source, scope, project_path) else {
        return Ok(vec![]);
    };
    let servers: serde_json::Map<String, Value> = serde_json::from_str(&source[start..end])
        .map_err(|error| format!("Failed to parse Claude Code MCP entry: {error}"))?;
    Ok(servers
        .iter()
        .filter_map(|(name, value)| {
            config_from_json(CLAUDE, value).map(|config| (name.clone(), config))
        })
        .collect())
}

fn insert_json_member(source: &str, container: (usize, usize), key: &str, value: &Value) -> String {
    let insertion_at = container.1 - 1;
    let inner = source[container.0 + 1..insertion_at].trim();
    let member = format!(
        "\n  {}: {}\n",
        serde_json::to_string(key).unwrap_or_default(),
        value
    );
    let separator = if inner.is_empty() { "" } else { "," };
    format!(
        "{}{}{}{}",
        &source[..insertion_at],
        separator,
        member,
        &source[insertion_at..]
    )
}

fn update_claude_state_mcp(
    source: &str,
    scope: &str,
    project_path: Option<&str>,
    name: &str,
    config: &McpServerConfig,
    delete: bool,
) -> Result<String, String> {
    if let Some((start, end)) = claude_mcp_object_range(source, scope, project_path) {
        let mut servers: serde_json::Map<String, Value> = serde_json::from_str(&source[start..end])
            .map_err(|error| format!("Failed to parse Claude Code MCP entry: {error}"))?;
        if delete {
            servers.remove(name);
        } else {
            let updated = merge_json_mcp_config(CLAUDE, servers.get(name), config);
            servers.insert(name.to_string(), updated);
        }
        let replacement = serde_json::to_string_pretty(&servers)
            .map_err(|error| format!("Failed to serialize Claude Code MCP entry: {error}"))?;
        return Ok(format!(
            "{}{}{}",
            &source[..start],
            replacement,
            &source[end..]
        ));
    }
    if delete {
        return Ok(source.to_string());
    }
    let container = claude_mcp_container_range(source, scope, project_path).ok_or_else(|| {
        "Claude Code's state file has no writable MCP section; use `claude mcp add` to repair it without overwriting your state".to_string()
    })?;
    let mut servers = serde_json::Map::new();
    servers.insert(name.to_string(), config_to_json(CLAUDE, config));
    Ok(insert_json_member(
        source,
        container,
        "mcpServers",
        &Value::Object(servers),
    ))
}

fn update_claude_state_file(
    path: &Path,
    scope: &str,
    project_path: Option<&str>,
    name: &str,
    config: &McpServerConfig,
    delete: bool,
) -> Result<(), String> {
    let source = if path.exists() {
        fs::read_to_string(path)
            .map_err(|error| format!("Failed to read Claude Code state: {error}"))?
    } else if scope == "local" {
        let project = project_path
            .ok_or_else(|| "Open a project before managing local MCP servers".to_string())?;
        let key = claude_project_key_candidates(project)
            .into_iter()
            .find(|candidate| candidate.contains('/'))
            .unwrap_or_else(|| project.to_string());
        json!({"projects": {key: {"mcpServers": {}}}}).to_string()
    } else {
        json!({"mcpServers": {}}).to_string()
    };
    let updated = update_claude_state_mcp(&source, scope, project_path, name, config, delete)?;
    fs::write(path, updated)
        .map_err(|error| format!("Failed to update Claude Code MCP entry: {error}"))
}

fn string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn config_from_json(agent: &str, value: &Value) -> Option<McpServerConfig> {
    let object = value.as_object()?;
    if agent == OPENCODE {
        let server_type = match object.get("type").and_then(Value::as_str) {
            Some("local") => None,
            Some("remote") => Some("http".to_string()),
            _ if object.get("url").is_some() => Some("http".to_string()),
            _ => None,
        };
        let command = object
            .get("command")
            .and_then(Value::as_array)
            .and_then(|parts| parts.first())
            .and_then(Value::as_str)
            .map(str::to_string);
        let args = object
            .get("command")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .skip(1)
                    .filter_map(|part| part.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        return Some(McpServerConfig {
            server_type,
            command,
            args,
            env: string_map(object.get("environment")),
            url: object
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            headers: string_map(object.get("headers")),
            cwd: object
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }

    let url = object
        .get("url")
        .or_else(|| object.get("serverUrl"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let server_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            url.as_ref()
                .map(|url| if url.starts_with("ws") { "ws" } else { "http" }.to_string())
        });
    Some(McpServerConfig {
        server_type,
        command: object
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        args: string_array(object.get("args")),
        env: string_map(object.get("env")),
        url,
        headers: string_map(object.get("headers")),
        cwd: object
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn config_to_json(agent: &str, config: &McpServerConfig) -> Value {
    if agent == OPENCODE {
        if config.effective_type() == "stdio" {
            let mut command = vec![Value::String(config.command.clone().unwrap_or_default())];
            command.extend(config.args.iter().cloned().map(Value::String));
            let mut result = serde_json::Map::new();
            result.insert("type".to_string(), Value::String("local".to_string()));
            result.insert("command".to_string(), Value::Array(command));
            if !config.env.is_empty() {
                result.insert("environment".to_string(), json!(config.env));
            }
            if let Some(cwd) = &config.cwd {
                result.insert("cwd".to_string(), Value::String(cwd.clone()));
            }
            return Value::Object(result);
        }
        let mut result = serde_json::Map::new();
        result.insert("type".to_string(), Value::String("remote".to_string()));
        result.insert(
            "url".to_string(),
            Value::String(config.url.clone().unwrap_or_default()),
        );
        if !config.headers.is_empty() {
            result.insert("headers".to_string(), json!(config.headers));
        }
        return Value::Object(result);
    }

    let mut result = serde_json::Map::new();
    if config.effective_type() != "stdio" && agent != ANTIGRAVITY {
        result.insert(
            "type".to_string(),
            Value::String(config.effective_type().to_string()),
        );
    }
    if let Some(command) = &config.command {
        result.insert("command".to_string(), Value::String(command.clone()));
    }
    if !config.args.is_empty() {
        result.insert("args".to_string(), json!(config.args));
    }
    if !config.env.is_empty() {
        result.insert("env".to_string(), json!(config.env));
    }
    if let Some(url) = &config.url {
        result.insert(
            if agent == ANTIGRAVITY {
                "serverUrl"
            } else {
                "url"
            }
            .to_string(),
            Value::String(url.clone()),
        );
    }
    if !config.headers.is_empty() {
        result.insert("headers".to_string(), json!(config.headers));
    }
    if let Some(cwd) = &config.cwd {
        result.insert("cwd".to_string(), Value::String(cwd.clone()));
    }
    Value::Object(result)
}

fn merge_json_mcp_config(agent: &str, current: Option<&Value>, config: &McpServerConfig) -> Value {
    let mut merged = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let managed_keys: &[&str] = if agent == OPENCODE {
        &["type", "command", "environment", "url", "headers", "cwd"]
    } else {
        &[
            "type",
            "command",
            "args",
            "env",
            "url",
            "serverUrl",
            "headers",
            "cwd",
        ]
    };
    for key in managed_keys {
        merged.remove(*key);
    }
    if let Some(next) = config_to_json(agent, config).as_object() {
        merged.extend(next.clone());
    }
    Value::Object(merged)
}

fn toml_string_map(value: Option<&toml::Value>) -> HashMap<String, String> {
    value
        .and_then(toml::Value::as_table)
        .map(|table| {
            table
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn config_from_codex(value: &toml::Value) -> Option<McpServerConfig> {
    let table = value.as_table()?;
    let url = table
        .get("url")
        .and_then(toml::Value::as_str)
        .map(str::to_string);
    Some(McpServerConfig {
        server_type: url.as_ref().map(|_| "http".to_string()),
        command: table
            .get("command")
            .and_then(toml::Value::as_str)
            .map(str::to_string),
        args: table
            .get("args")
            .and_then(toml::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        env: toml_string_map(table.get("env")),
        url,
        headers: toml_string_map(table.get("http_headers")),
        cwd: table
            .get("cwd")
            .and_then(toml::Value::as_str)
            .map(str::to_string),
    })
}

fn config_to_codex(config: &McpServerConfig) -> toml::Value {
    let mut table = toml::map::Map::new();
    if config.effective_type() == "stdio" {
        table.insert(
            "command".to_string(),
            toml::Value::String(config.command.clone().unwrap_or_default()),
        );
        if !config.args.is_empty() {
            table.insert(
                "args".to_string(),
                toml::Value::Array(
                    config
                        .args
                        .iter()
                        .cloned()
                        .map(toml::Value::String)
                        .collect(),
                ),
            );
        }
        if !config.env.is_empty() {
            table.insert(
                "env".to_string(),
                toml::Value::Table(
                    config
                        .env
                        .iter()
                        .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                        .collect(),
                ),
            );
        }
        if let Some(cwd) = &config.cwd {
            table.insert("cwd".to_string(), toml::Value::String(cwd.clone()));
        }
    } else {
        table.insert(
            "url".to_string(),
            toml::Value::String(config.url.clone().unwrap_or_default()),
        );
        if !config.headers.is_empty() {
            table.insert(
                "http_headers".to_string(),
                toml::Value::Table(
                    config
                        .headers
                        .iter()
                        .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                        .collect(),
                ),
            );
        }
    }
    toml::Value::Table(table)
}

/// The Settings UI only owns the common connection fields. Preserve every other
/// native Codex setting (for example tool timeouts or an OAuth-specific option)
/// when a user edits a server through the UI.
fn merge_codex_mcp_config(current: Option<&toml::Value>, config: &McpServerConfig) -> toml::Value {
    let mut merged = current
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    for key in ["command", "args", "env", "cwd", "url", "http_headers"] {
        merged.remove(key);
    }
    if let Some(next) = config_to_codex(config).as_table() {
        for (key, value) in next {
            merged.insert(key.clone(), value.clone());
        }
    }
    toml::Value::Table(merged)
}

fn read_mcp_configs(agent: &str, path: &Path) -> Result<Vec<(String, McpServerConfig)>, String> {
    if agent == CODEX {
        if !path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read MCP config: {error}"))?;
        let document = content
            .parse::<toml::Value>()
            .map_err(|error| format!("Failed to parse Codex config: {error}"))?;
        return Ok(document
            .get("mcp_servers")
            .and_then(toml::Value::as_table)
            .map(|servers| {
                servers
                    .iter()
                    .filter_map(|(name, value)| {
                        config_from_codex(value).map(|config| (name.clone(), config))
                    })
                    .collect()
            })
            .unwrap_or_default());
    }
    let settings = read_json(path)?;
    let servers = if agent == OPENCODE {
        settings.get("mcp").and_then(|mcp| mcp.get("servers"))
    } else {
        settings.get("mcpServers")
    };
    Ok(servers
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .filter_map(|(name, value)| {
                    config_from_json(agent, value).map(|config| (name.clone(), config))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn read_claude_mcp_configs(
    scope: &str,
    project_path: Option<&str>,
) -> Result<Vec<(String, McpServerConfig)>, String> {
    match scope {
        "project" => read_mcp_configs(CLAUDE, &get_mcp_config_path(CLAUDE, scope, project_path)?),
        "local" | "user" => {
            let path = get_mcp_config_path(CLAUDE, scope, project_path)?;
            if !path.exists() {
                return Ok(vec![]);
            }
            let source = fs::read_to_string(&path)
                .map_err(|error| format!("Failed to read Claude Code state: {error}"))?;
            claude_servers_from_state(&source, scope, project_path)
        }
        _ => unreachable!("Claude scope was validated"),
    }
}

fn update_mcp_config(
    agent: &str,
    path: &Path,
    name: &str,
    config: &McpServerConfig,
    delete: bool,
) -> Result<(), String> {
    if agent == CODEX {
        let mut document = if path.exists() {
            fs::read_to_string(path)
                .map_err(|error| format!("Failed to read MCP config: {error}"))?
                .parse::<toml::Value>()
                .map_err(|error| format!("Failed to parse Codex config: {error}"))?
        } else {
            toml::Value::Table(toml::map::Map::new())
        };
        let root = document
            .as_table_mut()
            .ok_or_else(|| "Codex config root must be a TOML table".to_string())?;
        let servers = root
            .entry("mcp_servers".to_string())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
            .as_table_mut()
            .ok_or_else(|| "Codex mcp_servers must be a TOML table".to_string())?;
        if delete {
            servers.remove(name);
        } else {
            let updated = merge_codex_mcp_config(servers.get(name), config);
            servers.insert(name.to_string(), updated);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create MCP config directory: {error}"))?;
        }
        return fs::write(
            path,
            toml::to_string_pretty(&document)
                .map_err(|error| format!("Failed to serialize Codex config: {error}"))?,
        )
        .map_err(|error| format!("Failed to write MCP config: {error}"));
    }

    let mut settings = read_json(path)?;
    let root = settings
        .as_object_mut()
        .ok_or_else(|| "MCP config root must be a JSON object".to_string())?;
    let servers = if agent == OPENCODE {
        root.entry("mcp".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "OpenCode mcp must be a JSON object".to_string())?
            .entry("servers".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "OpenCode mcp.servers must be a JSON object".to_string())?
    } else {
        root.entry("mcpServers".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "mcpServers must be a JSON object".to_string())?
    };
    if delete {
        servers.remove(name);
    } else {
        let updated = merge_json_mcp_config(agent, servers.get(name), config);
        servers.insert(name.to_string(), updated);
    }
    write_json(path, &settings)
}

fn update_claude_mcp_config(
    scope: &str,
    project_path: Option<&str>,
    name: &str,
    config: &McpServerConfig,
    delete: bool,
) -> Result<(), String> {
    let path = get_mcp_config_path(CLAUDE, scope, project_path)?;
    if scope == "project" {
        return update_mcp_config(CLAUDE, &path, name, config, delete);
    }
    update_claude_state_file(&path, scope, project_path, name, config, delete)
}

fn info(name: String, config: McpServerConfig, scope: &str, path: &Path) -> McpServerInfo {
    McpServerInfo {
        name,
        server_type: config.effective_type().to_string(),
        command: config.command,
        args: config.args,
        env: config.env,
        url: config.url,
        headers: config.headers,
        cwd: config.cwd,
        scope: scope.to_string(),
        config_path: display_path(path),
    }
}

fn read_mcp_servers_for_scope(
    agent: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<Vec<McpServerInfo>, String> {
    let path = get_mcp_config_path(agent, scope, project_path)?;
    let configs = if agent == CLAUDE {
        read_claude_mcp_configs(scope, project_path)?
    } else {
        read_mcp_configs(agent, &path)?
    };
    let mut servers: Vec<_> = configs
        .into_iter()
        .map(|(name, config)| info(name, config, scope, &path))
        .collect();
    servers.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(servers)
}

fn validate_server_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 128
        || name.contains(|character: char| {
            character.is_control() || matches!(character, '"' | '\\' | '/')
        })
    {
        return Err("MCP server name must be 1-128 characters without control characters, quotes, slashes, or backslashes".to_string());
    }
    Ok(())
}

fn transport_supported_by_agent(agent: &str, transport: &str) -> bool {
    match agent {
        CODEX | OPENCODE => matches!(transport, "stdio" | "http"),
        ANTIGRAVITY => matches!(transport, "stdio" | "http"),
        CLAUDE | QODER => matches!(transport, "stdio" | "http" | "sse" | "ws"),
        _ => false,
    }
}

fn validate_mcp_config(agent: &str, config: &McpServerConfig) -> Result<(), String> {
    let transport = config.effective_type();
    if !transport_supported_by_agent(agent, transport) {
        return Err(format!(
            "{agent} does not support MCP transport '{transport}'"
        ));
    }
    if transport == "stdio"
        && config
            .command
            .as_ref()
            .is_none_or(|command| command.trim().is_empty())
    {
        return Err("A stdio MCP server requires a command".to_string());
    }
    if transport != "stdio" && config.url.as_ref().is_none_or(|url| url.trim().is_empty()) {
        return Err("A remote MCP server requires a URL".to_string());
    }
    Ok(())
}

fn parse_url_host_port(url: &str) -> Option<(String, u16)> {
    let (scheme, remainder) = url.split_once("://").unwrap_or(("http", url));
    let authority = remainder.split('/').next()?.rsplit('@').next()?;
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = authority[1..end].to_string();
        let port = authority
            .get(end + 2..)
            .and_then(|port| port.parse().ok())
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        return Some((host, port));
    }
    let mut pieces = authority.rsplitn(2, ':');
    let last = pieces.next()?;
    match pieces.next() {
        Some(host) => Some((host.to_string(), last.parse().ok()?)),
        None => Some((last.to_string(), if scheme == "https" { 443 } else { 80 })),
    }
}

#[tauri::command]
pub fn list_mcp_servers(
    agent: String,
    project_path: Option<String>,
) -> Result<McpServerCatalog, String> {
    let agent = validate_agent(&agent)?;
    let scopes: Vec<(&str, Option<&str>)> = if matches!(agent, CLAUDE | QODER) {
        let mut scopes = vec![("user", None)];
        if let Some(project) = project_path.as_deref() {
            scopes.extend([("local", Some(project)), ("project", Some(project))]);
        }
        scopes
    } else {
        let mut scopes = vec![("user", None)];
        if let Some(project) = project_path.as_deref() {
            scopes.push(("workspace", Some(project)));
        }
        scopes
    };
    let mut scope_config_paths = HashMap::new();
    let mut servers = Vec::new();
    for (scope, scope_project_path) in scopes {
        let path = get_mcp_config_path(agent, scope, scope_project_path)?;
        scope_config_paths.insert(scope.to_string(), display_path(&path));
        servers.extend(read_mcp_servers_for_scope(
            agent,
            scope,
            scope_project_path,
        )?);
    }
    servers.sort_by(|left, right| {
        left.scope
            .cmp(&right.scope)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let user_path = get_mcp_config_path(agent, "user", None)?;
    let workspace_path = if matches!(agent, CLAUDE | QODER) {
        project_path
            .as_deref()
            .map(|project| get_mcp_config_path(agent, "project", Some(project)))
            .transpose()?
    } else {
        project_path
            .as_deref()
            .map(|project| get_mcp_config_path(agent, "workspace", Some(project)))
            .transpose()?
    };
    Ok(McpServerCatalog {
        servers,
        scope_config_paths,
        workspace_config_path: workspace_path.as_ref().map(|path| display_path(path)),
        user_config_path: display_path(&user_path),
    })
}

#[tauri::command]
pub fn add_mcp_server(
    agent: String,
    scope: String,
    name: String,
    config: McpServerConfig,
    project_path: Option<String>,
) -> Result<McpServerInfo, String> {
    let agent = validate_agent(&agent)?;
    validate_scope(agent, &scope, project_path.as_deref())?;
    validate_server_name(&name)?;
    validate_mcp_config(agent, &config)?;
    let name = name.trim().to_string();
    if read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?
        .iter()
        .any(|server| server.name == name)
    {
        return Err(format!("MCP server '{name}' already exists"));
    }
    let path = get_mcp_config_path(agent, &scope, project_path.as_deref())?;
    if agent == CLAUDE {
        update_claude_mcp_config(&scope, project_path.as_deref(), &name, &config, false)?;
    } else {
        update_mcp_config(agent, &path, &name, &config, false)?;
    }
    Ok(info(name, config, &scope, &path))
}

#[tauri::command]
pub fn update_mcp_server(
    agent: String,
    scope: String,
    name: String,
    config: McpServerConfig,
    project_path: Option<String>,
) -> Result<McpServerInfo, String> {
    let agent = validate_agent(&agent)?;
    validate_scope(agent, &scope, project_path.as_deref())?;
    validate_mcp_config(agent, &config)?;
    let name = name.trim().to_string();
    if !read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?
        .iter()
        .any(|server| server.name == name)
    {
        return Err(format!("MCP server '{name}' does not exist"));
    }
    let path = get_mcp_config_path(agent, &scope, project_path.as_deref())?;
    if agent == CLAUDE {
        update_claude_mcp_config(&scope, project_path.as_deref(), &name, &config, false)?;
    } else {
        update_mcp_config(agent, &path, &name, &config, false)?;
    }
    Ok(info(name, config, &scope, &path))
}

#[tauri::command]
pub fn delete_mcp_server(
    agent: String,
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let agent = validate_agent(&agent)?;
    validate_scope(agent, &scope, project_path.as_deref())?;
    let name = name.trim().to_string();
    if !read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?
        .iter()
        .any(|server| server.name == name)
    {
        return Err(format!("MCP server '{name}' does not exist"));
    }
    let path = get_mcp_config_path(agent, &scope, project_path.as_deref())?;
    if agent == CLAUDE {
        update_claude_mcp_config(
            &scope,
            project_path.as_deref(),
            &name,
            &empty_config(),
            true,
        )
    } else {
        update_mcp_config(agent, &path, &name, &empty_config(), true)
    }
}

#[tauri::command]
pub fn test_mcp_server(
    agent: String,
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<McpServerTestResult, String> {
    let agent = validate_agent(&agent)?;
    validate_scope(agent, &scope, project_path.as_deref())?;
    let name = name.trim().to_string();
    let server = read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?
        .into_iter()
        .find(|server| server.name == name)
        .ok_or_else(|| format!("MCP server '{name}' does not exist"))?;
    if server.server_type == "stdio" {
        let command = server
            .command
            .as_ref()
            .ok_or_else(|| "Stdio MCP server is missing a command".to_string())?;
        return match std::process::Command::new(command).args(&server.args).envs(&server.env).current_dir(server.cwd.as_deref().unwrap_or(".")).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() {
            Ok(mut child) => { std::thread::sleep(std::time::Duration::from_millis(500)); let _ = child.kill(); let _ = child.wait(); Ok(McpServerTestResult { success: true, message: format!("MCP server '{name}' started successfully") }) }
            Err(error) => Ok(McpServerTestResult { success: false, message: format!("Failed to start MCP server: {error}") }),
        };
    }
    let url = server
        .url
        .as_ref()
        .ok_or_else(|| "Remote MCP server is missing a URL".to_string())?;
    let (host, port) =
        parse_url_host_port(url).ok_or_else(|| "Invalid MCP server URL".to_string())?;
    let address = format!("{host}:{port}");
    let address = address.parse::<std::net::SocketAddr>().or_else(|_| {
        use std::net::ToSocketAddrs;
        address
            .to_socket_addrs()
            .map_err(|error| format!("Failed to resolve MCP server address: {error}"))
            .and_then(|mut addresses| {
                addresses
                    .next()
                    .ok_or_else(|| "Unable to resolve MCP server address".to_string())
            })
    })?;
    match std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(3)) {
        Ok(_) => Ok(McpServerTestResult {
            success: true,
            message: format!("MCP server '{name}' is reachable"),
        }),
        Err(error) => Ok(McpServerTestResult {
            success: false,
            message: format!("Failed to connect: {error}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        claude_servers_from_state, config_from_json, config_to_codex, config_to_json,
        merge_codex_mcp_config, merge_json_mcp_config, parse_json_or_jsonc,
        transport_supported_by_agent, update_claude_state_mcp, validate_scope, ANTIGRAVITY, CLAUDE,
        CODEX, OPENCODE, QODER,
    };
    use serde_json::json;

    #[test]
    fn parses_opencode_local_server_commands() {
        let config = config_from_json(OPENCODE, &json!({"type": "local", "command": ["npx", "-y", "server"], "environment": {"TOKEN": "x"}})).unwrap();
        assert_eq!(config.command.as_deref(), Some("npx"));
        assert_eq!(config.args, ["-y", "server"]);
        assert_eq!(config.env.get("TOKEN").map(String::as_str), Some("x"));
    }

    #[test]
    fn writes_antigravity_remote_servers_with_server_url() {
        let config = super::McpServerConfig {
            server_type: Some("http".to_string()),
            url: Some("https://example.test/mcp".to_string()),
            ..super::empty_config()
        };
        let value = config_to_json(ANTIGRAVITY, &config);
        assert_eq!(value["serverUrl"], "https://example.test/mcp");
        assert!(value.get("type").is_none());
    }

    #[test]
    fn writes_codex_remote_servers_as_toml_mcp_entries() {
        let config = super::McpServerConfig {
            server_type: Some("http".to_string()),
            url: Some("https://example.test/mcp".to_string()),
            ..super::empty_config()
        };
        let value = config_to_codex(&config);
        assert_eq!(value["url"].as_str(), Some("https://example.test/mcp"));
        assert!(value.get("type").is_none());
    }

    #[test]
    fn exposes_only_supported_transports_per_agent() {
        assert!(transport_supported_by_agent(CODEX, "http"));
        assert!(!transport_supported_by_agent(CODEX, "sse"));
        assert!(transport_supported_by_agent(QODER, "ws"));
    }

    #[test]
    fn accepts_qoder_user_local_and_project_scopes() {
        assert!(validate_scope(QODER, "user", None).is_ok());
        assert!(validate_scope(QODER, "local", Some(r"E:\\work\\Termflow")).is_ok());
        assert!(validate_scope(QODER, "project", Some(r"E:\\work\\Termflow")).is_ok());
        assert!(validate_scope(QODER, "workspace", Some(r"E:\\work\\Termflow")).is_err());
    }

    #[test]
    fn reads_jsonc_with_comments_and_trailing_commas() {
        let value = parse_json_or_jsonc(
            r#"{
                // OpenCode supports JSONC
                "mcp": { "servers": { "demo": { "type": "remote", }, }, },
            }"#,
        )
        .unwrap();
        assert_eq!(value["mcp"]["servers"]["demo"]["type"], "remote");
    }

    #[test]
    fn preserves_native_json_server_fields_when_updating_connection() {
        let config = super::McpServerConfig {
            server_type: Some("http".to_string()),
            url: Some("https://new.example.test/mcp".to_string()),
            ..super::empty_config()
        };
        let current = json!({
            "type": "remote",
            "url": "https://old.example.test/mcp",
            "disabled": true,
            "oauth": { "clientId": "native-client" },
            "timeout": 12000,
        });
        let updated = merge_json_mcp_config(OPENCODE, Some(&current), &config);
        assert_eq!(updated["url"], "https://new.example.test/mcp");
        assert_eq!(updated["disabled"], true);
        assert_eq!(updated["oauth"]["clientId"], "native-client");
        assert_eq!(updated["timeout"], 12000);
    }

    #[test]
    fn preserves_native_codex_server_fields_when_updating_connection() {
        let config = super::McpServerConfig {
            server_type: Some("http".to_string()),
            url: Some("https://new.example.test/mcp".to_string()),
            ..super::empty_config()
        };
        let current: toml::Value = r#"
            url = "https://old.example.test/mcp"
            tool_timeout_sec = 90
            enabled = false
        "#
        .parse()
        .unwrap();
        let updated = merge_codex_mcp_config(Some(&current), &config);
        assert_eq!(
            updated["url"].as_str(),
            Some("https://new.example.test/mcp")
        );
        assert_eq!(updated["tool_timeout_sec"].as_integer(), Some(90));
        assert_eq!(updated["enabled"].as_bool(), Some(false));
    }

    #[test]
    fn reads_local_claude_servers_from_project_state_even_with_malformed_tail() {
        let state = r#"{
          "mcpServers": {},
          "projects": {
            "E:/work/Termflow": {
              "mcpServers": {
                "tavily-remote-mcp": { "type": "http", "url": "https://mcp.tavily.com/mcp/" }
              }
            }
          },
          "unrelated": "unterminated
        "#;
        let servers = claude_servers_from_state(state, "local", Some(r"E:\work\Termflow")).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].0, "tavily-remote-mcp");
        assert_eq!(
            servers[0].1.url.as_deref(),
            Some("https://mcp.tavily.com/mcp/")
        );
    }

    #[test]
    fn updates_only_the_local_mcp_object_in_claude_state() {
        let state = r#"{"projects":{"E:/work/Termflow":{"mcpServers":{"old":{"command":"old"}}}},"opaque":"keep"}"#;
        let config = super::McpServerConfig {
            server_type: Some("http".to_string()),
            url: Some("https://example.test/mcp".to_string()),
            ..super::empty_config()
        };
        let updated = update_claude_state_mcp(
            state,
            "local",
            Some(r"E:\work\Termflow"),
            "fresh",
            &config,
            false,
        )
        .unwrap();
        assert!(updated.contains("\"opaque\":\"keep\""));
        let servers =
            claude_servers_from_state(&updated, "local", Some(r"E:\work\Termflow")).unwrap();
        assert_eq!(servers.len(), 2);
        assert!(servers.iter().any(|(name, _)| name == "fresh"));
        assert!(!updated.contains("settings.json"));
        assert_eq!(CLAUDE, "claude");
    }
}
