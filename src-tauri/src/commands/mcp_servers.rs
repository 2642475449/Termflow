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
    pub workspace_config_path: Option<String>,
    pub user_config_path: String,
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

fn validate_scope(scope: &str, project_path: Option<&str>) -> Result<(), String> {
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

/// Return the native MCP configuration path for an agent and Termflow's two scopes.
/// The page always keeps an agent selected, so configs never bleed between CLIs.
fn get_mcp_config_path(
    agent: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    validate_agent(agent)?;
    validate_scope(scope, project_path)?;

    let project = || -> Result<PathBuf, String> {
        project_path
            .map(normalize_input_path)
            .ok_or_else(|| "Open a project before managing workspace MCP servers".to_string())
    };

    match (agent, scope) {
        (CLAUDE, "user") => Ok(home_dir()?.join(".claude").join("settings.json")),
        (CLAUDE, "workspace") => Ok(project()?.join(".claude").join("settings.json")),
        (CODEX, "user") => Ok(home_dir()?.join(".codex").join("config.toml")),
        (CODEX, "workspace") => Ok(project()?.join(".codex").join("config.toml")),
        (ANTIGRAVITY, "user") => Ok(home_dir()?.join(".gemini").join("config").join("mcp_config.json")),
        (ANTIGRAVITY, "workspace") => Ok(project()?.join(".agents").join("mcp_config.json")),
        (OPENCODE, "user") => Ok(home_dir()?.join(".config").join("opencode").join("opencode.json")),
        (OPENCODE, "workspace") => Ok(project()?.join(".opencode").join("opencode.json")),
        (QODER, "user") => Ok(qoder_user_config_root()?.join("settings.json")),
        (QODER, "workspace") => Ok(project()?.join(".mcp.json")),
        _ => unreachable!("validated agent and scope"),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let contents = fs::read_to_string(path).map_err(|error| format!("Failed to read MCP config: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("Failed to parse MCP config: {error}"))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Failed to create MCP config directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize MCP config: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("Failed to write MCP config: {error}"))
}

fn string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
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
        let command = object.get("command").and_then(Value::as_array).and_then(|parts| parts.first()).and_then(Value::as_str).map(str::to_string);
        let args = object.get("command").and_then(Value::as_array).map(|parts| parts.iter().skip(1).filter_map(|part| part.as_str().map(str::to_string)).collect()).unwrap_or_default();
        return Some(McpServerConfig {
            server_type,
            command,
            args,
            env: string_map(object.get("environment")),
            url: object.get("url").and_then(Value::as_str).map(str::to_string),
            headers: string_map(object.get("headers")),
            cwd: object.get("cwd").and_then(Value::as_str).map(str::to_string),
        });
    }

    let url = object
        .get("url")
        .or_else(|| object.get("serverUrl"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let server_type = object.get("type").and_then(Value::as_str).map(str::to_string).or_else(|| {
        url.as_ref().map(|url| if url.starts_with("ws") { "ws" } else { "http" }.to_string())
    });
    Some(McpServerConfig {
        server_type,
        command: object.get("command").and_then(Value::as_str).map(str::to_string),
        args: string_array(object.get("args")),
        env: string_map(object.get("env")),
        url,
        headers: string_map(object.get("headers")),
        cwd: object.get("cwd").and_then(Value::as_str).map(str::to_string),
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
            if !config.env.is_empty() { result.insert("environment".to_string(), json!(config.env)); }
            if let Some(cwd) = &config.cwd { result.insert("cwd".to_string(), Value::String(cwd.clone())); }
            return Value::Object(result);
        }
        let mut result = serde_json::Map::new();
        result.insert("type".to_string(), Value::String("remote".to_string()));
        result.insert("url".to_string(), Value::String(config.url.clone().unwrap_or_default()));
        if !config.headers.is_empty() { result.insert("headers".to_string(), json!(config.headers)); }
        return Value::Object(result);
    }

    let mut result = serde_json::Map::new();
    if config.effective_type() != "stdio" && agent != ANTIGRAVITY {
        result.insert("type".to_string(), Value::String(config.effective_type().to_string()));
    }
    if let Some(command) = &config.command { result.insert("command".to_string(), Value::String(command.clone())); }
    if !config.args.is_empty() { result.insert("args".to_string(), json!(config.args)); }
    if !config.env.is_empty() { result.insert("env".to_string(), json!(config.env)); }
    if let Some(url) = &config.url {
        result.insert(if agent == ANTIGRAVITY { "serverUrl" } else { "url" }.to_string(), Value::String(url.clone()));
    }
    if !config.headers.is_empty() { result.insert("headers".to_string(), json!(config.headers)); }
    if let Some(cwd) = &config.cwd { result.insert("cwd".to_string(), Value::String(cwd.clone())); }
    Value::Object(result)
}

fn toml_string_map(value: Option<&toml::Value>) -> HashMap<String, String> {
    value.and_then(toml::Value::as_table).map(|table| table.iter().filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string()))).collect()).unwrap_or_default()
}

fn config_from_codex(value: &toml::Value) -> Option<McpServerConfig> {
    let table = value.as_table()?;
    let url = table.get("url").and_then(toml::Value::as_str).map(str::to_string);
    Some(McpServerConfig {
        server_type: url.as_ref().map(|_| "http".to_string()),
        command: table.get("command").and_then(toml::Value::as_str).map(str::to_string),
        args: table.get("args").and_then(toml::Value::as_array).map(|values| values.iter().filter_map(|value| value.as_str().map(str::to_string)).collect()).unwrap_or_default(),
        env: toml_string_map(table.get("env")),
        url,
        headers: toml_string_map(table.get("http_headers")),
        cwd: table.get("cwd").and_then(toml::Value::as_str).map(str::to_string),
    })
}

fn config_to_codex(config: &McpServerConfig) -> toml::Value {
    let mut table = toml::map::Map::new();
    if config.effective_type() == "stdio" {
        table.insert("command".to_string(), toml::Value::String(config.command.clone().unwrap_or_default()));
        if !config.args.is_empty() { table.insert("args".to_string(), toml::Value::Array(config.args.iter().cloned().map(toml::Value::String).collect())); }
        if !config.env.is_empty() { table.insert("env".to_string(), toml::Value::Table(config.env.iter().map(|(key, value)| (key.clone(), toml::Value::String(value.clone()))).collect())); }
        if let Some(cwd) = &config.cwd { table.insert("cwd".to_string(), toml::Value::String(cwd.clone())); }
    } else {
        table.insert("url".to_string(), toml::Value::String(config.url.clone().unwrap_or_default()));
        if !config.headers.is_empty() { table.insert("http_headers".to_string(), toml::Value::Table(config.headers.iter().map(|(key, value)| (key.clone(), toml::Value::String(value.clone()))).collect())); }
    }
    toml::Value::Table(table)
}

fn read_mcp_configs(agent: &str, path: &Path) -> Result<Vec<(String, McpServerConfig)>, String> {
    if agent == CODEX {
        if !path.exists() { return Ok(vec![]); }
        let content = fs::read_to_string(path).map_err(|error| format!("Failed to read MCP config: {error}"))?;
        let document = content.parse::<toml::Value>().map_err(|error| format!("Failed to parse Codex config: {error}"))?;
        return Ok(document.get("mcp_servers").and_then(toml::Value::as_table).map(|servers| servers.iter().filter_map(|(name, value)| config_from_codex(value).map(|config| (name.clone(), config))).collect()).unwrap_or_default());
    }
    let settings = read_json(path)?;
    let servers = if agent == OPENCODE {
        settings.get("mcp").and_then(|mcp| mcp.get("servers"))
    } else {
        settings.get("mcpServers")
    };
    Ok(servers.and_then(Value::as_object).map(|servers| servers.iter().filter_map(|(name, value)| config_from_json(agent, value).map(|config| (name.clone(), config))).collect()).unwrap_or_default())
}

fn update_mcp_config(agent: &str, path: &Path, name: &str, config: &McpServerConfig, delete: bool) -> Result<(), String> {
    if agent == CODEX {
        let mut document = if path.exists() {
            fs::read_to_string(path).map_err(|error| format!("Failed to read MCP config: {error}"))?.parse::<toml::Value>().map_err(|error| format!("Failed to parse Codex config: {error}"))?
        } else { toml::Value::Table(toml::map::Map::new()) };
        let root = document.as_table_mut().ok_or_else(|| "Codex config root must be a TOML table".to_string())?;
        let servers = root.entry("mcp_servers".to_string()).or_insert_with(|| toml::Value::Table(toml::map::Map::new())).as_table_mut().ok_or_else(|| "Codex mcp_servers must be a TOML table".to_string())?;
        if delete { servers.remove(name); } else { servers.insert(name.to_string(), config_to_codex(config)); }
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| format!("Failed to create MCP config directory: {error}"))?; }
        return fs::write(path, toml::to_string_pretty(&document).map_err(|error| format!("Failed to serialize Codex config: {error}"))?).map_err(|error| format!("Failed to write MCP config: {error}"));
    }

    let mut settings = read_json(path)?;
    let root = settings.as_object_mut().ok_or_else(|| "MCP config root must be a JSON object".to_string())?;
    let servers = if agent == OPENCODE {
        root.entry("mcp".to_string()).or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| "OpenCode mcp must be a JSON object".to_string())?.entry("servers".to_string()).or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| "OpenCode mcp.servers must be a JSON object".to_string())?
    } else {
        root.entry("mcpServers".to_string()).or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| "mcpServers must be a JSON object".to_string())?
    };
    if delete { servers.remove(name); } else { servers.insert(name.to_string(), config_to_json(agent, config)); }
    write_json(path, &settings)
}

fn info(name: String, config: McpServerConfig, scope: &str, path: &Path) -> McpServerInfo {
    McpServerInfo { name, server_type: config.effective_type().to_string(), command: config.command, args: config.args, env: config.env, url: config.url, headers: config.headers, cwd: config.cwd, scope: scope.to_string(), config_path: display_path(path) }
}

fn read_mcp_servers_for_scope(agent: &str, scope: &str, project_path: Option<&str>) -> Result<Vec<McpServerInfo>, String> {
    let path = get_mcp_config_path(agent, scope, project_path)?;
    let mut servers: Vec<_> = read_mcp_configs(agent, &path)?.into_iter().map(|(name, config)| info(name, config, scope, &path)).collect();
    servers.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(servers)
}

fn validate_server_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 || name.contains(|character: char| character.is_control() || matches!(character, '"' | '\\' | '/')) {
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
    if !transport_supported_by_agent(agent, transport) { return Err(format!("{agent} does not support MCP transport '{transport}'")); }
    if transport == "stdio" && config.command.as_ref().is_none_or(|command| command.trim().is_empty()) { return Err("A stdio MCP server requires a command".to_string()); }
    if transport != "stdio" && config.url.as_ref().is_none_or(|url| url.trim().is_empty()) { return Err("A remote MCP server requires a URL".to_string()); }
    Ok(())
}

fn parse_url_host_port(url: &str) -> Option<(String, u16)> {
    let (scheme, remainder) = url.split_once("://").unwrap_or(("http", url));
    let authority = remainder.split('/').next()?.rsplit('@').next()?;
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = authority[1..end].to_string();
        let port = authority.get(end + 2..).and_then(|port| port.parse().ok()).unwrap_or(if scheme == "https" { 443 } else { 80 });
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
pub fn list_mcp_servers(agent: String, project_path: Option<String>) -> Result<McpServerCatalog, String> {
    let agent = validate_agent(&agent)?;
    let user_path = get_mcp_config_path(agent, "user", None)?;
    let workspace_path = project_path.as_deref().map(|project| get_mcp_config_path(agent, "workspace", Some(project))).transpose()?;
    let mut servers = read_mcp_servers_for_scope(agent, "user", None)?;
    if let Some(project) = project_path.as_deref() { servers.extend(read_mcp_servers_for_scope(agent, "workspace", Some(project))?); }
    servers.sort_by(|left, right| left.scope.cmp(&right.scope).then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase())));
    Ok(McpServerCatalog { servers, workspace_config_path: workspace_path.as_ref().map(|path| display_path(path)), user_config_path: display_path(&user_path) })
}

#[tauri::command]
pub fn add_mcp_server(agent: String, scope: String, name: String, config: McpServerConfig, project_path: Option<String>) -> Result<McpServerInfo, String> {
    let agent = validate_agent(&agent)?;
    validate_scope(&scope, project_path.as_deref())?;
    validate_server_name(&name)?;
    validate_mcp_config(agent, &config)?;
    let name = name.trim().to_string();
    if read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?.iter().any(|server| server.name == name) { return Err(format!("MCP server '{name}' already exists")); }
    let path = get_mcp_config_path(agent, &scope, project_path.as_deref())?;
    update_mcp_config(agent, &path, &name, &config, false)?;
    Ok(info(name, config, &scope, &path))
}

#[tauri::command]
pub fn update_mcp_server(agent: String, scope: String, name: String, config: McpServerConfig, project_path: Option<String>) -> Result<McpServerInfo, String> {
    let agent = validate_agent(&agent)?;
    validate_scope(&scope, project_path.as_deref())?;
    validate_mcp_config(agent, &config)?;
    let name = name.trim().to_string();
    if !read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?.iter().any(|server| server.name == name) { return Err(format!("MCP server '{name}' does not exist")); }
    let path = get_mcp_config_path(agent, &scope, project_path.as_deref())?;
    update_mcp_config(agent, &path, &name, &config, false)?;
    Ok(info(name, config, &scope, &path))
}

#[tauri::command]
pub fn delete_mcp_server(agent: String, scope: String, name: String, project_path: Option<String>) -> Result<(), String> {
    let agent = validate_agent(&agent)?;
    validate_scope(&scope, project_path.as_deref())?;
    let name = name.trim().to_string();
    if !read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?.iter().any(|server| server.name == name) { return Err(format!("MCP server '{name}' does not exist")); }
    let path = get_mcp_config_path(agent, &scope, project_path.as_deref())?;
    update_mcp_config(agent, &path, &name, &empty_config(), true)
}

#[tauri::command]
pub fn test_mcp_server(agent: String, scope: String, name: String, project_path: Option<String>) -> Result<String, String> {
    let agent = validate_agent(&agent)?;
    let name = name.trim().to_string();
    let server = read_mcp_servers_for_scope(agent, &scope, project_path.as_deref())?.into_iter().find(|server| server.name == name).ok_or_else(|| format!("MCP server '{name}' does not exist"))?;
    if server.server_type == "stdio" {
        let command = server.command.as_ref().ok_or_else(|| "Stdio MCP server is missing a command".to_string())?;
        return match std::process::Command::new(command).args(&server.args).envs(&server.env).current_dir(server.cwd.as_deref().unwrap_or(".")).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() {
            Ok(mut child) => { std::thread::sleep(std::time::Duration::from_millis(500)); let _ = child.kill(); let _ = child.wait(); Ok(json!({"success": true, "message": format!("MCP server '{name}' started successfully")}).to_string()) }
            Err(error) => Ok(json!({"success": false, "message": format!("Failed to start MCP server: {error}")}).to_string()),
        };
    }
    let url = server.url.as_ref().ok_or_else(|| "Remote MCP server is missing a URL".to_string())?;
    let (host, port) = parse_url_host_port(url).ok_or_else(|| "Invalid MCP server URL".to_string())?;
    let address = format!("{host}:{port}");
    let address = address.parse::<std::net::SocketAddr>().or_else(|_| { use std::net::ToSocketAddrs; address.to_socket_addrs().map_err(|error| format!("Failed to resolve MCP server address: {error}")).and_then(|mut addresses| addresses.next().ok_or_else(|| "Unable to resolve MCP server address".to_string())) })?;
    match std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(3)) {
        Ok(_) => Ok(json!({"success": true, "message": format!("MCP server '{name}' is reachable")}).to_string()),
        Err(error) => Ok(json!({"success": false, "message": format!("Failed to connect: {error}")}).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{config_from_json, config_to_codex, config_to_json, transport_supported_by_agent, ANTIGRAVITY, CODEX, OPENCODE, QODER};
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
        let config = super::McpServerConfig { server_type: Some("http".to_string()), url: Some("https://example.test/mcp".to_string()), ..super::empty_config() };
        let value = config_to_json(ANTIGRAVITY, &config);
        assert_eq!(value["serverUrl"], "https://example.test/mcp");
        assert!(value.get("type").is_none());
    }

    #[test]
    fn writes_codex_remote_servers_as_toml_mcp_entries() {
        let config = super::McpServerConfig { server_type: Some("http".to_string()), url: Some("https://example.test/mcp".to_string()), ..super::empty_config() };
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
}
