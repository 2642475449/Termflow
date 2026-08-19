use super::git::checkpoint::{self, AgentTurnStartResult};
use crate::path_utils::normalize_input_path;
use crate::pty::ActiveAgentTurn;
use crate::pty::{
    check_claude_ready_in_shell, find_claude_exe, kill_stale_claude_processes, PtyManager,
};
use log::warn;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliInfo {
    pub available: bool,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    pub checked_at: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentHookConfigurationFailedPayload {
    session_id: String,
    agent_id: String,
    error: String,
}

const INTERACTIVE_BASELINE_TIMEOUT: Duration = Duration::from_millis(1_500);
const PREVIOUS_TURN_COMPLETION_TIMEOUT: Duration = Duration::from_millis(750);

// 修复 H-02: 原 `launch_session` 命令存在命令注入漏洞(SEC-001):
//   format!("cd /d \"{}\" && ...", path) 直接把用户输入拼到 cmd /k 字符串,
//   含 `"`、`&`、`|`、`;` 的路径可逃逸引号执行任意命令。
// 该函数是遗留死代码(全项目无调用方),已删除。请改用安全的 `spawn_pty`。

/// 创建嵌入式 PTY 会话
#[tauri::command]
pub async fn spawn_pty(
    session_id: String,
    path: String,
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
    resume: Option<bool>,
    skip_permissions: Option<bool>,
    startup_command: Option<String>,
    initial_prompt: Option<String>,
    shell_type: Option<String>,
    claude_effort: Option<String>,
    agent_id: Option<String>,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("项目路径不能为空".into());
    }
    // Shell sessions do not support Agent status hooks.  Do not attempt their
    // configuration here, otherwise a successful PowerShell/CMD launch emits a
    // misleading "Hook unavailable" warning to the user.
    if let Some(agent_id) = agent_id
        .as_deref()
        .filter(|agent_id| *agent_id != "powershell" && *agent_id != "cmd")
    {
        let hook_error =
            match super::agent_hooks::ensure_agent_status_hook(agent_id.to_string()) {
                Ok(status) if !status.configured => Some(status.detail.unwrap_or_else(|| {
                    format!("Hook 配置未通过完整性检查：{}", status.config_path)
                })),
                Ok(_) => None,
                Err(error) => Some(error),
            };
        if let Some(error) = hook_error {
            // Status integration is best-effort and must never prevent the terminal from opening.
            warn!("failed to configure {agent_id} status hook: {error}");
            let _ = app.emit(
                "agent-hook-configuration-failed",
                AgentHookConfigurationFailedPayload {
                    session_id: session_id.clone(),
                    agent_id: agent_id.to_string(),
                    error,
                },
            );
        }
    }
    let checkpoint_agent_id = agent_id.as_deref().unwrap_or("generic-cli");
    let initial_turn = initial_prompt
        .as_deref()
        .filter(|prompt| !prompt.trim().is_empty())
        .filter(|_| checkpoint_agent_id != "powershell" && checkpoint_agent_id != "cmd")
        .and_then(|_| {
            checkpoint::begin_turn_with_timeout(
                &path,
                &session_id,
                checkpoint_agent_id,
                INTERACTIVE_BASELINE_TIMEOUT,
            )
            .ok()
        });
    let app_for_checkpoint = app.clone();
    let manager = manager.inner().clone();
    let spawned_session_id = session_id.clone();
    let result = manager.spawn(
        spawned_session_id.clone(),
        path,
        app,
        resume.unwrap_or(false),
        skip_permissions.unwrap_or(false),
        startup_command,
        initial_prompt,
        shell_type.as_deref().unwrap_or("powershell"),
        claude_effort,
        agent_id,
    );
    let result = match result {
        Ok(Some(control)) => {
            let delivery = tauri::async_runtime::spawn_blocking(move || control.deliver())
                .await
                .map_err(|error| format!("OpenCode 本地控制任务失败: {error}"))
                .and_then(|result| result);
            if let Err(error) = delivery {
                manager.close(&spawned_session_id);
                Err(format!("OpenCode 无法接收完整初始提问: {error}"))
            } else {
                Ok(())
            }
        }
        Ok(None) => Ok(()),
        Err(error) => Err(error),
    };
    if result.is_ok() {
        if let Some(turn) = initial_turn {
            manager.mark_prompt_submitted(&turn.session_id);
            manager.replace_active_turn(
                &turn.session_id,
                ActiveAgentTurn {
                    id: turn.id.clone(),
                    project_path: turn.project_path.clone(),
                },
            );
            let _ = app_for_checkpoint.emit("checkpoint-turn-started", turn);
        }
    }
    result
}

/// 在创建会话前检查 Claude Code 是否可用
#[tauri::command]
pub fn check_claude_ready() -> Result<(), String> {
    check_claude_ready_in_shell()
}

#[tauri::command]
pub fn get_claude_cli_info() -> ClaudeCliInfo {
    let checked_at = current_timestamp_ms();
    let executable_path = find_claude_exe().ok();

    match run_claude_version_command() {
        Ok(version) => ClaudeCliInfo {
            available: true,
            version: Some(version),
            executable_path,
            checked_at,
            error: None,
        },
        Err(error) => ClaudeCliInfo {
            available: false,
            version: None,
            executable_path,
            checked_at,
            error: Some(error),
        },
    }
}

/// 向 PTY 写入数据
#[tauri::command]
pub fn pty_input(
    session_id: String,
    data: String,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    manager.write_input(&session_id, &data)
}

/// 标记一轮用户提问已提交，用于计算 Claude 回答耗时
#[tauri::command]
pub fn mark_session_prompt_submitted(session_id: String, manager: State<'_, Arc<PtyManager>>) {
    manager.mark_prompt_submitted(&session_id);
}

/// Atomically capture a provider-independent turn baseline before forwarding Enter to the PTY.
/// Checkpoint failures never block the CLI: the input is still delivered and a warning is returned.
#[tauri::command]
pub async fn submit_agent_turn_input(
    session_id: String,
    data: String,
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<AgentTurnStartResult, String> {
    let manager = manager.inner().clone();
    let (project_path, agent_id) = manager
        .session_context(&session_id)
        .ok_or_else(|| "Session is not active".to_string())?;

    if agent_id == "powershell" || agent_id == "cmd" {
        manager.write_input(&session_id, &data)?;
        return Ok(AgentTurnStartResult {
            turn: None,
            completed_previous: None,
            warning: None,
        });
    }

    let manager_for_checkpoint = manager.clone();
    let session_for_checkpoint = session_id.clone();
    let project_for_checkpoint = project_path.clone();
    let checkpoint_result = tauri::async_runtime::spawn_blocking(move || {
        let mut warnings = Vec::new();
        let completed_previous = match manager_for_checkpoint.complete_active_turn_with_timeout(
            &session_for_checkpoint,
            "next_prompt",
            PREVIOUS_TURN_COMPLETION_TIMEOUT,
        ) {
            Ok(turn) => turn,
            Err(error) => {
                warnings.push(format!(
                    "Previous turn checkpoint could not be completed: {error}"
                ));
                None
            }
        };
        let turn = match checkpoint::begin_turn_with_timeout(
            &project_for_checkpoint,
            &session_for_checkpoint,
            &agent_id,
            INTERACTIVE_BASELINE_TIMEOUT,
        ) {
            Ok(turn) => {
                manager_for_checkpoint.replace_active_turn(
                    &session_for_checkpoint,
                    ActiveAgentTurn {
                        id: turn.id.clone(),
                        project_path: project_for_checkpoint,
                    },
                );
                Some(turn)
            }
            Err(error) => {
                warnings.push(format!("Checkpoint is unavailable for this turn: {error}"));
                None
            }
        };
        AgentTurnStartResult {
            turn,
            completed_previous,
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join("; "))
            },
        }
    })
    .await
    .map_err(|error| format!("Checkpoint task failed: {error}"))?;

    // The baseline exists before Enter reaches the agent, so pre-existing dirty changes
    // cannot be attributed to this turn.
    manager.write_input(&session_id, &data)?;
    manager.mark_prompt_submitted(&session_id);
    if let Some(review) = checkpoint_result.completed_previous.clone() {
        let _ = app.emit("checkpoint-review-ready", review);
    }
    Ok(checkpoint_result)
}

#[tauri::command]
pub async fn complete_agent_turn(
    session_id: String,
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Option<super::git::checkpoint::AgentTurnReview>, String> {
    let manager = manager.inner().clone();
    let session_for_task = session_id.clone();
    let review = tauri::async_runtime::spawn_blocking(move || {
        manager.complete_active_turn(&session_for_task, "user_confirmed")
    })
    .await
    .map_err(|error| format!("Checkpoint task failed: {error}"))??;
    if let Some(review) = review.clone() {
        let _ = app.emit("checkpoint-review-ready", review);
    }
    Ok(review)
}

/// 使用 Claude Code 提炼会话标题；失败时返回安全的本地兜底标题
#[tauri::command]
pub fn generate_session_title(prompt: String, path: String) -> Result<String, String> {
    let fallback = sanitize_fallback_session_title(&prompt)
        .ok_or_else(|| "无法从当前输入提炼标题".to_string())?;

    let ai_title = run_ai_title_generation(&prompt, &path)
        .ok()
        .and_then(|output| sanitize_ai_session_title(&output));

    Ok(ai_title.unwrap_or(fallback))
}

/// 调整 PTY 大小
#[tauri::command]
pub fn pty_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    manager.resize(&session_id, rows, cols)
}

/// 关闭 PTY 会话
#[tauri::command]
pub fn close_pty(session_id: String, manager: State<'_, Arc<PtyManager>>) {
    manager.close(&session_id);
}

/// 清理残留的 claude 进程（用于会话恢复前）
#[tauri::command]
pub fn cleanup_stale_sessions() -> Result<(), String> {
    kill_stale_claude_processes()
}

/// 仅清理指定会话的残留进程（不影响其他项目的会话）
#[tauri::command]
pub fn cleanup_session_process(session_id: String, manager: State<'_, Arc<PtyManager>>) {
    manager.cleanup_session_process(&session_id);
}

/// 检查会话是否活跃
#[tauri::command]
pub fn is_session_active(session_id: String, manager: State<'_, Arc<PtyManager>>) -> bool {
    manager.is_session_active(&session_id)
}

/// 在系统文件管理器中打开指定路径
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let target = normalize_input_path(path.trim());
    if !target.exists() {
        return Err("目标路径不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        if target.is_file() {
            // Keep the switch and target as separate arguments. Passing them as
            // one quoted argument makes Explorer ignore `/select,` for paths
            // containing spaces or non-ASCII characters, opening only the folder.
            command.arg("/select,").arg(&target);
        } else {
            command.arg(target);
        }

        command
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R").arg(&target);
        } else {
            command.arg(&target);
        }

        command
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let reveal_target = if target.is_file() {
            target.parent().unwrap_or(&target)
        } else {
            &target
        };

        Command::new("xdg-open")
            .arg(reveal_target)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }

    Ok(())
}

/// 使用系统关联应用打开指定路径
#[tauri::command]
pub fn open_in_associated_application(path: String) -> Result<(), String> {
    let target = normalize_input_path(path.trim());
    if !target.exists() {
        return Err("目标路径不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("使用关联应用打开失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("使用关联应用打开失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("使用关联应用打开失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn resolve_recent_codex_session_id(
    project_path: String,
    since_timestamp_ms: Option<i64>,
) -> Result<Option<String>, String> {
    let home_dir = dirs_next::home_dir().ok_or("无法获取用户主目录")?;
    let sessions_root = home_dir.join(".codex").join("sessions");
    if !sessions_root.exists() {
        return Ok(None);
    }

    let normalized_project_path = normalize_path_for_compare(&project_path);
    let since_timestamp_ms = since_timestamp_ms.unwrap_or(0);
    let deadline = Instant::now() + Duration::from_secs(3);

    loop {
        if let Some(session_id) = find_recent_codex_session_id(
            &sessions_root,
            &normalized_project_path,
            since_timestamp_ms,
        )? {
            return Ok(Some(session_id));
        }

        if Instant::now() >= deadline {
            return Ok(None);
        }

        std::thread::sleep(Duration::from_millis(150));
    }
}

fn find_recent_codex_session_id(
    sessions_root: &Path,
    normalized_project_path: &str,
    since_timestamp_ms: i64,
) -> Result<Option<String>, String> {
    let mut best: Option<(i64, String)> = None;
    visit_codex_session_files(sessions_root, &mut |path| {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(()),
        };

        let modified_at_ms = system_time_to_ms(metadata.modified().ok());
        if modified_at_ms < since_timestamp_ms {
            return Ok(());
        }

        let file = match File::open(path) {
            Ok(file) => file,
            Err(_) => return Ok(()),
        };
        let mut reader = BufReader::new(file);
        let mut first_line = String::new();
        if reader.read_line(&mut first_line).is_err() || first_line.trim().is_empty() {
            return Ok(());
        }

        let Ok(value) = serde_json::from_str::<Value>(first_line.trim()) else {
            return Ok(());
        };
        let Some(payload) = value.get("payload") else {
            return Ok(());
        };
        let Some(cwd) = payload.get("cwd").and_then(Value::as_str) else {
            return Ok(());
        };
        if normalize_path_for_compare(cwd) != normalized_project_path {
            return Ok(());
        }

        let Some(session_id) = payload
            .get("session_id")
            .and_then(Value::as_str)
            .or_else(|| payload.get("id").and_then(Value::as_str))
        else {
            return Ok(());
        };

        if best
            .as_ref()
            .map(|(existing_ms, _)| modified_at_ms > *existing_ms)
            .unwrap_or(true)
        {
            best = Some((modified_at_ms, session_id.to_string()));
        }

        Ok(())
    })?;

    Ok(best.map(|(_, session_id)| session_id))
}

fn visit_codex_session_files(
    root: &Path,
    visitor: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_dir() {
            visit_codex_session_files(&path, visitor)?;
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            visitor(&path)?;
        }
    }

    Ok(())
}

fn normalize_path_for_compare(path: &str) -> String {
    let trimmed = path.trim().replace('/', "\\");
    #[cfg(target_os = "windows")]
    {
        trimmed.to_ascii_lowercase()
    }

    #[cfg(not(target_os = "windows"))]
    {
        trimmed
    }
}

fn system_time_to_ms(value: Option<SystemTime>) -> i64 {
    value
        .and_then(|instant| instant.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn run_ai_title_generation(prompt: &str, path: &str) -> Result<String, String> {
    let claude_path = find_claude_exe()?;
    let title_prompt = format!(
        "请根据下面这段用户首条输入，提炼一个简短自然的中文会话标题。\n\
要求：\n\
1. 输出 8-16 个字，最多不超过 24 个字符\n\
2. 不要使用书名号、方括号、引号、emoji 或特殊符号\n\
3. 不要出现“请帮我”“我想”“怎么”“为什么”等口语前缀\n\
4. 尽量保留任务主题和核心对象\n\
5. 只输出标题本身，不要解释，不要换行前后附加内容\n\n\
用户输入：\n{}",
        prompt.trim()
    );

    let mut command = build_claude_print_command(&claude_path, &title_prompt);
    if !path.trim().is_empty() {
        command.current_dir(path.trim());
    }

    let output = run_command_with_timeout(command, Duration::from_secs(12))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Claude 标题提炼失败".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err("Claude 未返回标题".to_string());
    }

    Ok(stdout)
}

fn run_claude_version_command() -> Result<String, String> {
    let claude_path = find_claude_exe()?;
    let mut command = build_cli_command(&claude_path);
    command.arg("--version");

    let output = command
        .output()
        .map_err(|e| format!("无法读取 Claude 版本: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "claude --version 执行失败".to_string()
        });
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        Err("Claude 版本输出为空".to_string())
    } else {
        Ok(version)
    }
}

fn build_claude_print_command(claude_path: &str, prompt: &str) -> Command {
    let mut command = build_cli_command(claude_path);

    command
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("text")
        .arg("--max-turns")
        .arg("1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    command
}

fn build_cli_command(executable_path: &str) -> Command {
    let lower_path = executable_path.to_ascii_lowercase();
    let mut command = if cfg!(target_os = "windows")
        && (lower_path.ends_with(".cmd") || lower_path.ends_with(".bat"))
    {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/d").arg("/c").arg(executable_path);
        cmd
    } else if cfg!(target_os = "windows") && lower_path.ends_with(".ps1") {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            executable_path,
        ]);
        cmd
    } else {
        Command::new(executable_path)
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 Claude 标题提炼失败: {}", e))?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("读取 Claude 标题提炼结果失败: {}", e));
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Claude 标题提炼超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("等待 Claude 标题提炼进程失败: {}", e));
            }
        }
    }
}

fn sanitize_ai_session_title(input: &str) -> Option<String> {
    let title = sanitize_session_title(input, true)?;
    if is_invalid_generated_title(&title) {
        None
    } else {
        Some(title)
    }
}

fn sanitize_fallback_session_title(input: &str) -> Option<String> {
    sanitize_session_title(input, false)
}

fn sanitize_session_title(input: &str, is_ai_result: bool) -> Option<String> {
    let source = if is_ai_result {
        input.lines().next().unwrap_or(input)
    } else {
        input
            .split(|c| matches!(c, '\r' | '\n' | '。' | '！' | '？' | ';' | '；'))
            .next()
            .unwrap_or(input)
    };

    // Remove ANSI escape sequences (CSI and SS3)
    let ansi_cleaned = strip_ansi_sequences(source);

    let mut cleaned = String::new();
    let mut previous_space = false;
    for ch in ansi_cleaned.chars() {
        if is_allowed_title_char(ch) {
            if ch.is_whitespace() {
                if !previous_space {
                    cleaned.push(' ');
                }
                previous_space = true;
            } else {
                cleaned.push(ch);
                previous_space = false;
            }
        } else if !previous_space {
            cleaned.push(' ');
            previous_space = true;
        }
    }

    let mut title = cleaned
        .trim()
        .trim_matches(|c: char| "-_/&+.#:% ".contains(c))
        .to_string();

    while let Some(stripped) = strip_title_meta_prefix(&title) {
        title = stripped.to_string();
    }

    while let Some(stripped) = strip_spoken_prefix(&title) {
        title = stripped.to_string();
    }

    title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if title.is_empty() || looks_like_noise_title(&title) {
        return None;
    }

    let truncated = truncate_chars(&title, 24);
    if truncated.is_empty() {
        None
    } else {
        Some(truncated)
    }
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut result = String::new();
    let mut chars = input.chars();
    let mut in_sequence = false;

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            in_sequence = true;
            continue;
        }

        if in_sequence {
            // CSI sequences end with @-~, SS3 sequences are just ESC O + char
            if ('@'..='~').contains(&ch) || ch == '|' {
                in_sequence = false;
            }
            continue;
        }

        result.push(ch);
    }

    result
}

fn strip_title_meta_prefix(input: &str) -> Option<&str> {
    [
        "会话标题",
        "标题生成请求",
        "Session Title",
        "session title",
        "标题",
        "Title",
        "title",
    ]
    .into_iter()
    .find_map(|prefix| {
        input.strip_prefix(prefix).map(|stripped| {
            stripped.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace())
        })
    })
}

fn strip_spoken_prefix(input: &str) -> Option<&str> {
    [
        "请帮我",
        "帮我",
        "我想要",
        "我想",
        "请问",
        "请",
        "麻烦你",
        "麻烦",
        "如何",
        "怎么",
        "为什么",
        "帮忙",
        "看下",
        "看一下",
    ]
    .into_iter()
    .find_map(|prefix| input.strip_prefix(prefix).map(str::trim_start))
}

fn is_allowed_title_char(ch: char) -> bool {
    ch.is_alphanumeric()
        || ch.is_whitespace()
        || matches!(ch, '-' | '_' | '/' | '&' | '+' | '.' | '#' | ':' | '%')
}

fn looks_like_noise_title(title: &str) -> bool {
    let normalized = title.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    let invalid_phrases = [
        "会话标题",
        "标题生成",
        "生成请求",
        "session title",
        "title generation",
        "generation request",
        "根据你的输入",
        "根据您的输入",
        "建议标题",
        "标题建议",
    ];
    if invalid_phrases
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return true;
    }

    let tokens: Vec<&str> = title
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .collect();
    let single_char_tokens = tokens
        .iter()
        .filter(|token| token.chars().count() == 1)
        .count();
    if tokens.len() >= 4 && (single_char_tokens as f32 / tokens.len() as f32) >= 0.6 {
        return true;
    }

    let unique_tokens = tokens
        .iter()
        .map(|token| token.to_lowercase())
        .collect::<std::collections::BTreeSet<_>>();
    if tokens.len() >= 5 && unique_tokens.len() <= 2 {
        return true;
    }

    let has_han = title.chars().any(is_han_char);
    if !has_han && tokens.len() >= 4 && single_char_tokens >= 3 {
        return true;
    }

    false
}

fn is_han_char(ch: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&ch)
        || ('\u{3400}'..='\u{4DBF}').contains(&ch)
        || ('\u{F900}'..='\u{FAFF}').contains(&ch)
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for (index, ch) in input.chars().enumerate() {
        if index >= max_chars {
            break;
        }
        output.push(ch);
    }
    output
}

fn is_invalid_generated_title(title: &str) -> bool {
    let normalized = title.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    let invalid_phrases = [
        "请提供",
        "还没有看到",
        "未看到",
        "无法判断",
        "无法提炼",
        "无法生成",
        "请补充",
        "请说明",
        "请描述",
        "请告诉我",
        "我还不知道",
        "我还没有",
        "我无法",
        "无法根据",
        "根据你提供",
        "根据当前内容",
        "需要更多信息",
        "缺少信息",
        "缺少内容",
        "没有看到",
        "没有实际输入",
        "没有足够信息",
        "请先提供",
        "请提供问题",
        "请提供内容",
        "请提供更多",
        "根据您的首条输入",
        "根据你的首条输入",
        "根据首条输入",
        "根据您的输入",
        "根据你的输入",
        "这个会话的标题",
        "该会话的标题",
        "标题建议为",
        "标题可以是",
        "建议标题",
        "建议命名为",
        "这是对话的第一条消息",
        "这是会话的第一条消息",
        "这段内容更像",
        "更合适的标题是",
        "可作为标题",
        "可以作为标题",
        "标题应为",
        "标题如下",
        "首条消息",
        "首条输入",
        "title:",
        "标题:",
        "标题：",
    ];

    if invalid_phrases
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return true;
    }

    let invalid_endings = ["请提供问题", "请提供内容", "请补充说明", "请补充信息"];
    if invalid_endings
        .iter()
        .any(|ending| normalized.ends_with(ending))
    {
        return true;
    }

    let char_count = title.chars().count();
    let sentence_markers = [
        "根据",
        "建议",
        "标题",
        "会话",
        "输入",
        "消息",
        "内容",
        "问题",
        "如下",
        "应为",
        "建议为",
    ];
    let sentence_marker_count = sentence_markers
        .iter()
        .filter(|token| title.contains(**token))
        .count();
    if char_count > 10 && sentence_marker_count >= 3 {
        return true;
    }

    if char_count > 18
        && ["请", "问题", "内容", "输入", "提供", "看到", "实际", "补充"]
            .iter()
            .filter(|token| title.contains(**token))
            .count()
            >= 2
    {
        return true;
    }

    if looks_like_explanatory_sentence(title) {
        return true;
    }

    false
}

fn current_timestamp_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn looks_like_explanatory_sentence(title: &str) -> bool {
    let char_count = title.chars().count();
    if char_count < 12 {
        return false;
    }

    let punctuation_like_count = title
        .chars()
        .filter(|ch| matches!(ch, '，' | ',' | '。' | '：' | ':' | '；' | ';'))
        .count();
    if punctuation_like_count > 0 {
        return true;
    }

    let function_word_count = [
        "根据", "这是", "这个", "可以", "作为", "建议", "因为", "需要", "如果", "没有", "看到",
        "提供",
    ]
    .iter()
    .filter(|token| title.contains(**token))
    .count();

    function_word_count >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── truncate_chars ──

    #[test]
    fn test_truncate_chars_within_limit() {
        assert_eq!(truncate_chars("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_chars_exact_limit() {
        assert_eq!(truncate_chars("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_chars_exceeds_limit() {
        assert_eq!(truncate_chars("hello world", 5), "hello");
    }

    #[test]
    fn test_truncate_chars_empty() {
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn test_truncate_chars_unicode() {
        assert_eq!(truncate_chars("你好世界", 2), "你好");
    }

    // ── strip_spoken_prefix ──

    #[test]
    fn test_strip_spoken_prefix_removes_common_prefixes() {
        assert_eq!(strip_spoken_prefix("帮我写代码"), Some("写代码"));
        assert_eq!(strip_spoken_prefix("请帮我修复bug"), Some("修复bug"));
        assert_eq!(strip_spoken_prefix("我想学习Rust"), Some("学习Rust"));
        assert_eq!(strip_spoken_prefix("如何实现登录"), Some("实现登录"));
        assert_eq!(strip_spoken_prefix("怎么配置环境"), Some("配置环境"));
        assert_eq!(strip_spoken_prefix("为什么报错"), Some("报错"));
    }

    #[test]
    fn test_strip_spoken_prefix_returns_none_for_no_prefix() {
        assert_eq!(strip_spoken_prefix("实现登录功能"), None);
        assert_eq!(strip_spoken_prefix("修复bug"), None);
    }

    // ── is_allowed_title_char ──

    #[test]
    fn test_is_allowed_title_char_basic() {
        assert!(is_allowed_title_char('a'));
        assert!(is_allowed_title_char('Z'));
        assert!(is_allowed_title_char('0'));
        assert!(is_allowed_title_char(' '));
        assert!(is_allowed_title_char('-'));
        assert!(is_allowed_title_char('_'));
        assert!(is_allowed_title_char('/'));
        assert!(is_allowed_title_char('&'));
        assert!(is_allowed_title_char('+'));
        assert!(is_allowed_title_char('.'));
        assert!(is_allowed_title_char('#'));
        assert!(is_allowed_title_char(':'));
        assert!(is_allowed_title_char('%'));
    }

    #[test]
    fn test_is_allowed_title_char_chinese() {
        assert!(is_allowed_title_char('你'));
        assert!(is_allowed_title_char('好'));
    }

    #[test]
    fn test_is_allowed_title_char_special() {
        assert!(!is_allowed_title_char('!'));
        assert!(!is_allowed_title_char('@'));
        assert!(!is_allowed_title_char('$'));
        assert!(!is_allowed_title_char('^'));
        assert!(!is_allowed_title_char('('));
        assert!(!is_allowed_title_char(')'));
    }

    // ── sanitize_session_title (fallback) ──

    #[test]
    fn test_sanitize_fallback_title_basic() {
        let result = sanitize_fallback_session_title("帮我写一个登录功能");
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "写一个登录功能");
    }

    #[test]
    fn test_sanitize_fallback_title_removes_newlines() {
        let result = sanitize_fallback_session_title("第一行\n第二行");
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "第一行");
    }

    #[test]
    fn test_sanitize_fallback_title_removes_punctuation() {
        let result = sanitize_fallback_session_title("你好！世界。");
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "你好");
    }

    #[test]
    fn test_sanitize_fallback_title_empty_input() {
        assert!(sanitize_fallback_session_title("").is_none());
    }

    #[test]
    fn test_sanitize_fallback_title_only_prefix() {
        assert!(sanitize_fallback_session_title("帮我").is_none());
    }

    #[test]
    fn test_sanitize_fallback_title_truncates_long() {
        let long_input = "这是一个非常非常非常非常非常非常非常非常非常长的标题";
        let result = sanitize_fallback_session_title(long_input);
        assert!(result.is_some());
        assert!(result.unwrap().chars().count() <= 24);
    }

    // ── sanitize_session_title (AI result) ──

    #[test]
    fn test_sanitize_ai_title_removes_title_prefix() {
        let result = sanitize_session_title("标题：登录功能实现", true);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "登录功能实现");
    }

    #[test]
    fn test_sanitize_ai_title_removes_title_colon() {
        let result = sanitize_session_title("Title: Login Feature", true);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "Login Feature");
    }

    #[test]
    fn test_sanitize_ai_title_multiline() {
        let result = sanitize_session_title("第一行标题\n第二行内容", true);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "第一行标题");
    }

    #[test]
    fn test_sanitize_ai_title_rejects_title_generation_meta_text() {
        assert!(sanitize_session_title("会话标题 会话标题生成请求", true).is_none());
        assert!(sanitize_session_title("Session Title title generation request", true).is_none());
    }

    #[test]
    fn test_sanitize_fallback_title_rejects_single_char_noise() {
        assert!(sanitize_fallback_session_title("o o o o o").is_none());
    }

    // ── is_invalid_generated_title ──

    #[test]
    fn test_is_invalid_generated_title_empty() {
        assert!(is_invalid_generated_title(""));
        assert!(is_invalid_generated_title("   "));
    }

    #[test]
    fn test_is_invalid_generated_title_invalid_phrases() {
        assert!(is_invalid_generated_title("请提供更多信息"));
        assert!(is_invalid_generated_title("我无法判断"));
        assert!(is_invalid_generated_title("需要更多信息"));
        assert!(is_invalid_generated_title("请先提供内容"));
    }

    #[test]
    fn test_is_invalid_generated_title_valid() {
        assert!(!is_invalid_generated_title("登录功能实现"));
        assert!(!is_invalid_generated_title("修复首页样式"));
        assert!(!is_invalid_generated_title("添加用户管理"));
    }

    #[test]
    fn test_is_invalid_generated_title_explanatory() {
        assert!(is_invalid_generated_title(
            "根据你的输入，建议使用React框架"
        ));
    }

    // ── looks_like_explanatory_sentence ──

    #[test]
    fn test_looks_like_explanatory_sentence_short() {
        assert!(!looks_like_explanatory_sentence("短标题"));
    }

    #[test]
    fn test_looks_like_explanatory_sentence_with_punctuation() {
        assert!(looks_like_explanatory_sentence(
            "这是一个包含逗号，的长标题"
        ));
    }

    #[test]
    fn test_looks_like_explanatory_sentence_with_function_words() {
        assert!(looks_like_explanatory_sentence("根据你的需求需要使用React"));
    }

    #[test]
    fn test_looks_like_explanatory_sentence_normal_title() {
        assert!(!looks_like_explanatory_sentence("实现用户登录功能"));
    }

    #[test]
    fn test_looks_like_noise_title_rejects_generation_keywords() {
        assert!(looks_like_noise_title("会话标题 会话标题生成请求"));
    }

    #[test]
    fn test_looks_like_noise_title_rejects_repeated_single_char_tokens() {
        assert!(looks_like_noise_title("o o o o o"));
    }

    #[test]
    fn test_looks_like_noise_title_accepts_normal_chinese_title() {
        assert!(!looks_like_noise_title("看看系统里有什么 bug"));
    }
}
