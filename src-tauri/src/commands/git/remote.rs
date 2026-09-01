use super::types::{GitPullWithStashResult, GitRemoteResult};
use super::utils::{git_command, open_repo, run_git_blocking};
use std::io::Read;
use std::process::{Child, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const REMOTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn validate_remote_name(remote_name: &str) -> Result<&str, String> {
    let remote_name = remote_name.trim();
    if remote_name.is_empty() {
        return Err("远程名称不能为空".to_string());
    }
    if remote_name.starts_with('-')
        || !remote_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("远程名称只能包含字母、数字、点、下划线和连字符".to_string());
    }

    Ok(remote_name)
}

fn validate_remote_url(remote_url: &str) -> Result<&str, String> {
    let remote_url = remote_url.trim();
    if remote_url.is_empty() {
        return Err("远程仓库地址不能为空".to_string());
    }
    if remote_url.starts_with('-') {
        return Err("远程仓库地址无效".to_string());
    }

    Ok(remote_url)
}

fn validate_branch_name(branch_name: &str) -> Result<&str, String> {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err("推送分支不能为空".to_string());
    }
    if branch_name.starts_with('-') {
        return Err("推送分支无效".to_string());
    }

    Ok(branch_name)
}

fn find_existing_remote_url(
    project_path: &str,
    remote_name: &str,
) -> Result<Option<String>, String> {
    let repo = open_repo(project_path)?;
    let result = match repo.find_remote(remote_name) {
        Ok(remote) => remote
            .url()
            .map(|url| Some(url.to_string()))
            .ok_or_else(|| format!("远程仓库 {} 没有配置地址", remote_name)),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(format!("读取远程仓库 {} 失败: {}", remote_name, error)),
    };
    result
}

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

/// Add a remote and set the specified local branch to track it on the first push.
#[tauri::command]
pub async fn git_add_remote_and_push(
    project_path: String,
    remote_name: String,
    remote_url: String,
    branch_name: String,
) -> Result<GitRemoteResult, String> {
    let remote_name = validate_remote_name(&remote_name)?.to_string();
    let remote_url = validate_remote_url(&remote_url)?.to_string();
    let branch_name = validate_branch_name(&branch_name)?.to_string();

    run_git_blocking("连接 Git 远程仓库", move || {
        match find_existing_remote_url(&project_path, &remote_name)? {
            Some(existing_url) if existing_url != remote_url => {
                return Err(format!(
                    "远程仓库 {} 已存在，地址为 {}",
                    remote_name, existing_url
                ));
            }
            Some(_) => {}
            None => {
                let add_result = run_remote_command(
                    &project_path,
                    &["remote", "add", &remote_name, &remote_url],
                    "远程仓库已添加",
                    "添加远程仓库失败",
                )?;
                if !add_result.success {
                    return Ok(add_result);
                }
            }
        }

        let push_result = run_remote_command(
            &project_path,
            &["push", "--set-upstream", &remote_name, &branch_name],
            "远程仓库已连接并推送成功",
            "远程仓库已配置，但首次推送失败",
        )?;

        if push_result.success {
            return Ok(push_result);
        }

        Ok(GitRemoteResult {
            success: false,
            message: format!("远程仓库已配置，但首次推送失败：{}", push_result.message),
        })
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

fn read_optional_stash_oid(project_path: &str) -> Result<Option<String>, String> {
    let path = crate::path_utils::normalize_input_path(project_path);
    let output = git_command()
        .args(["rev-parse", "--verify", "refs/stash"])
        .current_dir(path)
        .output()
        .map_err(|error| format!("读取 Git stash 失败: {}", error))?;

    if !output.status.success() {
        return Ok(None);
    }

    let oid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!oid.is_empty()).then_some(oid))
}

fn drop_stash_by_oid(project_path: &str, stash_oid: &str) -> Result<bool, String> {
    let list_result = run_remote_command(
        project_path,
        &["stash", "list", "--format=%H"],
        "",
        "读取 Git stash 列表失败",
    )?;
    if !list_result.success {
        return Err(list_result.message);
    }

    let Some(index) = list_result
        .message
        .lines()
        .position(|candidate| candidate.trim() == stash_oid)
    else {
        return Ok(false);
    };
    let reference = format!("stash@{{{}}}", index);
    let drop_result = run_remote_command(
        project_path,
        &["stash", "drop", &reference],
        "安全备份已删除",
        "删除 Git stash 失败",
    )?;
    Ok(drop_result.success)
}

fn has_unmerged_paths(project_path: &str) -> Result<bool, String> {
    let path = crate::path_utils::normalize_input_path(project_path);
    let output = git_command()
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(path)
        .output()
        .map_err(|error| format!("检查 Git 冲突失败: {}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "检查 Git 冲突失败".to_string()
        } else {
            stderr
        });
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn pull_with_stash_sync(project_path: &str) -> Result<GitPullWithStashResult, String> {
    if has_unmerged_paths(project_path)? {
        return Ok(GitPullWithStashResult {
            success: false,
            message: "当前存在未解决的 Git 冲突，请先完成冲突处理后再拉取".to_string(),
            restore_status: "notNeeded".to_string(),
            stash_oid: None,
        });
    }

    let previous_stash_oid = read_optional_stash_oid(project_path)?;
    let stash_result = match run_remote_command(
        project_path,
        &[
            "stash",
            "push",
            "--include-untracked",
            "--message",
            "Termflow safe pull",
        ],
        "本地修改已安全保存",
        "保存本地修改失败",
    ) {
        Ok(result) => result,
        Err(message) => {
            let created_stash_oid = read_optional_stash_oid(project_path)?
                .filter(|oid| Some(oid) != previous_stash_oid.as_ref());
            let Some(stash_oid) = created_stash_oid else {
                return Ok(GitPullWithStashResult {
                    success: false,
                    message,
                    restore_status: "notNeeded".to_string(),
                    stash_oid: None,
                });
            };
            let restore_result = run_remote_command(
                project_path,
                &["stash", "apply", "--index", &stash_oid],
                "本地修改已恢复",
                "恢复本地修改失败",
            );
            let restored = restore_result
                .as_ref()
                .map(|result| result.success)
                .unwrap_or(false);
            let dropped = restored && drop_stash_by_oid(project_path, &stash_oid).unwrap_or(false);
            let message = if restored && dropped {
                format!("{}；本地修改已恢复", message)
            } else if restored {
                format!("{}；本地修改已恢复，安全 stash 已保留", message)
            } else {
                format!("{}；安全 stash 已保留", message)
            };
            return Ok(GitPullWithStashResult {
                success: false,
                message,
                restore_status: if restored { "restored" } else { "failed" }.to_string(),
                stash_oid: (!dropped).then_some(stash_oid),
            });
        }
    };
    if !stash_result.success {
        return Ok(GitPullWithStashResult {
            success: false,
            message: stash_result.message,
            restore_status: "notNeeded".to_string(),
            stash_oid: None,
        });
    }

    let created_stash_oid = read_optional_stash_oid(project_path)?;
    let stash_oid = created_stash_oid.filter(|oid| Some(oid) != previous_stash_oid.as_ref());

    // Git may report a dirty entry because only file metadata or line endings changed,
    // while `stash push` correctly determines that there is no content to save.
    let Some(stash_oid) = stash_oid else {
        let pull_result =
            run_remote_command(project_path, &["pull", "--ff-only"], "拉取成功", "拉取失败")?;
        return Ok(GitPullWithStashResult {
            success: pull_result.success,
            message: pull_result.message,
            restore_status: "notNeeded".to_string(),
            stash_oid: None,
        });
    };

    let pull_result =
        run_remote_command(project_path, &["pull", "--ff-only"], "拉取成功", "拉取失败")
            .unwrap_or_else(|message| GitRemoteResult {
                success: false,
                message,
            });

    let apply_result = run_remote_command(
        project_path,
        &["stash", "apply", "--index", &stash_oid],
        "本地修改已恢复",
        "恢复本地修改失败",
    )
    .unwrap_or_else(|message| GitRemoteResult {
        success: false,
        message,
    });

    if apply_result.success {
        let dropped = drop_stash_by_oid(project_path, &stash_oid).unwrap_or(false);
        let retained_oid = (!dropped).then_some(stash_oid);
        let message = if pull_result.success {
            if dropped {
                "拉取成功，本地修改已恢复".to_string()
            } else {
                "拉取成功，本地修改已恢复，但安全 stash 未能自动删除".to_string()
            }
        } else if dropped {
            format!("{}；本地修改已恢复", pull_result.message)
        } else {
            format!("{}；本地修改已恢复，安全 stash 已保留", pull_result.message)
        };
        return Ok(GitPullWithStashResult {
            success: pull_result.success,
            message,
            restore_status: "restored".to_string(),
            stash_oid: retained_oid,
        });
    }

    let restore_status = if has_unmerged_paths(project_path)? {
        "conflicts"
    } else {
        "failed"
    };
    let message = if pull_result.success {
        format!("{}；安全 stash 已保留", apply_result.message)
    } else {
        format!(
            "{}；恢复本地修改时出错：{}；安全 stash 已保留",
            pull_result.message, apply_result.message
        )
    };

    Ok(GitPullWithStashResult {
        success: pull_result.success,
        message,
        restore_status: restore_status.to_string(),
        stash_oid: Some(stash_oid),
    })
}

#[tauri::command]
pub async fn git_pull_with_stash(project_path: String) -> Result<GitPullWithStashResult, String> {
    run_git_blocking("安全拉取 Git 更新", move || {
        pull_with_stash_sync(&project_path)
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tempfile::TempDir;

    fn run_git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .expect("git command should start");
        assert!(
            output.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn configure_identity(path: &Path) {
        run_git(path, &["config", "user.name", "Termflow Test"]);
        run_git(path, &["config", "user.email", "termflow@example.com"]);
    }

    fn create_remote_clones() -> (TempDir, PathBuf, PathBuf) {
        let temp_dir = TempDir::new().expect("temp directory should be created");
        let remote_path = temp_dir.path().join("remote.git");
        let seed_path = temp_dir.path().join("seed");
        let local_path = temp_dir.path().join("local");
        let peer_path = temp_dir.path().join("peer");

        fs::create_dir_all(&remote_path).unwrap();
        run_git(&remote_path, &["init", "--bare"]);
        fs::create_dir_all(&seed_path).unwrap();
        run_git(&seed_path, &["init"]);
        configure_identity(&seed_path);
        fs::write(seed_path.join("base.txt"), "base\n").unwrap();
        fs::write(seed_path.join("working.txt"), "working base\n").unwrap();
        run_git(&seed_path, &["add", "--all"]);
        run_git(&seed_path, &["commit", "-m", "initial"]);
        run_git(&seed_path, &["branch", "-M", "main"]);
        run_git(
            &seed_path,
            &["remote", "add", "origin", remote_path.to_str().unwrap()],
        );
        run_git(&seed_path, &["push", "-u", "origin", "main"]);
        run_git(&remote_path, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        run_git(
            temp_dir.path(),
            &[
                "clone",
                remote_path.to_str().unwrap(),
                local_path.to_str().unwrap(),
            ],
        );
        run_git(
            temp_dir.path(),
            &[
                "clone",
                remote_path.to_str().unwrap(),
                peer_path.to_str().unwrap(),
            ],
        );
        configure_identity(&local_path);
        configure_identity(&peer_path);

        (temp_dir, local_path, peer_path)
    }

    fn commit_and_push(path: &Path, file_name: &str, content: &str, message: &str) {
        fs::write(path.join(file_name), content).unwrap();
        run_git(path, &["add", "--all"]);
        run_git(path, &["commit", "-m", message]);
        run_git(path, &["push"]);
    }

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

    #[test]
    fn validates_remote_configuration_arguments() {
        assert_eq!(validate_remote_name("origin").unwrap(), "origin");
        assert!(validate_remote_name("--origin").is_err());
        assert!(validate_remote_name("origin name").is_err());
        assert_eq!(
            validate_remote_url("https://example.com/repo.git").unwrap(),
            "https://example.com/repo.git"
        );
        assert!(validate_remote_url("--upload-pack=value").is_err());
        assert_eq!(
            validate_branch_name("feature/remote").unwrap(),
            "feature/remote"
        );
        assert!(validate_branch_name("--all").is_err());
    }

    #[test]
    fn safe_pull_restores_staged_unstaged_and_untracked_changes() {
        let (_temp_dir, local_path, peer_path) = create_remote_clones();
        commit_and_push(&peer_path, "upstream.txt", "upstream\n", "upstream change");

        fs::write(local_path.join("base.txt"), "staged local\n").unwrap();
        run_git(&local_path, &["add", "base.txt"]);
        fs::write(local_path.join("working.txt"), "unstaged local\n").unwrap();
        fs::write(local_path.join("untracked.txt"), "untracked local\n").unwrap();

        let result = pull_with_stash_sync(local_path.to_str().unwrap()).unwrap();

        assert!(result.success, "{}", result.message);
        assert_eq!(result.restore_status, "restored");
        assert_eq!(result.stash_oid, None);
        assert_eq!(
            fs::read_to_string(local_path.join("upstream.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "upstream\n"
        );
        assert_eq!(
            fs::read_to_string(local_path.join("untracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "untracked local\n"
        );
        assert_eq!(
            run_git(&local_path, &["diff", "--cached", "--name-only"]),
            "base.txt"
        );
        assert_eq!(
            run_git(&local_path, &["diff", "--name-only"]),
            "working.txt"
        );
        assert_eq!(
            read_optional_stash_oid(local_path.to_str().unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn safe_pull_retains_stash_when_restoring_changes_conflicts() {
        let (_temp_dir, local_path, peer_path) = create_remote_clones();
        fs::write(local_path.join("base.txt"), "local\n").unwrap();
        commit_and_push(
            &peer_path,
            "base.txt",
            "upstream\n",
            "conflicting upstream change",
        );

        let result = pull_with_stash_sync(local_path.to_str().unwrap()).unwrap();

        assert!(
            result.success,
            "the fast-forward pull itself should succeed"
        );
        assert_eq!(result.restore_status, "conflicts");
        assert!(result.stash_oid.is_some());
        assert!(has_unmerged_paths(local_path.to_str().unwrap()).unwrap());
        assert_eq!(
            read_optional_stash_oid(local_path.to_str().unwrap()).unwrap(),
            result.stash_oid
        );
    }

    #[test]
    fn safe_pull_restores_changes_when_fast_forward_is_rejected() {
        let (_temp_dir, local_path, peer_path) = create_remote_clones();
        fs::write(local_path.join("local-commit.txt"), "local commit\n").unwrap();
        run_git(&local_path, &["add", "--all"]);
        run_git(&local_path, &["commit", "-m", "local commit"]);
        commit_and_push(&peer_path, "upstream.txt", "upstream\n", "upstream commit");
        fs::write(local_path.join("working.txt"), "preserve me\n").unwrap();
        fs::write(local_path.join("untracked.txt"), "preserve me too\n").unwrap();

        let result = pull_with_stash_sync(local_path.to_str().unwrap()).unwrap();

        assert!(!result.success);
        assert_eq!(result.restore_status, "restored");
        assert_eq!(
            fs::read_to_string(local_path.join("working.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "preserve me\n"
        );
        assert_eq!(
            fs::read_to_string(local_path.join("untracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "preserve me too\n"
        );
        assert_eq!(
            read_optional_stash_oid(local_path.to_str().unwrap()).unwrap(),
            None
        );
    }
}
