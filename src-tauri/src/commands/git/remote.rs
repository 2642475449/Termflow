use super::types::GitRemoteResult;
use super::utils::{git_command, run_git_blocking};
use std::io::Read;
use std::process::{Child, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const REMOTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn read_stream<R>(mut stream: R, stream_name: &'static str) -> JoinHandle<Result<Vec<u8>, String>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        stream
            .read_to_end(&mut output)
            .map_err(|error| format!("读取 git {} 失败: {}", stream_name, error))?;
        Ok(output)
    })
}

fn join_stream(
    reader: JoinHandle<Result<Vec<u8>, String>>,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("读取 git {} 的线程异常退出", stream_name))?
}

fn wait_with_timeout(mut child: Child, timeout: Duration) -> Result<Output, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 git 标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 git 错误输出".to_string())?;
    let stdout_reader = read_stream(stdout, "标准输出");
    let stderr_reader = read_stream(stderr, "错误输出");
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Git 远程操作超时，请检查网络或认证状态".to_string());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 git 命令失败: {}", error));
            }
        }
    };

    Ok(Output {
        status,
        stdout: join_stream(stdout_reader, "标准输出")?,
        stderr: join_stream(stderr_reader, "错误输出")?,
    })
}

fn run_remote_command(
    project_path: &str,
    args: &[&str],
    success_message: &str,
    failure_message: &str,
) -> Result<GitRemoteResult, String> {
    let path = crate::path_utils::normalize_input_path(project_path);

    let mut command = git_command();
    command
        .args(args)
        .current_dir(&path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = command
        .spawn()
        .map_err(|e| format!("执行 git 命令失败: {}", e))?;
    let output = wait_with_timeout(output, REMOTE_COMMAND_TIMEOUT)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}{}", stdout, stderr).trim().to_string();

    Ok(GitRemoteResult {
        success: output.status.success(),
        message: if !combined.is_empty() {
            combined
        } else if output.status.success() {
            success_message.to_string()
        } else {
            failure_message.to_string()
        },
    })
}

#[tauri::command]
pub async fn git_fetch(project_path: String) -> Result<GitRemoteResult, String> {
    run_git_blocking("获取 Git 远程更新", move || {
        run_remote_command(
            &project_path,
            &["fetch", "--all", "--prune"],
            "获取远程更新成功",
            "获取远程更新失败",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_push(project_path: String) -> Result<GitRemoteResult, String> {
    run_git_blocking("推送 Git 提交", move || {
        run_remote_command(&project_path, &["push"], "推送成功", "推送失败")
    })
    .await
}

#[tauri::command]
pub async fn git_pull(project_path: String) -> Result<GitRemoteResult, String> {
    run_git_blocking("拉取 Git 更新", move || {
        run_remote_command(
            &project_path,
            &["pull", "--ff-only"],
            "拉取成功",
            "拉取失败",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_pull_rebase(project_path: String) -> Result<GitRemoteResult, String> {
    run_git_blocking("变基拉取 Git 更新", move || {
        run_remote_command(
            &project_path,
            &["pull", "--rebase"],
            "变基拉取成功",
            "变基拉取失败",
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn piped_child(command: &mut Command) -> Child {
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("test child should start")
    }

    #[cfg(windows)]
    fn large_output_child() -> Child {
        piped_child(Command::new("cmd").args([
            "/C",
            "for /L %i in (1,1,20000) do @echo Receiving objects: 012345678901234567890123456789",
        ]))
    }

    #[cfg(not(windows))]
    fn large_output_child() -> Child {
        piped_child(Command::new("sh").args([
            "-c",
            "i=0; while [ $i -lt 20000 ]; do echo 'Receiving objects: 012345678901234567890123456789'; i=$((i+1)); done",
        ]))
    }

    #[cfg(windows)]
    fn slow_child() -> Child {
        piped_child(Command::new("cmd").args(["/C", "ping -n 6 127.0.0.1 > nul"]))
    }

    #[cfg(not(windows))]
    fn slow_child() -> Child {
        piped_child(Command::new("sh").args(["-c", "sleep 5"]))
    }

    #[test]
    fn remote_commands_allow_large_repositories_five_minutes() {
        assert_eq!(REMOTE_COMMAND_TIMEOUT, Duration::from_secs(300));
    }

    #[test]
    fn drains_large_output_while_the_command_is_running() {
        let output = wait_with_timeout(large_output_child(), Duration::from_secs(10))
            .expect("large output should not block on a full pipe");

        assert!(output.status.success());
        assert!(output.stdout.len() > 64 * 1024);
    }

    #[test]
    fn terminates_a_command_after_the_timeout() {
        let started_at = Instant::now();
        let error = wait_with_timeout(slow_child(), Duration::from_millis(50))
            .expect_err("slow command should time out");

        assert!(error.contains("超时"));
        assert!(started_at.elapsed() < Duration::from_secs(2));
    }
}
