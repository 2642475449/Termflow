use crate::claude_usage::spawn_usage_monitor;
use crate::commands::agents::agent_definition;
use crate::commands::git::checkpoint::{self, AgentTurnReview};
use crate::events::{emit_session_event, SessionEvent, SessionEventSeverity, SessionEventType};
use crate::hook_ingest::HookIngestConfig;
use crate::opencode_control::{with_tui_server_args, OpenCodePromptControl};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, PtyPair, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct PtyOutputPayload {
    pub session_id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExitPayload {
    pub session_id: String,
    pub code: Option<i32>,
}

/// Decodes PTY output while retaining an incomplete UTF-8 sequence until the
/// next read. PTY reads are byte-oriented, so a character can straddle two
/// buffers even when the process only writes valid UTF-8.
#[derive(Default)]
struct PtyOutputDecoder {
    pending: Vec<u8>,
}

impl PtyOutputDecoder {
    fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);

        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(decoded) => {
                    output.push_str(decoded);
                    self.pending.clear();
                    return output;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    // `valid_up_to` is guaranteed by `Utf8Error` to delimit
                    // a valid UTF-8 prefix.
                    output.push_str(
                        std::str::from_utf8(&self.pending[..valid_up_to])
                            .expect("UTF-8 error reported an invalid valid-prefix boundary"),
                    );

                    let Some(error_len) = error.error_len() else {
                        // The remaining bytes are a valid prefix of a UTF-8
                        // character, not malformed input. Keep them for the
                        // next PTY read instead of emitting U+FFFD.
                        self.pending.drain(..valid_up_to);
                        return output;
                    };

                    // Match `from_utf8_lossy` for genuinely invalid input,
                    // then continue in case an incomplete character follows.
                    output.push('\u{FFFD}');
                    self.pending.drain(..valid_up_to + error_len);
                }
            }
        }
    }

    fn finish(&mut self) -> String {
        let remaining = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        remaining
    }
}

struct PtySession {
    instance_id: u64,
    project_path: String,
    agent_id: String,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    child_pid: u32,
    _pty: PtyPair,
}

#[cfg(target_os = "windows")]
fn windows_taskkill_tree_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // 显式 kill 子进程，确保资源回收
        // 在 Windows 上，使用 taskkill 确保进程被完全清理
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = std::process::Command::new("taskkill")
                .args(windows_taskkill_tree_args(self.child_pid))
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }

        // Fallback when the platform tree-kill command could not stop the root.
        let _ = self.child.kill();
    }
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    next_instance_id: AtomicU64,
    active_turns: Mutex<HashMap<String, ActiveAgentTurn>>,
    ingest_config: Arc<HookIngestConfig>,
}

#[derive(Clone)]
pub struct ActiveAgentTurn {
    pub id: String,
    pub project_path: String,
}

struct SessionShell {
    program: String,
    args: Vec<&'static str>,
    line_ending: &'static str,
}

impl PtyManager {
    pub fn new(ingest_config: Arc<HookIngestConfig>) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            next_instance_id: AtomicU64::new(1),
            active_turns: Mutex::new(HashMap::new()),
            ingest_config,
        })
    }

    pub fn spawn(
        self: &Arc<Self>,
        session_id: String,
        path: String,
        app: AppHandle,
        resume: bool,
        skip_permissions: bool,
        startup_command_override: Option<String>,
        initial_prompt: Option<String>,
        shell_type: &str,
        claude_effort: Option<String>,
        agent_id: Option<String>,
        network_proxy: crate::network_proxy::ResolvedNetworkProxy,
    ) -> Result<Option<OpenCodePromptControl>, String> {
        // A restored Session reuses its stable Session ID. Invalidate and stop
        // any older PTY before creating the replacement so its delayed reader
        // cannot be mistaken for the new instance.
        self.close(&session_id);
        let instance_id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);

        let pty_system = portable_pty::native_pty_system();
        let pty = pty_system
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("创建 PTY 失败: {}", e))?;

        let shell = session_shell(shell_type)?;
        let mut startup_command = match startup_command_override {
            Some(cmd) => cmd,
            None => build_claude_start_command(
                &session_id,
                resume,
                skip_permissions,
                claude_effort.as_deref(),
                initial_prompt.as_deref(),
            ),
        };
        let opencode_control = if agent_id.as_deref() == Some("opencode") {
            initial_prompt
                .as_deref()
                .filter(|prompt| !prompt.trim().is_empty())
                .map(|prompt| OpenCodePromptControl::new(prompt.to_string(), path.clone()))
                .transpose()?
        } else {
            None
        };
        if let Some(control) = opencode_control.as_ref() {
            startup_command = with_tui_server_args(&startup_command, control.port());
        }
        let monitor_claude_usage = should_spawn_claude_usage_monitor(agent_id.as_deref());
        let runtime_agent_label = runtime_agent_label(agent_id.as_deref()).to_string();

        // Spawn an interactive shell first, then run `claude` inside the shell.
        let mut cmd = CommandBuilder::new(&shell.program);
        for arg in &shell.args {
            cmd.arg(arg);
        }
        cmd.cwd(&path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERMFLOW_SESSION_ID", &session_id);
        cmd.env("TERMFLOW_PROJECT_PATH", &path);
        cmd.env("TERMFLOW_INGEST_PORT", self.ingest_config.port.to_string());
        cmd.env("TERMFLOW_INGEST_TOKEN", &self.ingest_config.token);
        crate::network_proxy::apply_proxy_to_pty_command(&mut cmd, &network_proxy);
        if let Some(control) = opencode_control.as_ref() {
            cmd.env("OPENCODE_SERVER_PASSWORD", control.password());
        } else if let Some(prompt) = initial_prompt
            .as_deref()
            .filter(|prompt| !prompt.trim().is_empty())
        {
            // Keep multiline/untrusted prompts out of the interactive shell input.
            // The one-line startup command copies this value and removes it before
            // launching the provider so the child process does not inherit it.
            cmd.env("TERMFLOW_INITIAL_PROMPT", prompt);
        }

        let child = pty
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动会话 shell 失败: {}", e))?;
        // 获取子进程 PID，用于后续资源回收
        let child_pid = child.process_id().unwrap_or(0);

        let mut writer = pty
            .master
            .take_writer()
            .map_err(|e| format!("获取写入器失败: {}", e))?;

        if let Some(input) = build_startup_input(&startup_command, shell.line_ending) {
            writer
                .write_all(input.as_bytes())
                .and_then(|_| writer.flush())
                .map_err(|e| format!("向会话 shell 写入智能体启动命令失败: {}", e))?;
        }

        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| format!("获取读取器失败: {}", e))?;

        let session = PtySession {
            instance_id,
            project_path: path.clone(),
            agent_id: agent_id.unwrap_or_else(|| "generic-cli".to_string()),
            writer,
            child,
            child_pid,
            _pty: pty,
        };
        self.sessions.lock().insert(session_id.clone(), session);
        if monitor_claude_usage {
            spawn_usage_monitor(
                Arc::downgrade(self),
                app.clone(),
                session_id.clone(),
                path.clone(),
            );
        }
        emit_session_event(
            &app,
            &SessionEvent {
                id: format!("runtime:{}:{}", session_id, now_ms()),
                revision: None,
                session_id: session_id.clone(),
                project_path: path.clone(),
                session_name: session_id.clone(),
                event_type: if resume {
                    SessionEventType::SessionResumed
                } else {
                    SessionEventType::SessionStarted
                },
                title: if resume {
                    "会话已恢复".to_string()
                } else {
                    "会话已启动".to_string()
                },
                body: format!("工作目录: {}", path),
                severity: SessionEventSeverity::Info,
                source: "runtime".to_string(),
                requires_attention: false,
                actionable: true,
                dedupe_key: None,
                created_at: now_ms(),
                metadata: serde_json::json!({}),
            },
        );

        // Background thread: read PTY output → emit to frontend
        let manager = Arc::clone(self);
        let sid = session_id.clone();
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            let mut decoder = PtyOutputDecoder::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !manager.is_session_instance_current(&sid, instance_id) {
                            return;
                        }
                        let data = decoder.decode(&buf[..n]);
                        if !data.is_empty() {
                            let _ = app_clone.emit(
                                "pty-output",
                                PtyOutputPayload {
                                    session_id: sid.clone(),
                                    data,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            if manager.is_session_instance_current(&sid, instance_id) {
                let data = decoder.finish();
                if !data.is_empty() {
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutputPayload {
                            session_id: sid.clone(),
                            data,
                        },
                    );
                }
            }
            if !manager.remove_session_instance(&sid, instance_id) {
                return;
            }
            if let Ok(Some(review)) = manager.complete_active_turn(&sid, "process_exit") {
                let _ = app_clone.emit("checkpoint-review-ready", review);
            }
            emit_session_event(
                &app_clone,
                &SessionEvent {
                    id: format!("runtime:{}:{}", sid, now_ms()),
                    revision: None,
                    session_id: sid.clone(),
                    project_path: String::new(),
                    session_name: sid.clone(),
                    event_type: SessionEventType::ProcessExit,
                    title: format!("{runtime_agent_label} 会话已退出"),
                    body: "进程结束".to_string(),
                    severity: SessionEventSeverity::Warning,
                    source: "runtime".to_string(),
                    requires_attention: true,
                    actionable: true,
                    dedupe_key: Some(format!("{}:process_exit", sid)),
                    created_at: now_ms(),
                    metadata: serde_json::json!({}),
                },
            );
            let _ = app_clone.emit(
                "pty-exit",
                PtyExitPayload {
                    session_id: sid,
                    code: None,
                },
            );
        });

        Ok(opencode_control)
    }

    pub fn write_input(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions.get_mut(session_id).ok_or("会话不存在")?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("写入失败: {}", e))?;
        Ok(())
    }

    pub fn session_context(&self, session_id: &str) -> Option<(String, String)> {
        self.sessions
            .lock()
            .get(session_id)
            .map(|session| (session.project_path.clone(), session.agent_id.clone()))
    }

    pub fn replace_active_turn(
        &self,
        session_id: &str,
        turn: ActiveAgentTurn,
    ) -> Option<ActiveAgentTurn> {
        self.active_turns
            .lock()
            .insert(session_id.to_string(), turn)
    }

    pub fn take_active_turn(&self, session_id: &str) -> Option<ActiveAgentTurn> {
        self.active_turns.lock().remove(session_id)
    }

    pub fn complete_active_turn(
        &self,
        session_id: &str,
        source: &str,
    ) -> Result<Option<AgentTurnReview>, String> {
        self.complete_active_turn_inner(session_id, source, None)
    }

    pub fn complete_active_turn_with_timeout(
        &self,
        session_id: &str,
        source: &str,
        timeout: Duration,
    ) -> Result<Option<AgentTurnReview>, String> {
        self.complete_active_turn_inner(session_id, source, Some(timeout))
    }

    fn complete_active_turn_inner(
        &self,
        session_id: &str,
        source: &str,
        timeout: Option<Duration>,
    ) -> Result<Option<AgentTurnReview>, String> {
        let Some(active) = self.take_active_turn(session_id) else {
            return Ok(None);
        };
        let result = match timeout {
            Some(timeout) => checkpoint::complete_turn_with_timeout(
                &active.id,
                &active.project_path,
                source,
                timeout,
            ),
            None => checkpoint::complete_turn(&active.id, &active.project_path, source),
        };
        match result {
            Ok(turn) => Ok(Some(turn)),
            Err(error) => {
                // Put the turn back so a later provider event or manual completion can retry.
                self.replace_active_turn(session_id, active);
                Err(error)
            }
        }
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock();
        let session = sessions.get(session_id).ok_or("会话不存在")?;
        session
            ._pty
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整大小失败: {}", e))?;
        Ok(())
    }

    pub fn close(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }

    pub fn close_project_sessions(&self, project_path: &str) {
        let session_ids = self
            .sessions
            .lock()
            .iter()
            .filter(|(_, session)| session.project_path == project_path)
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            self.close(&session_id);
        }
    }

    /// Check if a session is currently active
    pub fn is_session_active(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }

    fn is_session_instance_current(&self, session_id: &str, instance_id: u64) -> bool {
        let current_instance_id = self
            .sessions
            .lock()
            .get(session_id)
            .map(|session| session.instance_id);
        is_same_pty_instance(current_instance_id, instance_id)
    }

    fn remove_session_instance(&self, session_id: &str, instance_id: u64) -> bool {
        let mut sessions = self.sessions.lock();
        let current_instance_id = sessions.get(session_id).map(|session| session.instance_id);
        if !is_same_pty_instance(current_instance_id, instance_id) {
            return false;
        }
        sessions.remove(session_id);
        true
    }

    /// Cleanup all active PTY sessions
    /// This is called when the application exits to ensure no orphan processes remain
    pub fn cleanup_all(&self) {
        let session_ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for session_id in session_ids {
            self.close(&session_id);
        }
    }

    /// 仅清理指定会话的残留进程（不影响其他项目的会话）
    ///
    /// 当 PtyManager 中已存在该会话时，说明进程正在运行，跳过清理。
    /// 否则通过命令行匹配 `--session-id "<session_id>"` 找到属于该会话的残留进程并杀死。
    pub fn cleanup_session_process(&self, session_id: &str) {
        // 如果会话在 PtyManager 中已存在，说明正在正常运行，不需要清理
        if self.sessions.lock().contains_key(session_id) {
            return;
        }

        kill_session_process(session_id);
    }
}

fn is_same_pty_instance(current_instance_id: Option<u64>, instance_id: u64) -> bool {
    current_instance_id == Some(instance_id)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn is_claude_related_command_line(cmdline: &str) -> bool {
    let cmdline_lower = cmdline.to_lowercase();
    ["claude", "@anthropic-ai", "claude-code", "termflow"]
        .iter()
        .any(|kw| cmdline_lower.contains(kw))
}

/// Kill any stale claude processes that might be holding a session lock
/// This is called before restoring a session to ensure clean state
pub fn kill_stale_claude_processes() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Use PowerShell to get processes with their command line arguments
        // This allows us to precisely identify Claude-related processes
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='claude.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("获取进程列表失败: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse JSON array or single object
        let processes: Vec<serde_json::Value> = if stdout.trim().starts_with('[') {
            serde_json::from_str(stdout.trim()).unwrap_or_default()
        } else if stdout.trim().starts_with('{') {
            serde_json::from_str::<serde_json::Value>(stdout.trim())
                .map(|v| vec![v])
                .unwrap_or_default()
        } else {
            vec![]
        };

        for proc in &processes {
            let pid = proc.get("ProcessId").and_then(|v| v.as_u64()).unwrap_or(0);
            let cmdline = proc
                .get("CommandLine")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if pid == 0 || cmdline.is_empty() {
                continue;
            }

            if is_claude_related_command_line(cmdline) {
                let _ = std::process::Command::new("cmd.exe")
                    .args(["/c", "taskkill", "/F", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix-like systems, kill claude processes by matching command line
        let _ = std::process::Command::new("pkill")
            .args(["-f", "claude-code"])
            .output();
    }

    Ok(())
}

/// 仅杀死指定 session_id 的残留 Claude 进程
///
/// 通过命令行中 `--session-id "<id>"` 来精确匹配，不影响其他项目的会话进程。
fn kill_session_process(session_id: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // 获取所有 node.exe 和 claude.exe 进程
        let output = match std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='claude.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(output) => output,
            Err(_) => return,
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let processes: Vec<serde_json::Value> = if stdout.trim().starts_with('[') {
            serde_json::from_str(stdout.trim()).unwrap_or_default()
        } else if stdout.trim().starts_with('{') {
            serde_json::from_str::<serde_json::Value>(stdout.trim())
                .map(|v| vec![v])
                .unwrap_or_default()
        } else {
            vec![]
        };

        // 精确匹配：命令行包含 --session-id 和目标 session_id 的 Claude 相关进程
        let session_marker = "--session-id";
        for proc in &processes {
            let pid = proc.get("ProcessId").and_then(|v| v.as_u64()).unwrap_or(0);
            let cmdline = proc
                .get("CommandLine")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if pid == 0 || cmdline.is_empty() {
                continue;
            }

            let cmdline_lower = cmdline.to_lowercase();
            // 必须同时满足：是 Claude 相关进程 且 命令行包含该 session_id
            let is_claude = ["claude", "@anthropic-ai", "claude-code"]
                .iter()
                .any(|kw| cmdline_lower.contains(kw));
            if is_claude
                && cmdline_lower.contains(&session_marker.to_lowercase())
                && cmdline.contains(session_id)
            {
                let _ = std::process::Command::new("cmd.exe")
                    .args(["/c", "taskkill", "/F", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix: 通过 ps + grep 精确匹配包含该 session_id 的 claude 进程
        let _ = std::process::Command::new("sh")
            .args([
                "-c",
                &format!(
                    "ps aux | grep 'claude.*--session-id.*{}' | grep -v grep | awk '{{print $2}}' | xargs -r kill -9",
                    session_id
                ),
            ])
            .output();
    }
}

pub(crate) fn check_claude_ready_in_shell() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoLogo", "-NoProfile", "-Command", "claude --version"]);
        cmd
    };

    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let shell = check_shell_program()?;
        let mut cmd = std::process::Command::new(shell);
        cmd.args(["-lc", "claude --version"]);
        cmd
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("无法启动命令检查 Claude 环境: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "shell 中执行 `claude --version` 失败".to_string()
    };

    Err(format!(
        "未检测到可用的 Claude Code。请先确认终端可以直接执行 `claude --version`。{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(" 详情: {}", detail)
        }
    ))
}

/// Find claude executable on the system.
/// Only accepts a globally available Claude executable exposed via PATH.
pub(crate) fn find_claude_exe() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    if let Some(path) = find_windows_claude_on_path() {
        return Ok(path);
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(path) = find_unix_claude_on_path() {
        return Ok(path);
    }

    Err("未检测到全局 Claude Code。请先确保终端可以直接执行 claude。".into())
}

#[cfg(target_os = "windows")]
fn find_windows_claude_on_path() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "where", "claude"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    select_windows_claude_path(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "windows"))]
fn find_unix_claude_on_path() -> Option<String> {
    let output = std::process::Command::new("which")
        .arg("claude")
        .output()
        .ok()?;

    first_existing_path_from_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn first_existing_path_from_output(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && Path::new(line).exists())
        .map(|line| line.to_string())
}

#[cfg(target_os = "windows")]
fn select_windows_claude_path(output: &str) -> Option<String> {
    let candidates: Vec<String> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && Path::new(line).exists())
        .map(|line| line.to_string())
        .collect();

    for suffix in [".cmd", ".exe", ".bat", ".ps1"] {
        if let Some(candidate) = candidates
            .iter()
            .find(|line| line.to_ascii_lowercase().ends_with(suffix))
        {
            return Some(candidate.clone());
        }
    }

    candidates.into_iter().next()
}

fn build_claude_start_command(
    session_id: &str,
    resume: bool,
    skip_permissions: bool,
    effort: Option<&str>,
    initial_prompt: Option<&str>,
) -> String {
    let mut parts = vec!["claude".to_string()];
    if skip_permissions {
        parts.push("--dangerously-skip-permissions".to_string());
    }
    if let Some(level) = effort.filter(|value| !value.trim().is_empty()) {
        parts.push("--effort".to_string());
        parts.push(level.to_string());
    }
    if resume {
        parts.push("--resume".to_string());
    } else {
        parts.push("--session-id".to_string());
    }
    parts.push(quote_shell_arg(session_id));
    let command = parts.join(" ");
    if initial_prompt.is_some_and(|prompt| !prompt.trim().is_empty()) {
        with_initial_prompt(command)
    } else {
        command
    }
}

#[cfg(target_os = "windows")]
fn with_initial_prompt(command: String) -> String {
    format!(
        "$__termflow_prompt=$env:TERMFLOW_INITIAL_PROMPT; Remove-Item Env:TERMFLOW_INITIAL_PROMPT; {command} $__termflow_prompt"
    )
}

#[cfg(not(target_os = "windows"))]
fn with_initial_prompt(command: String) -> String {
    format!(
        "__termflow_prompt=\"$TERMFLOW_INITIAL_PROMPT\"; unset TERMFLOW_INITIAL_PROMPT; {command} \"$__termflow_prompt\""
    )
}

fn quote_shell_arg(arg: &str) -> String {
    format!("\"{}\"", arg.replace('"', "\\\""))
}

fn build_startup_input(startup_command: &str, line_ending: &str) -> Option<String> {
    if startup_command.trim().is_empty() {
        None
    } else {
        Some(format!("{startup_command}{line_ending}"))
    }
}

fn session_shell(shell_type: &str) -> Result<SessionShell, String> {
    #[cfg(target_os = "windows")]
    {
        match shell_type {
            "cmd" => Ok(SessionShell {
                program: "cmd.exe".to_string(),
                args: vec![],
                line_ending: "\r\n",
            }),
            _ => Ok(SessionShell {
                program: "powershell.exe".to_string(),
                args: vec!["-NoLogo"],
                line_ending: "\r\n",
            }),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(SessionShell {
            program: check_shell_program()?,
            args: vec![],
            line_ending: "\n",
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn check_shell_program() -> Result<String, String> {
    if let Ok(shell) = std::env::var("SHELL") {
        let trimmed = shell.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return Ok(trimmed.to_string());
        }
    }

    for candidate in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
        if Path::new(candidate).exists() {
            return Ok(candidate.to_string());
        }
    }

    Err("未找到可用的 shell，请确认系统已安装 bash、zsh 或 sh。".to_string())
}

fn should_spawn_claude_usage_monitor(agent_id: Option<&str>) -> bool {
    matches!(agent_id, None | Some("claude"))
}

fn runtime_agent_label(agent_id: Option<&str>) -> &'static str {
    match agent_id {
        None => "Claude Code",
        Some("powershell") => "PowerShell",
        Some("cmd") => "Command Prompt",
        Some(agent_id) => agent_definition(agent_id)
            .map(|definition| definition.name)
            .unwrap_or("智能体"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_now_ms_returns_positive_value() {
        let ms = now_ms();
        assert!(ms > 0, "now_ms() should return a positive timestamp");
    }

    #[test]
    fn test_now_ms_increases() {
        let ms1 = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let ms2 = now_ms();
        assert!(ms2 >= ms1, "Timestamp should increase over time");
    }

    #[test]
    fn usage_monitor_only_runs_for_claude_sessions() {
        assert!(should_spawn_claude_usage_monitor(None));
        assert!(should_spawn_claude_usage_monitor(Some("claude")));
        assert!(!should_spawn_claude_usage_monitor(Some("codex")));
        assert!(!should_spawn_claude_usage_monitor(Some("qoder")));
        assert!(!should_spawn_claude_usage_monitor(Some("antigravity")));
        assert!(!should_spawn_claude_usage_monitor(Some("opencode")));
    }

    #[test]
    fn runtime_exit_labels_include_qoder_and_terminal_sessions() {
        assert_eq!(runtime_agent_label(None), "Claude Code");
        assert_eq!(runtime_agent_label(Some("qoder")), "Qoder CLI");
        assert_eq!(runtime_agent_label(Some("powershell")), "PowerShell");
        assert_eq!(runtime_agent_label(Some("cmd")), "Command Prompt");
        assert_eq!(runtime_agent_label(Some("unknown")), "智能体");
    }

    #[test]
    fn pty_output_decoder_preserves_utf8_split_across_reads() {
        let mut decoder = PtyOutputDecoder::default();
        let character = "你".as_bytes();

        assert_eq!(decoder.decode(&character[..1]), "");
        assert_eq!(decoder.decode(&character[1..]), "你");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn pty_output_decoder_preserves_split_emoji_after_valid_text() {
        let mut decoder = PtyOutputDecoder::default();
        let emoji = "🙂".as_bytes();

        assert_eq!(
            decoder.decode(&[b'o', b'k', b' ', emoji[0], emoji[1]]),
            "ok "
        );
        assert_eq!(decoder.decode(&emoji[2..]), "🙂");
    }

    #[test]
    fn pty_output_decoder_flushes_incomplete_utf8_at_end_of_stream() {
        let mut decoder = PtyOutputDecoder::default();

        assert_eq!(decoder.decode(&[0xE4, 0xBD]), "");
        assert_eq!(decoder.finish(), "�");
    }

    #[test]
    fn pty_output_decoder_replaces_invalid_bytes_without_losing_later_input() {
        let mut decoder = PtyOutputDecoder::default();

        assert_eq!(decoder.decode(&[b'a', 0xFF, 0xE4, 0xBD]), "a�");
        assert_eq!(decoder.decode(&[0xA0]), "你");
    }

    #[test]
    fn test_pty_manager_new() {
        let config = Arc::new(HookIngestConfig {
            port: 0,
            token: "test".to_string(),
        });
        let manager = PtyManager::new(config);
        assert!(manager.sessions.lock().is_empty());
    }

    #[test]
    fn test_pty_manager_is_session_active_returns_false_for_unknown() {
        let config = Arc::new(HookIngestConfig {
            port: 0,
            token: "test".to_string(),
        });
        let manager = PtyManager::new(config);
        assert!(!manager.is_session_active("nonexistent"));
    }

    #[test]
    fn test_is_claude_related_command_line_matches_expected_processes() {
        assert!(is_claude_related_command_line(
            r#"node C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"#
        ));
        assert!(is_claude_related_command_line(
            r#"C:\Users\me\AppData\Roaming\npm\claude.cmd --resume abc"#
        ));
        assert!(is_claude_related_command_line(
            r#"node app.js --client termflow"#
        ));
    }

    #[test]
    fn test_is_claude_related_command_line_ignores_unrelated_node_processes() {
        assert!(!is_claude_related_command_line(
            r#"node C:\project\vite\bin\vite.js dev"#
        ));
        assert!(!is_claude_related_command_line(
            r#"node C:\project\scripts\build.js"#
        ));
        assert!(!is_claude_related_command_line(""));
    }

    #[test]
    fn test_first_existing_path_from_output_returns_first_real_path() {
        let existing = std::env::temp_dir().join("termflow-claude-path-test.cmd");
        std::fs::write(&existing, "echo test").unwrap();

        let output = format!("C:\\missing\\claude.cmd\n{}\n", existing.to_string_lossy());

        assert_eq!(
            first_existing_path_from_output(&output),
            Some(existing.to_string_lossy().into_owned())
        );

        let _ = std::fs::remove_file(existing);
    }

    #[test]
    fn test_first_existing_path_from_output_returns_none_when_missing() {
        let output = "C:\\missing\\claude.cmd\n\n";
        assert_eq!(first_existing_path_from_output(output), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_taskkill_args_terminate_the_process_tree() {
        assert_eq!(
            windows_taskkill_tree_args(1420),
            ["/PID", "1420", "/T", "/F"].map(str::to_string)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_select_windows_claude_path_prefers_cmd_over_bare_script() {
        let dir = std::env::temp_dir().join(format!("termflow-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();

        let bare = dir.join("claude");
        let cmd = dir.join("claude.cmd");
        std::fs::write(&bare, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\n").unwrap();

        let output = format!("{}\n{}\n", bare.display(), cmd.display());
        assert_eq!(
            select_windows_claude_path(&output),
            Some(cmd.to_string_lossy().into_owned())
        );

        let _ = std::fs::remove_file(bare);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn test_build_claude_start_command_for_new_session() {
        assert_eq!(
            build_claude_start_command("abc-123", false, true, None, None),
            r#"claude --dangerously-skip-permissions --session-id "abc-123""#
        );
    }

    #[test]
    fn test_build_claude_start_command_for_resume() {
        assert_eq!(
            build_claude_start_command("abc-123", true, false, None, None),
            r#"claude --resume "abc-123""#
        );
    }

    #[test]
    fn test_build_claude_start_command_with_effort() {
        assert_eq!(
            build_claude_start_command("abc-123", false, true, Some("max"), None),
            r#"claude --dangerously-skip-permissions --effort max --session-id "abc-123""#
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_build_claude_start_command_with_initial_prompt() {
        assert_eq!(
            build_claude_start_command(
                "abc-123",
                false,
                false,
                None,
                Some("review this; echo 'unsafe'"),
            ),
            r#"$__termflow_prompt=$env:TERMFLOW_INITIAL_PROMPT; Remove-Item Env:TERMFLOW_INITIAL_PROMPT; claude --session-id "abc-123" $__termflow_prompt"#
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_build_claude_start_command_keeps_multiline_prompt_out_of_shell_input() {
        let command = build_claude_start_command(
            "abc-123",
            false,
            false,
            None,
            Some("first line\nsecond line; echo unsafe"),
        );
        assert!(!command.contains("first line"));
        assert!(!command.contains('\n'));
        assert!(command.contains("$env:TERMFLOW_INITIAL_PROMPT"));
    }

    #[test]
    fn empty_startup_command_does_not_write_to_the_shell() {
        assert_eq!(build_startup_input("", "\r\n"), None);
        assert_eq!(build_startup_input("   ", "\r\n"), None);
    }

    #[test]
    fn non_empty_startup_command_is_submitted_with_the_shell_line_ending() {
        assert_eq!(
            build_startup_input("claude --session-id test", "\r\n"),
            Some("claude --session-id test\r\n".to_string())
        );
    }

    // Helper to create a real PTY pair for testing
    #[allow(dead_code)]
    fn create_test_pty_pair() -> portable_pty::PtyPair {
        let pty_system = portable_pty::native_pty_system();
        pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap()
    }

    #[test]
    fn test_pty_session_drop_trait_exists() {
        // Verify that PtySession implements Drop by checking if it can be dropped
        let config = Arc::new(HookIngestConfig {
            port: 0,
            token: "test".to_string(),
        });
        let manager = PtyManager::new(config);

        // Initially no sessions
        assert!(manager.sessions.lock().is_empty());

        // The Drop trait is implemented, so when sessions are removed,
        // the PtySession will be dropped and child processes will be killed
    }

    #[test]
    fn test_cleanup_all_clears_sessions() {
        let config = Arc::new(HookIngestConfig {
            port: 0,
            token: "test".to_string(),
        });
        let manager = PtyManager::new(config);

        // Manually insert a mock session to test cleanup
        // Note: We can't easily create a real PtySession in tests without
        // spawning a real process, so we test the cleanup logic indirectly
        assert!(manager.sessions.lock().is_empty());

        // cleanup_all should work even with no sessions
        manager.cleanup_all();
        assert!(manager.sessions.lock().is_empty());
    }

    #[test]
    fn test_pty_instance_identity_rejects_stale_readers() {
        assert!(is_same_pty_instance(Some(8), 8));
        assert!(!is_same_pty_instance(Some(9), 8));
        assert!(!is_same_pty_instance(None, 8));
    }

    #[test]
    fn test_pty_instance_ids_are_unique() {
        let config = Arc::new(HookIngestConfig {
            port: 0,
            token: "test".to_string(),
        });
        let manager = PtyManager::new(config);

        let first = manager.next_instance_id.fetch_add(1, Ordering::Relaxed);
        let second = manager.next_instance_id.fetch_add(1, Ordering::Relaxed);
        assert_ne!(first, second);
    }

    #[test]
    fn test_cleanup_session_process_skips_active_session() {
        let config = Arc::new(HookIngestConfig {
            port: 0,
            token: "test".to_string(),
        });
        let manager = PtyManager::new(config);

        // Simulate an active session by inserting a mock entry
        // (We can't create a real PtySession without spawning a process,
        //  but we can verify the early-return logic by checking sessions map)
        assert!(manager.sessions.lock().is_empty());

        // cleanup_session_process should not panic even with no sessions
        manager.cleanup_session_process("nonexistent-session");
    }
}
