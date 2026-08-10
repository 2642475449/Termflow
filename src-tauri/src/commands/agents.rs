use serde::Serialize;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub installed: bool,
    pub version: Option<String>,
    pub executable_path: Option<String>,
    pub checked_at: i64,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AgentDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub version_args: &'static [&'static str],
}

const DEFAULT_VERSION_ARGS: &[&str] = &["--version"];

pub(crate) const AGENT_DEFINITIONS: [AgentDefinition; 5] = [
    AgentDefinition {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        version_args: DEFAULT_VERSION_ARGS,
    },
    AgentDefinition {
        id: "codex",
        name: "Codex",
        command: "codex",
        version_args: DEFAULT_VERSION_ARGS,
    },
    AgentDefinition {
        id: "antigravity",
        name: "Antigravity CLI",
        command: "agy",
        version_args: DEFAULT_VERSION_ARGS,
    },
    AgentDefinition {
        id: "opencode",
        name: "OpenCode",
        command: "opencode",
        version_args: DEFAULT_VERSION_ARGS,
    },
    AgentDefinition {
        id: "qoder",
        name: "Qoder CLI",
        command: "qoderclicn",
        version_args: DEFAULT_VERSION_ARGS,
    },
];

/// Inspect the AI coding CLIs Termflow can launch from the current system PATH.
#[tauri::command]
pub async fn inspect_agent_clis() -> Result<Vec<AgentCliInfo>, String> {
    tauri::async_runtime::spawn_blocking(inspect_agent_clis_sync)
        .await
        .map_err(|error| format!("Agent detection background task failed: {error}"))
}

fn inspect_agent_clis_sync() -> Vec<AgentCliInfo> {
    let checked_at = chrono::Utc::now().timestamp_millis();

    AGENT_DEFINITIONS
        .iter()
        .map(|definition| inspect_agent(definition, checked_at))
        .collect()
}

fn inspect_agent(definition: &AgentDefinition, checked_at: i64) -> AgentCliInfo {
    let Some(executable_path) = find_executable(definition.command) else {
        return AgentCliInfo {
            id: definition.id,
            name: definition.name,
            command: definition.command,
            installed: false,
            version: None,
            executable_path: None,
            checked_at,
            error: None,
        };
    };

    match read_version(&executable_path, definition.version_args) {
        Ok(version) => AgentCliInfo {
            id: definition.id,
            name: definition.name,
            command: definition.command,
            installed: true,
            version: Some(version),
            executable_path: Some(executable_path),
            checked_at,
            error: None,
        },
        Err(error) => AgentCliInfo {
            id: definition.id,
            name: definition.name,
            command: definition.command,
            // A resolved executable is still an installed CLI, even when its
            // version command is broken or produces an unexpected response.
            installed: true,
            version: None,
            executable_path: Some(executable_path),
            checked_at,
            error: Some(error),
        },
    }
}

pub(crate) fn agent_definition(agent_id: &str) -> Option<&'static AgentDefinition> {
    AGENT_DEFINITIONS
        .iter()
        .find(|definition| definition.id == agent_id)
}

pub(crate) fn find_executable(command: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let mut lookup = Command::new("where.exe");
        lookup.arg(command);
        let output = run_command_with_timeout(lookup, DISCOVERY_TIMEOUT).ok()?;
        if !output.status.success() {
            return None;
        }

        // npm exposes both an extensionless POSIX shim and a .cmd shim on
        // Windows. `where` lists the extensionless file first, but Windows
        // cannot execute it directly, so select the first native wrapper.
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|candidate| {
                let lower = candidate.to_ascii_lowercase();
                !candidate.is_empty()
                    && Path::new(candidate).exists()
                    && [".exe", ".com", ".cmd", ".bat", ".ps1"]
                        .iter()
                        .any(|extension| lower.ends_with(extension))
            })
            .map(str::to_string);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut lookup = Command::new("which");
        lookup.arg(command);
        let output = run_command_with_timeout(lookup, DISCOVERY_TIMEOUT).ok()?;
        if !output.status.success() {
            return None;
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|candidate| !candidate.is_empty() && Path::new(candidate).exists())
            .map(str::to_string)
    }
}

pub(crate) fn find_agent_executable(agent_id: &str) -> Result<String, String> {
    let definition =
        agent_definition(agent_id).ok_or_else(|| format!("不支持的智能体: {agent_id}"))?;

    find_executable(definition.command)
        .ok_or_else(|| format!("未找到 {}，请在设置中重新检查安装状态", definition.name))
}

fn build_version_command(executable_path: &str, version_args: &[&str]) -> Command {
    let lower_path = executable_path.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    let mut command = if lower_path.ends_with(".cmd") || lower_path.ends_with(".bat") {
        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/c").arg(executable_path);
        command
    } else if lower_path.ends_with(".ps1") {
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
    };

    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(executable_path);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.args(version_args);
    command
}

fn read_version(executable_path: &str, version_args: &[&str]) -> Result<String, String> {
    let command = build_version_command(executable_path, version_args);
    let output = run_command_with_timeout(command, VERSION_TIMEOUT)
        .map_err(|error| format!("Failed to run version command: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version = if !stdout.is_empty() { &stdout } else { &stderr };

    if output.status.success() && !version.is_empty() {
        Ok(version.lines().next().unwrap_or(version).trim().to_string())
    } else if version.is_empty() {
        Err("The version command returned no output".to_string())
    } else {
        Err(version.lines().next().unwrap_or(version).trim().to_string())
    }
}

fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    // Termflow is a GUI application. Any discovery/version subprocess that
    // inherits a console window causes a visible flash on Windows.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start process: {error}"))?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("Failed to read process output: {error}"));
            }
            Ok(None) if started_at.elapsed() >= timeout => {
                terminate_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!(
                    "Process timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                terminate_process_tree(&mut child);
                let _ = child.wait();
                return Err(format!("Failed while waiting for process: {error}"));
            }
        }
    }
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

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::build_version_command;
    use super::{agent_definition, AGENT_DEFINITIONS, DISCOVERY_TIMEOUT, VERSION_TIMEOUT};
    use std::collections::HashSet;
    #[cfg(target_os = "windows")]
    use std::process::Command;
    use std::time::Duration;

    #[cfg(target_os = "windows")]
    fn command_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn google_agent_is_antigravity_cli() {
        let definition = agent_definition("antigravity").expect("Antigravity should be registered");
        assert_eq!(definition.name, "Antigravity CLI");
        assert_eq!(definition.command, "agy");
        assert!(!AGENT_DEFINITIONS
            .iter()
            .any(|definition| definition.id == "gemini" || definition.command == "gemini"));
    }

    #[test]
    fn qoder_cli_is_registered_with_its_native_command() {
        let definition = agent_definition("qoder").expect("Qoder CLI should be registered");
        assert_eq!(definition.name, "Qoder CLI");
        assert_eq!(definition.command, "qoderclicn");
        assert_eq!(definition.version_args, ["--version"]);
    }

    #[test]
    fn registry_agent_ids_and_commands_are_unique() {
        let mut ids = HashSet::new();
        let mut commands = HashSet::new();
        for definition in AGENT_DEFINITIONS {
            assert!(ids.insert(definition.id), "duplicate id: {}", definition.id);
            assert!(
                commands.insert(definition.command),
                "duplicate command: {}",
                definition.command
            );
            assert!(!definition.version_args.is_empty());
        }
    }

    #[test]
    fn discovery_and_version_checks_have_finite_budgets() {
        assert_eq!(DISCOVERY_TIMEOUT, Duration::from_secs(2));
        assert_eq!(VERSION_TIMEOUT, Duration::from_secs(5));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn version_command_uses_the_native_windows_cmd_wrapper() {
        let executable = r"C:\Program Files\Qoder\qoderclicn.cmd";
        let command = build_version_command(executable, &["--version"]);

        assert_eq!(
            command.get_program().to_string_lossy().to_ascii_lowercase(),
            "cmd.exe"
        );
        assert_eq!(
            command_args(&command),
            vec!["/d", "/c", executable, "--version"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn version_command_bypasses_policy_for_powershell_wrappers() {
        let executable = r"C:\Users\example\AppData\Roaming\npm\qoderclicn.ps1";
        let command = build_version_command(executable, &["--version"]);

        assert_eq!(
            command.get_program().to_string_lossy().to_ascii_lowercase(),
            "powershell.exe"
        );
        assert_eq!(
            command_args(&command),
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                executable,
                "--version",
            ]
        );
    }
}
