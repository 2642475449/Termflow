use std::io::Write;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use super::agents::{agent_definition, find_agent_executable};

const DEFAULT_CLAUDE_MAX_TURNS: u8 = 1;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct AgentTextRunOptions {
    pub claude_max_turns: Option<u8>,
}

pub(crate) fn run_agent_text(
    agent_id: &str,
    prompt: &str,
    working_directory: &str,
    timeout: Duration,
    options: AgentTextRunOptions,
) -> Result<String, String> {
    let executable_path = find_agent_executable(agent_id)?;
    let (mut command, stdin_input) =
        build_agent_command(agent_id, &executable_path, prompt, &options)?;
    command.current_dir(working_directory);

    let output = run_command_with_timeout(command, stdin_input, timeout, agent_id)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("{} 调用失败", agent_name(agent_id))
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        Err(format!("{} 未返回有效内容", agent_name(agent_id)))
    } else {
        Ok(stdout)
    }
}

fn build_agent_command<'a>(
    agent_id: &str,
    executable_path: &str,
    prompt: &'a str,
    options: &AgentTextRunOptions,
) -> Result<(Command, Option<&'a str>), String> {
    let mut command = executable_command(executable_path);

    let stdin_input = match agent_id {
        "claude" => {
            let max_turns = options
                .claude_max_turns
                .unwrap_or(DEFAULT_CLAUDE_MAX_TURNS)
                .to_string();
            command.args(["-p", "--output-format", "text", "--max-turns"]);
            command.arg(max_turns);
            Some(prompt)
        }
        "codex" => {
            command.args([
                "exec",
                "--disable",
                "apps",
                "--disable",
                "plugins",
                "--disable",
                "hooks",
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--color",
                "never",
                "-",
            ]);
            Some(prompt)
        }
        "qoder" => {
            command
                .arg("-p")
                .args(["--input-format", "text"])
                .args(["--output-format", "text"])
                .args(["--permission-mode", "dont_ask"])
                .args(["--tools", ""])
                .arg("--no-session-persistence");
            // Qoder 1.1.7 reads plain-text headless input from stdin. Keeping
            // the prompt out of argv avoids cmd.exe's 8191-character limit
            // for npm-generated .cmd launchers on Windows.
            Some(prompt)
        }
        "antigravity" => {
            command.arg("-p").arg(prompt);
            None
        }
        "opencode" => {
            command.arg("run").arg(prompt);
            None
        }
        _ => return Err(format!("不支持的智能体: {agent_id}")),
    };

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_input.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    Ok((command, stdin_input))
}

fn executable_command(executable_path: &str) -> Command {
    let lower_path = executable_path.to_ascii_lowercase();

    if cfg!(target_os = "windows") && (lower_path.ends_with(".cmd") || lower_path.ends_with(".bat"))
    {
        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/c").arg(executable_path);
        command
    } else if cfg!(target_os = "windows") && lower_path.ends_with(".ps1") {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(executable_path);
        command
    } else {
        Command::new(executable_path)
    }
}

fn run_command_with_timeout(
    mut command: Command,
    stdin_input: Option<&str>,
    timeout: Duration,
    agent_id: &str,
) -> Result<Output, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败: {error}", agent_name(agent_id)))?;

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(input.as_bytes()) {
                terminate_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("写入 {} 提示词失败: {error}", agent_name(agent_id)));
            }
        }
    }

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("读取 {} 输出失败: {error}", agent_name(agent_id)));
            }
            Ok(None) if started_at.elapsed() >= timeout => {
                terminate_process_tree(&mut child);
                let output = child.wait_with_output().ok();
                return Err(format_timeout_error(agent_id, timeout, output.as_ref()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(120)),
            Err(error) => {
                terminate_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("等待 {} 进程失败: {error}", agent_name(agent_id)));
            }
        }
    }
}

fn format_timeout_error(agent_id: &str, timeout: Duration, output: Option<&Output>) -> String {
    let diagnostic = output.and_then(process_diagnostic);
    let base = format!(
        "{} 调用超过 {} 秒，已终止后台进程。请检查该 CLI 的网络、代理或登录状态",
        agent_name(agent_id),
        timeout.as_secs()
    );
    match diagnostic {
        Some(detail) => format!("{base}\n{detail}"),
        None => base,
    }
}

fn process_diagnostic(output: &Output) -> Option<String> {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let source = if !stderr.is_empty() { stderr } else { stdout };
    if source.is_empty() {
        return None;
    }

    let recent_lines = source
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let tail = recent_lines
        .chars()
        .rev()
        .take(600)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Some(tail)
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut taskkill = Command::new("taskkill.exe");
    taskkill
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    if !taskkill.status().is_ok_and(|status| status.success()) {
        let _ = child.kill();
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
}

fn agent_name(agent_id: &str) -> &str {
    agent_definition(agent_id)
        .map(|definition| definition.name)
        .unwrap_or("AI 智能体")
}

#[cfg(test)]
mod tests {
    use super::{
        agent_name, build_agent_command, executable_command, process_diagnostic,
        AgentTextRunOptions,
    };
    use std::process::Command;

    fn command_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn resolves_agent_display_names() {
        assert_eq!(agent_name("claude"), "Claude Code");
        assert_eq!(agent_name("codex"), "Codex");
        assert_eq!(agent_name("qoder"), "Qoder CLI");
        assert_eq!(agent_name("antigravity"), "Antigravity CLI");
        assert_eq!(agent_name("opencode"), "OpenCode");
        assert_eq!(agent_name("unknown"), "AI 智能体");
    }

    #[test]
    fn claude_text_command_defaults_to_one_turn() {
        let (command, stdin_input) = build_agent_command(
            "claude",
            "claude",
            "prompt",
            &AgentTextRunOptions::default(),
        )
        .expect("claude command should be supported");

        assert_eq!(stdin_input, Some("prompt"));
        assert_eq!(
            command_args(&command),
            vec!["-p", "--output-format", "text", "--max-turns", "1"]
        );
    }

    #[test]
    fn claude_text_command_accepts_custom_max_turns() {
        let (command, stdin_input) = build_agent_command(
            "claude",
            "claude",
            "prompt",
            &AgentTextRunOptions {
                claude_max_turns: Some(3),
            },
        )
        .expect("claude command should be supported");

        assert_eq!(stdin_input, Some("prompt"));
        assert_eq!(
            command_args(&command),
            vec!["-p", "--output-format", "text", "--max-turns", "3"]
        );
    }

    #[test]
    fn antigravity_text_command_uses_native_print_mode() {
        let (command, stdin_input) = build_agent_command(
            "antigravity",
            "agy",
            "prompt with spaces",
            &AgentTextRunOptions::default(),
        )
        .expect("Antigravity command should be supported");

        assert_eq!(stdin_input, None);
        assert_eq!(command_args(&command), vec!["-p", "prompt with spaces"]);
    }

    #[test]
    fn qoder_text_command_is_non_interactive_and_ephemeral() {
        let (command, stdin_input) = build_agent_command(
            "qoder",
            "qoderclicn",
            "prompt with spaces",
            &AgentTextRunOptions::default(),
        )
        .expect("Qoder CLI command should be supported");

        assert_eq!(stdin_input, Some("prompt with spaces"));
        assert_eq!(
            command_args(&command),
            vec![
                "-p",
                "--input-format",
                "text",
                "--output-format",
                "text",
                "--permission-mode",
                "dont_ask",
                "--tools",
                "",
                "--no-session-persistence",
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_wrappers_bypass_machine_execution_policy() {
        let command = executable_command(r"C:\tools\qoderclicn.ps1");

        assert_eq!(command.get_program(), "powershell.exe");
        assert_eq!(
            command_args(&command),
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                r"C:\tools\qoderclicn.ps1",
            ]
        );
    }

    #[test]
    fn process_diagnostic_prefers_stderr() {
        let output = Command::new("rustc")
            .arg("--definitely-invalid-option")
            .output()
            .expect("rustc should be available while running cargo tests");
        let diagnostic = process_diagnostic(&output).expect("diagnostic should not be empty");
        assert!(
            diagnostic.contains("Unrecognized option") || diagnostic.contains("unknown option")
        );
    }
}
