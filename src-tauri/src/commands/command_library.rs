use crate::path_utils::{display_path, normalize_input_path};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CommandScope {
    Workspace,
    User,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandShell {
    Default,
    Powershell,
    Cmd,
    Bash,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandCwdMode {
    Project,
    Current,
    Custom,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandDraft {
    pub name: String,
    pub description: Option<String>,
    pub template: String,
    pub shell: Option<CommandShell>,
    pub cwd_mode: Option<CommandCwdMode>,
    pub cwd_path: Option<String>,
    pub tags: Option<Vec<String>>,
    pub requires_confirm: Option<bool>,
    pub run_in_new_session: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub scope: CommandScope,
    pub format: String,
    pub allowed_tools: Vec<String>,
    pub supports_test_run: bool,
    pub template: String,
    pub command_preview: String,
    pub shell: CommandShell,
    pub cwd_mode: CommandCwdMode,
    pub cwd_path: Option<String>,
    pub tags: Vec<String>,
    pub requires_confirm: bool,
    pub run_in_new_session: bool,
    pub file_path: String,
    pub source_dir: String,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCatalog {
    pub commands: Vec<CommandInfo>,
    pub workspace_dir: Option<String>,
    pub user_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDetail {
    pub command: CommandInfo,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTestResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub resolved_command: String,
    pub working_directory: String,
    pub shell: CommandShell,
    pub duration_ms: i64,
}

#[derive(Clone)]
struct CommandFrontmatter {
    id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    allowed_tools: Vec<String>,
    shell: Option<CommandShell>,
    cwd: Option<CommandCwdMode>,
    cwd_path: Option<String>,
    tags: Vec<String>,
    requires_confirm: Option<bool>,
    run_in_new_session: Option<bool>,
}

#[derive(Clone)]
struct StoredCommand {
    frontmatter: CommandFrontmatter,
    raw_frontmatter: Mapping,
    file_path: PathBuf,
    template: String,
    updated_at: i64,
    raw_content: String,
}

struct NormalizedDraft {
    name: String,
    description: String,
    template: String,
    shell: CommandShell,
    cwd_mode: CommandCwdMode,
    cwd_path: Option<String>,
    tags: Vec<String>,
    requires_confirm: bool,
    run_in_new_session: bool,
}

#[tauri::command]
pub fn list_commands(project_path: Option<String>) -> Result<CommandCatalog, String> {
    let workspace_dir = resolve_command_dir(CommandScope::Workspace, project_path.as_deref())?;
    let user_dir = resolve_command_dir(CommandScope::User, None)?;

    let mut commands = Vec::new();
    commands.extend(scan_scope_commands(
        CommandScope::Workspace,
        workspace_dir.as_ref(),
    )?);
    commands.extend(scan_scope_commands(CommandScope::User, user_dir.as_ref())?);
    commands.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(CommandCatalog {
        commands,
        workspace_dir: workspace_dir.map(path_to_string),
        user_dir: user_dir
            .map(path_to_string)
            .ok_or_else(|| "无法解析全局命令目录".to_string())?,
    })
}

#[tauri::command]
pub fn get_command_detail(
    scope: CommandScope,
    id: String,
    project_path: Option<String>,
) -> Result<CommandDetail, String> {
    let stored = find_command(scope, &id, project_path.as_deref())?;
    let info = to_command_info(scope, stored.clone());
    Ok(CommandDetail {
        command: info,
        content: stored.raw_content,
    })
}

#[tauri::command]
pub fn create_command(
    scope: CommandScope,
    draft: CommandDraft,
    project_path: Option<String>,
) -> Result<CommandInfo, String> {
    let directory = ensure_command_store_dir(scope, project_path.as_deref())?;
    let normalized = normalize_draft(draft)?;
    let slug = slugify(&normalized.name);
    let file_path = directory.join(format!("{}.md", slug));
    if file_path.exists() {
        return Err(format!("命令文件 '{}' 已存在", display_path(&file_path)));
    }

    let id = format!("{}-{}", slug, now_ms());
    let frontmatter = CommandFrontmatter {
        id: Some(id),
        name: None,
        description: Some(normalized.description),
        allowed_tools: Vec::new(),
        shell: Some(normalized.shell),
        cwd: Some(normalized.cwd_mode),
        cwd_path: normalized.cwd_path,
        tags: normalized.tags,
        requires_confirm: Some(normalized.requires_confirm),
        run_in_new_session: Some(normalized.run_in_new_session),
    };

    let raw_content = build_markdown_content(None, &frontmatter, scope, &normalized.template)?;
    fs::write(&file_path, raw_content.as_bytes()).map_err(|e| e.to_string())?;
    let stored = load_command_markdown(&file_path)?;
    Ok(to_command_info(scope, stored))
}

#[tauri::command]
pub fn update_command(
    scope: CommandScope,
    id: String,
    draft: CommandDraft,
    project_path: Option<String>,
) -> Result<CommandInfo, String> {
    let directory = ensure_command_store_dir(scope, project_path.as_deref())?;
    let existing = find_command(scope, &id, project_path.as_deref())?;
    let normalized = normalize_draft(draft)?;
    let next_slug = slugify(&normalized.name);
    let next_path = directory.join(format!("{}.md", next_slug));

    if next_path != existing.file_path && next_path.exists() {
        return Err(format!("命令文件 '{}' 已存在", display_path(&next_path)));
    }

    let frontmatter = CommandFrontmatter {
        id: existing.frontmatter.id.clone().or(Some(id)),
        name: existing.frontmatter.name.clone(),
        description: Some(normalized.description),
        allowed_tools: existing.frontmatter.allowed_tools.clone(),
        shell: Some(normalized.shell),
        cwd: Some(normalized.cwd_mode),
        cwd_path: normalized.cwd_path,
        tags: normalized.tags,
        requires_confirm: Some(normalized.requires_confirm),
        run_in_new_session: Some(normalized.run_in_new_session),
    };

    let raw_content = build_markdown_content(
        Some(&existing.raw_frontmatter),
        &frontmatter,
        scope,
        &normalized.template,
    )?;
    fs::write(&next_path, raw_content.as_bytes()).map_err(|e| e.to_string())?;
    if next_path != existing.file_path && existing.file_path.exists() {
        fs::remove_file(&existing.file_path).map_err(|e| e.to_string())?;
    }
    let stored = load_command_markdown(&next_path)?;
    Ok(to_command_info(scope, stored))
}

#[tauri::command]
pub fn delete_command(
    scope: CommandScope,
    id: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let stored = find_command(scope, &id, project_path.as_deref())?;
    fs::remove_file(&stored.file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ensure_command_store(
    scope: CommandScope,
    project_path: Option<String>,
) -> Result<String, String> {
    let directory = ensure_command_store_dir(scope, project_path.as_deref())?;
    Ok(path_to_string(directory))
}

#[tauri::command]
pub fn run_command_test(
    scope: CommandScope,
    id: String,
    project_path: Option<String>,
) -> Result<CommandTestResult, String> {
    let stored = find_command(scope, &id, project_path.as_deref())?;

    let working_directory = resolve_working_directory(
        stored
            .frontmatter
            .cwd
            .unwrap_or(default_cwd_mode_for_scope(scope)),
        stored.frontmatter.cwd_path.as_deref(),
        project_path.as_deref(),
    )?;
    let resolved_command = resolve_template(
        &stored.template,
        project_path.as_deref(),
        &working_directory,
    );
    let shell = stored.frontmatter.shell.unwrap_or(CommandShell::Default);
    let mut process = build_shell_command(shell, &resolved_command);
    process
        .current_dir(&working_directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        process.creation_flags(CREATE_NO_WINDOW);
    }

    let started_at = Instant::now();
    let output = wait_with_timeout(process, Duration::from_secs(20))?;
    let duration_ms = started_at.elapsed().as_millis() as i64;

    Ok(CommandTestResult {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        resolved_command,
        working_directory: path_to_string(working_directory),
        shell,
        duration_ms,
    })
}

fn scan_scope_commands(
    scope: CommandScope,
    root: Option<&PathBuf>,
) -> Result<Vec<CommandInfo>, String> {
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut commands = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        match load_command_markdown(&path) {
            Ok(stored) => commands.push(to_command_info(scope, stored)),
            Err(error) => {
                eprintln!(
                    "skip invalid command markdown '{}': {}",
                    display_path(path),
                    error
                );
            }
        }
    }
    Ok(commands)
}

fn find_command(
    scope: CommandScope,
    id: &str,
    project_path: Option<&str>,
) -> Result<StoredCommand, String> {
    let directory = ensure_command_store_dir(scope, project_path)?;
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let stored = load_command_markdown(&path)?;
        if command_identity(&stored) == id {
            return Ok(stored);
        }
    }
    Err("未找到指定命令".to_string())
}

fn ensure_command_store_dir(
    scope: CommandScope,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    let directory = resolve_command_dir(scope, project_path)?
        .ok_or_else(|| "当前没有可用的命令目录".to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

fn resolve_command_dir(
    scope: CommandScope,
    project_path: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    match scope {
        CommandScope::Workspace => {
            let Some(project_path) = project_path.filter(|path| !path.trim().is_empty()) else {
                return Ok(None);
            };
            Ok(Some(
                normalize_path(project_path)
                    .join(".claude")
                    .join("commands"),
            ))
        }
        CommandScope::User => {
            let home = dirs_next::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
            Ok(Some(home.join(".claude").join("commands")))
        }
    }
}

fn load_command_markdown(path: &Path) -> Result<StoredCommand, String> {
    let raw_content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let (frontmatter_text, template) = split_frontmatter(&raw_content)?;
    let (frontmatter, raw_frontmatter) = match frontmatter_text {
        Some(text) => parse_frontmatter(&text)?,
        None => (default_frontmatter_from_file(path), Mapping::new()),
    };

    let updated_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_else(now_ms);

    Ok(StoredCommand {
        frontmatter,
        raw_frontmatter,
        file_path: path.to_path_buf(),
        template,
        updated_at,
        raw_content,
    })
}

fn split_frontmatter(content: &str) -> Result<(Option<String>, String), String> {
    let normalized = content.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    let Some(first_line) = lines.next() else {
        return Ok((None, String::new()));
    };
    if first_line.trim() != "---" {
        return Ok((None, normalized));
    }

    let mut frontmatter_lines = Vec::new();
    let mut body_lines = Vec::new();
    let mut in_frontmatter = true;

    for line in lines {
        if in_frontmatter && line.trim() == "---" {
            in_frontmatter = false;
            continue;
        }
        if in_frontmatter {
            frontmatter_lines.push(line.to_string());
        } else {
            body_lines.push(line.to_string());
        }
    }

    if in_frontmatter {
        return Err("命令 Markdown 的 frontmatter 未正确闭合".to_string());
    }

    let body = body_lines.join("\n").trim_start_matches('\n').to_string();
    Ok((Some(frontmatter_lines.join("\n")), body))
}

fn parse_frontmatter(frontmatter: &str) -> Result<(CommandFrontmatter, Mapping), String> {
    let value: Value = serde_yaml::from_str(frontmatter)
        .map_err(|e| format!("解析命令 frontmatter 失败: {}", e))?;
    let mapping = value
        .as_mapping()
        .cloned()
        .ok_or_else(|| "命令 frontmatter 必须是对象结构".to_string())?;
    Ok((
        CommandFrontmatter {
            id: yaml_string(&mapping, "id"),
            name: yaml_string(&mapping, "name"),
            description: yaml_string(&mapping, "description"),
            allowed_tools: yaml_string_list(&mapping, "allowed-tools"),
            shell: yaml_enum(&mapping, "shell"),
            cwd: yaml_enum_any(&mapping, &["cwd", "cwdMode"]),
            cwd_path: yaml_string_any(&mapping, &["cwdPath", "cwd_path"]),
            tags: yaml_string_list(&mapping, "tags"),
            requires_confirm: yaml_bool_any(&mapping, &["requiresConfirm", "requires_confirm"]),
            run_in_new_session: yaml_bool_any(&mapping, &["runInNewSession", "run_in_new_session"]),
        },
        mapping,
    ))
}

fn default_frontmatter_from_file(_path: &Path) -> CommandFrontmatter {
    CommandFrontmatter {
        id: None,
        name: None,
        description: None,
        allowed_tools: Vec::new(),
        shell: None,
        cwd: None,
        cwd_path: None,
        tags: Vec::new(),
        requires_confirm: None,
        run_in_new_session: None,
    }
}

fn build_markdown_content(
    base_frontmatter: Option<&Mapping>,
    frontmatter: &CommandFrontmatter,
    scope: CommandScope,
    template: &str,
) -> Result<String, String> {
    let yaml_mapping = build_frontmatter_mapping(base_frontmatter, frontmatter, scope);
    let yaml = serde_yaml::to_string(&yaml_mapping).map_err(|e| e.to_string())?;
    let yaml = yaml
        .lines()
        .filter(|line| *line != "---" && *line != "...")
        .collect::<Vec<_>>()
        .join("\n");
    let body = template.trim_end();
    if yaml.trim().is_empty() {
        return Ok(format!("{}\n", body));
    }
    Ok(format!("---\n{}\n---\n\n{}\n", yaml, body))
}

fn normalize_draft(draft: CommandDraft) -> Result<NormalizedDraft, String> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err("命令名称不能为空".to_string());
    }
    let template = draft.template.trim();
    if template.is_empty() {
        return Err("命令模板不能为空".to_string());
    }

    let cwd_mode = draft.cwd_mode.unwrap_or(CommandCwdMode::Project);
    let cwd_path = draft
        .cwd_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    if cwd_mode == CommandCwdMode::Custom && cwd_path.is_none() {
        return Err("自定义工作目录不能为空".to_string());
    }

    let tags = draft
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .fold(Vec::<String>::new(), |mut acc, item| {
            if !acc
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&item))
            {
                acc.push(item);
            }
            acc
        });

    Ok(NormalizedDraft {
        name: name.to_string(),
        description: draft.description.unwrap_or_default().trim().to_string(),
        template: template.to_string(),
        shell: draft.shell.unwrap_or(CommandShell::Default),
        cwd_mode,
        cwd_path,
        tags,
        requires_confirm: draft.requires_confirm.unwrap_or(true),
        run_in_new_session: draft.run_in_new_session.unwrap_or(false),
    })
}

fn to_command_info(scope: CommandScope, stored: StoredCommand) -> CommandInfo {
    let stem = file_stem(&stored.file_path);
    let shell = stored.frontmatter.shell.unwrap_or(CommandShell::Default);
    let cwd_mode = stored
        .frontmatter
        .cwd
        .unwrap_or(default_cwd_mode_for_scope(scope));
    let requires_confirm = stored.frontmatter.requires_confirm.unwrap_or(true);
    let run_in_new_session = stored.frontmatter.run_in_new_session.unwrap_or(false);
    let supports_test_run = stored.frontmatter.shell.is_some()
        || stored.frontmatter.cwd.is_some()
        || stored.frontmatter.cwd_path.is_some()
        || stored.frontmatter.requires_confirm.is_some()
        || stored.frontmatter.run_in_new_session.is_some();
    let format = if supports_test_run || !stored.frontmatter.tags.is_empty() {
        "extended"
    } else {
        "claude_native"
    };
    let source_dir = stored
        .file_path
        .parent()
        .map(path_to_string)
        .unwrap_or_default();
    CommandInfo {
        id: stored
            .frontmatter
            .id
            .clone()
            .unwrap_or_else(|| stem.clone()),
        name: stored.frontmatter.name.unwrap_or_else(|| stem.clone()),
        description: stored.frontmatter.description.unwrap_or_default(),
        scope,
        format: format.to_string(),
        allowed_tools: stored.frontmatter.allowed_tools,
        supports_test_run,
        template: stored.template.clone(),
        command_preview: build_command_preview(&stored.template),
        shell,
        cwd_mode,
        cwd_path: stored.frontmatter.cwd_path,
        tags: stored.frontmatter.tags,
        requires_confirm,
        run_in_new_session,
        file_path: path_to_string(&stored.file_path),
        source_dir,
        updated_at: stored.updated_at,
    }
}

fn resolve_working_directory(
    cwd_mode: CommandCwdMode,
    cwd_path: Option<&str>,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    match cwd_mode {
        CommandCwdMode::Project => {
            let project = project_path
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "当前没有可用的项目路径".to_string())?;
            Ok(normalize_path(project))
        }
        CommandCwdMode::Current => std::env::current_dir().map_err(|e| e.to_string()),
        CommandCwdMode::Custom => {
            let custom = cwd_path
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "未设置自定义工作目录".to_string())?;
            Ok(normalize_path(custom))
        }
    }
}

fn build_frontmatter_mapping(
    base_frontmatter: Option<&Mapping>,
    frontmatter: &CommandFrontmatter,
    scope: CommandScope,
) -> Mapping {
    let mut mapping = base_frontmatter.cloned().unwrap_or_default();
    set_yaml_string(
        &mut mapping,
        "description",
        frontmatter.description.as_deref(),
    );
    set_yaml_string_list(&mut mapping, "allowed-tools", &frontmatter.allowed_tools);

    let default_cwd = default_cwd_mode_for_scope(scope);
    upsert_optional_enum(
        &mut mapping,
        "shell",
        frontmatter.shell,
        CommandShell::Default,
    );
    upsert_optional_enum(&mut mapping, "cwd", frontmatter.cwd, default_cwd);

    if let Some(value) = frontmatter
        .cwd_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        mapping.insert(
            Value::String("cwdPath".to_string()),
            Value::String(value.to_string()),
        );
        mapping.remove(Value::String("cwd_path".to_string()));
    } else {
        mapping.remove(Value::String("cwdPath".to_string()));
        mapping.remove(Value::String("cwd_path".to_string()));
    }

    set_yaml_string_list(&mut mapping, "tags", &frontmatter.tags);
    upsert_optional_bool(
        &mut mapping,
        "requiresConfirm",
        frontmatter.requires_confirm,
        true,
    );
    upsert_optional_bool(
        &mut mapping,
        "runInNewSession",
        frontmatter.run_in_new_session,
        false,
    );
    mapping
}

fn resolve_template(
    template: &str,
    project_path: Option<&str>,
    working_directory: &Path,
) -> String {
    let home_dir = dirs_next::home_dir()
        .map(path_to_string)
        .unwrap_or_default();
    let project_dir = project_path
        .filter(|value| !value.trim().is_empty())
        .map(normalize_path);
    let project_dir_text = project_dir.as_ref().map(path_to_string).unwrap_or_default();
    let project_name = project_dir
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();

    template
        .replace("${projectPath}", &project_dir_text)
        .replace("${projectName}", &project_name)
        .replace("${cwd}", &path_to_string(working_directory))
        .replace("${homeDir}", &home_dir)
}

fn build_shell_command(shell: CommandShell, command_text: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        match shell {
            CommandShell::Default | CommandShell::Powershell => {
                let mut command = Command::new("powershell.exe");
                command
                    .arg("-NoProfile")
                    .arg("-NonInteractive")
                    .arg("-ExecutionPolicy")
                    .arg("Bypass")
                    .arg("-Command")
                    .arg(command_text);
                command
            }
            CommandShell::Cmd => {
                let mut command = Command::new("cmd.exe");
                command.arg("/C").arg(command_text);
                command
            }
            CommandShell::Bash => {
                let mut command = Command::new("bash");
                command.arg("-lc").arg(command_text);
                command
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match shell {
            CommandShell::Cmd => {
                let mut command = Command::new("sh");
                command.arg("-lc").arg(command_text);
                command
            }
            CommandShell::Default | CommandShell::Bash => {
                let mut command = Command::new("bash");
                command.arg("-lc").arg(command_text);
                command
            }
            CommandShell::Powershell => {
                let mut command = Command::new("pwsh");
                command.arg("-Command").arg(command_text);
                command
            }
        }
    }
}

fn wait_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动命令失败: {}", e))?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("读取命令输出失败: {}", e));
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("命令测试运行超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("等待命令进程失败: {}", e));
            }
        }
    }
}

fn build_command_preview(template: &str) -> String {
    let condensed = template.split_whitespace().collect::<Vec<_>>().join(" ");
    if condensed.chars().count() > 120 {
        condensed.chars().take(120).collect::<String>() + "..."
    } else {
        condensed
    }
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;

    for ch in input.chars() {
        let normalized = match ch {
            'A'..='Z' => ch.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' => ch,
            '-' | '_' | ' ' => '-',
            _ if ch.is_ascii_punctuation() => '-',
            _ => '-',
        };
        if normalized == '-' {
            if !previous_dash && !out.is_empty() {
                out.push('-');
            }
            previous_dash = true;
        } else {
            out.push(normalized);
            previous_dash = false;
        }
    }

    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "command".to_string()
    } else {
        trimmed.to_string()
    }
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("command")
        .to_string()
}

fn command_identity(stored: &StoredCommand) -> String {
    stored
        .frontmatter
        .id
        .clone()
        .unwrap_or_else(|| file_stem(&stored.file_path))
}

fn default_cwd_mode_for_scope(scope: CommandScope) -> CommandCwdMode {
    match scope {
        CommandScope::Workspace => CommandCwdMode::Project,
        CommandScope::User => CommandCwdMode::Current,
    }
}

fn yaml_key(key: &str) -> Value {
    Value::String(key.to_string())
}

fn yaml_string(mapping: &Mapping, key: &str) -> Option<String> {
    mapping
        .get(yaml_key(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn yaml_string_any(mapping: &Mapping, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| yaml_string(mapping, key))
}

fn yaml_bool_any(mapping: &Mapping, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| mapping.get(yaml_key(key)).and_then(|value| value.as_bool()))
}

fn yaml_enum<T>(mapping: &Mapping, key: &str) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    mapping
        .get(yaml_key(key))
        .cloned()
        .and_then(|value| serde_yaml::from_value(value).ok())
}

fn yaml_enum_any<T>(mapping: &Mapping, keys: &[&str]) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    keys.iter().find_map(|key| yaml_enum(mapping, key))
}

fn yaml_string_list(mapping: &Mapping, key: &str) -> Vec<String> {
    let Some(value) = mapping.get(yaml_key(key)) else {
        return Vec::new();
    };
    match value {
        Value::String(text) => text
            .split([',', '\n'])
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| item.to_string())
            .collect(),
        Value::Sequence(list) => list
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| item.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

fn set_yaml_string(mapping: &mut Mapping, key: &str, value: Option<&str>) {
    if let Some(text) = value.filter(|text| !text.trim().is_empty()) {
        mapping.insert(yaml_key(key), Value::String(text.to_string()));
    } else {
        mapping.remove(yaml_key(key));
    }
}

fn set_yaml_string_list(mapping: &mut Mapping, key: &str, values: &[String]) {
    if values.is_empty() {
        mapping.remove(yaml_key(key));
        return;
    }
    mapping.insert(
        yaml_key(key),
        Value::Sequence(
            values
                .iter()
                .map(|value| Value::String(value.clone()))
                .collect(),
        ),
    );
}

fn upsert_optional_bool(mapping: &mut Mapping, key: &str, value: Option<bool>, default: bool) {
    match value {
        Some(value) if value != default || mapping.contains_key(yaml_key(key)) => {
            mapping.insert(yaml_key(key), Value::Bool(value));
        }
        _ => {
            mapping.remove(yaml_key(key));
        }
    }
}

fn upsert_optional_enum<T>(mapping: &mut Mapping, key: &str, value: Option<T>, default: T)
where
    T: Serialize + PartialEq + Copy,
{
    match value {
        Some(value) if value != default || mapping.contains_key(yaml_key(key)) => {
            if let Ok(serialized) = serde_yaml::to_value(value) {
                mapping.insert(yaml_key(key), serialized);
            }
        }
        _ => {
            mapping.remove(yaml_key(key));
        }
    }
}

fn normalize_path(path: &str) -> PathBuf {
    normalize_input_path(path)
}

fn path_to_string(path: impl AsRef<Path>) -> String {
    display_path(path)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
