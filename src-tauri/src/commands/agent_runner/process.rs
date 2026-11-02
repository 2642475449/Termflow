use super::output::{process_diagnostic, AgentTextErrorCode, AgentTextRunError};
use std::io::{self, Read, Write};
#[cfg(target_os = "windows")]
use std::process::Stdio;
use std::process::{Child, Command, Output};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

enum IoEvent {
    Stdout(io::Result<()>),
    Stderr(io::Result<()>),
    Stdin(io::Result<()>),
    OutputLimit,
}

type Capture = Arc<Mutex<Vec<u8>>>;

fn capture_pipe(
    mut reader: impl Read,
    capture: &Capture,
    sender: &mpsc::Sender<IoEvent>,
) -> io::Result<()> {
    let mut buffer = [0; 8_192];
    let mut exceeded = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let mut bytes = capture
            .lock()
            .map_err(|_| io::Error::other("Output capture lock unavailable"))?;
        let available = MAX_OUTPUT_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..count.min(available)]);
        if count > available && !exceeded {
            exceeded = true;
            let _ = sender.send(IoEvent::OutputLimit);
        }
        // 超限后继续排空管道，主线程负责终止进程，避免清理时再次因背压卡住。
    }
}

fn start_reader<R: Read + Send + 'static>(
    stream: Option<R>,
    capture: Capture,
    sender: mpsc::Sender<IoEvent>,
    event: fn(io::Result<()>) -> IoEvent,
) -> io::Result<()> {
    match stream {
        Some(stream) => {
            std::thread::Builder::new()
                .name("agent-text-output".into())
                .spawn(move || {
                    let result = capture_pipe(stream, &capture, &sender);
                    let _ = sender.send(event(result));
                })?;
        }
        None => {
            let _ = sender.send(event(Ok(())));
        }
    }
    Ok(())
}

fn captured(capture: &Capture) -> Vec<u8> {
    capture
        .lock()
        .map(|bytes| bytes.clone())
        .unwrap_or_default()
}

/// 输入写入、stdout 和 stderr 同时推进；超时覆盖写入阶段和输出排空阶段。
pub(super) fn run_command_with_timeout(
    mut command: Command,
    stdin_input: Option<&str>,
    timeout: Duration,
) -> Result<Output, AgentTextRunError> {
    let started_at = Instant::now();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| {
        AgentTextRunError::new(AgentTextErrorCode::Unavailable, Some(error.to_string()))
    })?;
    let stdout: Capture = Arc::default();
    let stderr: Capture = Arc::default();
    let (sender, receiver) = mpsc::channel();
    let mut start_io = || -> io::Result<()> {
        start_reader(
            child.stdout.take(),
            stdout.clone(),
            sender.clone(),
            IoEvent::Stdout,
        )?;
        start_reader(
            child.stderr.take(),
            stderr.clone(),
            sender.clone(),
            IoEvent::Stderr,
        )?;
        if let Some(input) = stdin_input {
            let input = input.as_bytes().to_vec();
            let stream = child.stdin.take();
            let sender = sender.clone();
            std::thread::Builder::new()
                .name("agent-text-input".into())
                .spawn(move || {
                    let result = match stream {
                        Some(mut stdin) => stdin.write_all(&input),
                        None => Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            "CLI input pipe unavailable",
                        )),
                    };
                    // stdin 在这里释放，以 EOF 通知 CLI 提示词已发送完毕。
                    let _ = sender.send(IoEvent::Stdin(result));
                })?;
        } else {
            drop(child.stdin.take());
            let _ = sender.send(IoEvent::Stdin(Ok(())));
        }
        Ok(())
    };
    if let Err(error) = start_io() {
        terminate_process_tree(&mut child);
        reap_process(&mut child);
        return Err(AgentTextRunError::new(
            AgentTextErrorCode::ProcessFailed,
            Some(error.to_string()),
        ));
    }
    drop(sender);

    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut stdin_done = false;
    let mut input_error = None;
    let mut status = None;
    let failure = loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => {
                    break AgentTextRunError::new(
                        AgentTextErrorCode::ProcessFailed,
                        Some(error.to_string()),
                    )
                }
            }
        }
        if stdout_done && stderr_done && stdin_done {
            if let Some(status) = status {
                if status.success() {
                    if let Some(error) = input_error {
                        break AgentTextRunError::new(
                            AgentTextErrorCode::ProcessFailed,
                            Some(error),
                        );
                    }
                }
                return Ok(Output {
                    status,
                    stdout: captured(&stdout),
                    stderr: captured(&stderr),
                });
            }
        }
        let remaining = timeout.saturating_sub(started_at.elapsed());
        if remaining.is_zero() {
            break AgentTextRunError::new(AgentTextErrorCode::Timeout, None);
        }
        let event = match receiver.recv_timeout(POLL_INTERVAL.min(remaining)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected)
                if stdout_done && stderr_done && stdin_done =>
            {
                std::thread::sleep(POLL_INTERVAL.min(remaining));
                continue;
            }
            Err(_) => break AgentTextRunError::new(AgentTextErrorCode::ProcessFailed, None),
        };
        let read_result = match event {
            IoEvent::OutputLimit => {
                break AgentTextRunError::new(AgentTextErrorCode::OutputLimit, None)
            }
            IoEvent::Stdout(result) => {
                stdout_done = true;
                result
            }
            IoEvent::Stderr(result) => {
                stderr_done = true;
                result
            }
            IoEvent::Stdin(result) => {
                stdin_done = true;
                input_error = result.err().map(|error| error.to_string());
                // CLI 若提前退出，保留其真正的错误，不能用 BrokenPipe 覆盖容量/登录诊断。
                continue;
            }
        };
        if let Err(error) = read_result {
            break AgentTextRunError::new(
                AgentTextErrorCode::ProcessFailed,
                Some(error.to_string()),
            );
        }
    };
    terminate_process_tree(&mut child);
    let status = reap_process(&mut child);
    let mut failure = failure;
    if failure.detail.is_none() {
        if let Some(status) = status {
            failure.detail = process_diagnostic(&Output {
                status,
                stdout: captured(&stdout),
                stderr: captured(&stderr),
            });
        }
    }
    Err(failure)
}

fn reap_process(child: &mut Child) -> Option<std::process::ExitStatus> {
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(2) {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Err(_) => return None,
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    use std::os::windows::process::CommandExt;
    let mut taskkill = Command::new("taskkill.exe");
    taskkill
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    if !taskkill.status().is_ok_and(|status| status.success()) {
        let _ = child.kill();
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::{run_command_with_timeout, AgentTextErrorCode, MAX_OUTPUT_BYTES};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn shell_command(windows_script: &str, unix_script: &str) -> Command {
        let mut command = if cfg!(target_os = "windows") {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windows_script,
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", unix_script]);
            command
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[test]
    fn drains_stderr_larger_than_a_pipe_while_the_process_is_still_running() {
        let command = shell_command(
            "[Console]::Error.Write(('x' * 262144)); [Console]::Out.Write('final-result')",
            "head -c 262144 /dev/zero | tr '\\0' x >&2; printf final-result",
        );
        let output = run_command_with_timeout(command, None, Duration::from_secs(10)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"final-result");
        assert_eq!(output.stderr.len(), 262_144);
    }

    #[test]
    fn sends_a_large_prompt_while_draining_output_and_closes_stdin_at_eof() {
        let command = shell_command(
            "[Console]::Error.Write(('x' * 262144)); $text = [Console]::In.ReadToEnd(); [Console]::Out.Write($text.Length)",
            "head -c 262144 /dev/zero | tr '\\0' x >&2; wc -c",
        );
        let prompt = "x".repeat(2 * 1024 * 1024);
        let output =
            run_command_with_timeout(command, Some(&prompt), Duration::from_secs(10)).unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            prompt.len().to_string()
        );
        assert_eq!(output.stderr.len(), 262_144);
    }

    #[test]
    fn the_deadline_includes_a_blocked_stdin_write() {
        let command = shell_command("Start-Sleep -Seconds 30", "sleep 30");
        let started = Instant::now();
        let error = run_command_with_timeout(
            command,
            Some(&"x".repeat(2 * 1024 * 1024)),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert_eq!(error.code, AgentTextErrorCode::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn excessive_output_terminates_generation_instead_of_returning_a_truncated_message() {
        let command = shell_command(
            &format!(
                "[Console]::Out.Write(('x' * {})); Start-Sleep -Seconds 30",
                MAX_OUTPUT_BYTES + 8192
            ),
            &format!("head -c {} /dev/zero; sleep 30", MAX_OUTPUT_BYTES + 8192),
        );
        let error = run_command_with_timeout(command, None, Duration::from_secs(10)).unwrap_err();
        assert_eq!(error.code, AgentTextErrorCode::OutputLimit);
    }

    #[test]
    fn early_cli_failure_keeps_its_diagnostic_when_stdin_is_not_consumed() {
        let command = shell_command(
            "[Console]::Error.Write('ERROR: Selected model is at capacity.'); exit 1",
            "printf 'ERROR: Selected model is at capacity.' >&2; exit 1",
        );
        let output = run_command_with_timeout(
            command,
            Some(&"x".repeat(2 * 1024 * 1024)),
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Selected model is at capacity"));
    }

    #[test]
    fn preserves_utf8_commit_text_across_pipe_read_boundaries() {
        let command = shell_command(
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write(('中文😀' * 3000))",
            "i=0; while [ $i -lt 3000 ]; do printf '中文😀'; i=$((i + 1)); done",
        );
        let output = run_command_with_timeout(command, None, Duration::from_secs(10)).unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "中文😀".repeat(3000)
        );
    }
}
