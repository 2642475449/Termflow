use super::commit::git_commit_sync;
use super::remote::{remote_requires_fetch, run_remote_command};
use super::types::GitRemoteResult;
use super::utils::{ensure_repository_allows_normal_commit, open_repo, run_git_write};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowAction {
    Push,
    Pull,
    Sync,
    CommitAndPush,
    CommitAndSync,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResult {
    pub commit_oid: Option<String>,
    pub success: bool,
    pub failed_stage: Option<String>,
    pub message: String,
}

#[tauri::command]
pub async fn git_run_workflow(
    project_path: String,
    expected_branch: String,
    action: WorkflowAction,
    message: Option<String>,
    files: Vec<String>,
    database: tauri::State<'_, std::sync::Arc<crate::database::Database>>,
) -> Result<WorkflowResult, String> {
    let proxy = super::super::network_proxy::load_resolved_proxy(&database)?;
    run_git_write(project_path.clone(), "执行 Git 工作流", move || {
        Ok(run_workflow(
            &project_path,
            &expected_branch,
            action,
            message.as_deref(),
            files,
            |args| run_remote_command(&project_path, args, "操作成功", "操作失败", &proxy),
        ))
    })
    .await
}

fn check_branch(project_path: &str, expected: &str) -> Result<(), String> {
    let repo = open_repo(project_path)?;
    ensure_repository_allows_normal_commit(&repo)?;
    let head = repo.find_reference("HEAD").map_err(|e| e.to_string())?;
    if head.symbolic_target() != Some(format!("refs/heads/{}", expected).as_str()) {
        return Err("当前分支已改变，操作已停止，请刷新后重试".to_string());
    }
    Ok(())
}

#[derive(Clone, PartialEq)]
struct Target {
    remote: String,
    push_remote: String,
    merge_ref: String,
    url: String,
    push_url: String,
}

fn target(project_path: &str, branch: &str) -> Result<Target, String> {
    let repo = open_repo(project_path)?;
    let config = repo.config().map_err(|e| e.to_string())?;
    let remote = config
        .get_string(&format!("branch.{}.remote", branch))
        .map_err(|_| "当前分支没有上游，请先发布分支".to_string())?;
    let merge_ref = config
        .get_string(&format!("branch.{}.merge", branch))
        .map_err(|e| e.to_string())?;
    if remote.starts_with('-') || remote == "." || !merge_ref.starts_with("refs/heads/") {
        return Err("当前上游配置不支持远程同步".to_string());
    }
    let r = repo.find_remote(&remote).map_err(|e| e.to_string())?;
    let url = r.url().ok_or("远程没有配置地址")?.to_string();
    let push_remote = config
        .get_string(&format!("branch.{}.pushRemote", branch))
        .or_else(|_| config.get_string("remote.pushDefault"))
        .unwrap_or_else(|_| remote.clone());
    if push_remote.starts_with('-') || push_remote == "." {
        return Err("推送目标配置无效".to_string());
    }
    let push = repo.find_remote(&push_remote).map_err(|e| e.to_string())?;
    let push_url = push
        .pushurl()
        .or_else(|| push.url())
        .ok_or("推送目标没有配置地址")?
        .to_string();
    Ok(Target {
        remote,
        push_remote,
        merge_ref,
        url,
        push_url,
    })
}

// 整个流程由调用方持有同一把写锁。阶段间仍校验分支及目标，以发现外部 CLI 的修改。
fn run_workflow<F>(
    project_path: &str,
    expected: &str,
    action: WorkflowAction,
    message: Option<&str>,
    files: Vec<String>,
    mut execute: F,
) -> WorkflowResult
where
    F: FnMut(&[&str]) -> Result<GitRemoteResult, String>,
{
    let mut result = WorkflowResult {
        commit_oid: None,
        success: false,
        failed_stage: None,
        message: String::new(),
    };
    let mut stage = "prepare";
    let mut destination_snapshot = None;
    let operation = (|| -> Result<(), String> {
        check_branch(project_path, expected)?;
        let destination = target(project_path, expected)?;
        destination_snapshot = Some(destination.clone());
        let repo = open_repo(project_path)?;
        if remote_requires_fetch(&repo, Some(&destination.remote))?
            || remote_requires_fetch(&repo, Some(&destination.push_remote))?
        {
            return Err("远程地址已改变，请先获取更新以验证新仓库".to_string());
        }
        drop(repo);
        if matches!(
            action,
            WorkflowAction::CommitAndPush | WorkflowAction::CommitAndSync
        ) {
            stage = "commit";
            let commit = git_commit_sync(
                project_path.to_string(),
                message.ok_or("提交说明不能为空")?.to_string(),
                files,
            )?;
            result.commit_oid = Some(commit.commit_oid);
        }
        let mut run = |args: &[&str]| -> Result<(), String> {
            check_branch(project_path, expected)?;
            if target(project_path, expected)? != destination {
                return Err("远程或上游配置已改变，操作已停止".to_string());
            }
            let remote = execute(args)?;
            if !remote.success {
                return Err(remote.message);
            }
            Ok(())
        };
        if matches!(action, WorkflowAction::Sync | WorkflowAction::CommitAndSync) {
            stage = "fetch";
            run(&["fetch", "--prune", &destination.remote])?;
            check_branch(project_path, expected)?;
            let repo = open_repo(project_path)?;
            let branch = repo
                .find_branch(expected, git2::BranchType::Local)
                .map_err(|e| e.to_string())?;
            let upstream = branch
                .upstream()
                .map_err(|_| "远程上游分支不存在，请重新发布或设置上游".to_string())?;
            let (ahead, behind) = repo
                .graph_ahead_behind(
                    branch.get().target().ok_or("本地提交不存在")?,
                    upstream.get().target().ok_or("上游提交不存在")?,
                )
                .map_err(|e| e.to_string())?;
            if behind > 0 {
                stage = "pull";
                run(&[
                    "pull",
                    if ahead > 0 { "--rebase" } else { "--ff-only" },
                    &destination.remote,
                    &destination.merge_ref,
                ])?;
                // 变基成功后提交号会变化；部分成功提示必须指向当前分支保留的提交。
                if result.commit_oid.is_some() {
                    check_branch(project_path, expected)?;
                    result.commit_oid = Some(
                        open_repo(project_path)?
                            .head()
                            .map_err(|e| e.to_string())?
                            .target()
                            .ok_or("无法读取变基后的提交")?
                            .to_string(),
                    );
                }
            }
            if ahead == 0 {
                return Ok(());
            }
        } else if action == WorkflowAction::Pull {
            stage = "pull";
            return run(&[
                "pull",
                "--ff-only",
                &destination.remote,
                &destination.merge_ref,
            ]);
        }
        stage = "push";
        run(&[
            "push",
            &destination.push_remote,
            &format!(
                "refs/heads/{}:{}",
                expected,
                if destination.push_remote == destination.remote {
                    destination.merge_ref.clone()
                } else {
                    format!("refs/heads/{}", expected)
                }
            ),
        ])
    })();
    match operation {
        Ok(()) => result.success = true,
        Err(error) => {
            // 推送拒绝后更新跟踪引用，但不覆盖原始失败结果，也不自动再次推送。
            if stage == "push" && check_branch(project_path, expected).is_ok() {
                if let Some(destination) = destination_snapshot {
                    if target(project_path, expected).is_ok_and(|current| current == destination) {
                        let _ = execute(&["fetch", "--prune", &destination.remote]);
                    }
                }
            }
            result.failed_stage = Some(stage.to_string());
            result.message = error;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::utils::{git_command, with_git_repository_access, GitRepositoryAccess};
    use super::*;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = git_command().args(args).current_dir(path).output().unwrap();
        assert!(
            output.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
    fn fixture() -> (TempDir, PathBuf) {
        let temp = TempDir::new().unwrap();
        let local = temp.path().join("local");
        let remote = temp.path().join("remote.git");
        std::fs::create_dir(&local).unwrap();
        std::fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        git(&local, &["init"]);
        git(&local, &["config", "user.name", "Test"]);
        git(&local, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(local.join("base.txt"), "base").unwrap();
        git(&local, &["add", "."]);
        git(&local, &["commit", "-m", "base"]);
        git(&local, &["branch", "-M", "main"]);
        git(&local, &["branch", "other"]);
        git(
            &local,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&local, &["push", "-u", "origin", "main"]);
        (temp, local)
    }
    fn success() -> Result<GitRemoteResult, String> {
        Ok(GitRemoteResult {
            success: true,
            message: String::new(),
        })
    }

    #[test]
    fn rejects_changed_branch_before_committing_or_network_access() {
        let (_temp, local) = fixture();
        let before = git(&local, &["rev-parse", "HEAD"]);
        let result = run_workflow(
            local.to_str().unwrap(),
            "other",
            WorkflowAction::CommitAndPush,
            Some("test"),
            vec![],
            |_| panic!("must not contact remote"),
        );
        assert!(!result.success);
        assert!(result.commit_oid.is_none());
        assert_eq!(git(&local, &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn preserves_commit_identity_for_both_remote_errors_and_failed_results() {
        for transport_error in [false, true] {
            let (_temp, local) = fixture();
            std::fs::write(local.join("new.txt"), "new").unwrap();
            let result = run_workflow(
                local.to_str().unwrap(),
                "main",
                WorkflowAction::CommitAndPush,
                Some("saved locally"),
                vec!["new.txt".into()],
                |_| {
                    if transport_error {
                        Err("spawn failed".into())
                    } else {
                        Ok(GitRemoteResult {
                            success: false,
                            message: "rejected".into(),
                        })
                    }
                },
            );
            assert!(!result.success);
            assert_eq!(result.failed_stage.as_deref(), Some("push"));
            assert_eq!(
                result.commit_oid.as_deref(),
                Some(git(&local, &["rev-parse", "HEAD"]).as_str())
            );
            assert_eq!(git(&local, &["rev-list", "--count", "HEAD"]), "2");
        }
    }

    #[test]
    fn external_checkout_after_fetch_stops_the_remaining_workflow() {
        let (_temp, local) = fixture();
        let mut calls = 0;
        let result = run_workflow(
            local.to_str().unwrap(),
            "main",
            WorkflowAction::Sync,
            None,
            vec![],
            |_| {
                calls += 1;
                git(&local, &["checkout", "other"]);
                success()
            },
        );
        assert!(!result.success);
        assert_eq!(calls, 1);
        assert!(result.message.contains("分支已改变"));
    }

    #[test]
    fn failed_rebase_never_reaches_push() {
        let (_temp, local) = fixture();
        git(&local, &["checkout", "other"]);
        std::fs::write(local.join("remote.txt"), "remote").unwrap();
        git(&local, &["add", "."]);
        git(&local, &["commit", "-m", "remote"]);
        let remote_oid = git(&local, &["rev-parse", "HEAD"]);
        git(
            &local,
            &["update-ref", "refs/remotes/origin/main", &remote_oid],
        );
        git(&local, &["checkout", "main"]);
        std::fs::write(local.join("local.txt"), "local").unwrap();
        git(&local, &["add", "."]);
        git(&local, &["commit", "-m", "local"]);
        let mut calls = Vec::new();
        let result = run_workflow(
            local.to_str().unwrap(),
            "main",
            WorkflowAction::Sync,
            None,
            vec![],
            |args| {
                calls.push(args[0].to_string());
                if args[0] == "pull" {
                    Ok(GitRemoteResult {
                        success: false,
                        message: "conflict".into(),
                    })
                } else {
                    success()
                }
            },
        );
        assert_eq!(calls, vec!["fetch", "pull"]);
        assert_eq!(result.failed_stage.as_deref(), Some("pull"));
    }

    #[test]
    fn a_branch_switch_waits_until_the_whole_workflow_releases_its_lock() {
        use std::sync::mpsc;
        use std::time::Duration;
        let (_temp, local) = fixture();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let path = local.to_str().unwrap().to_string();
        let worker_path = path.clone();
        let worker = std::thread::spawn(move || {
            with_git_repository_access(&worker_path, GitRepositoryAccess::Write, || {
                Ok(run_workflow(
                    &worker_path,
                    "main",
                    WorkflowAction::Sync,
                    None,
                    vec![],
                    |_| {
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                        success()
                    },
                ))
            })
            .unwrap()
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (switched_tx, switched_rx) = mpsc::channel();
        let switcher = std::thread::spawn(move || {
            super::super::branch::git_switch_branch(path, "other".into()).unwrap();
            switched_tx.send(()).unwrap();
        });
        assert!(switched_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().success);
        switcher.join().unwrap();
        assert_eq!(git(&local, &["branch", "--show-current"]), "other");
    }

    #[test]
    fn explicit_push_refspec_uses_the_reviewed_branch_and_upstream() {
        let (_temp, local) = fixture();
        let result = run_workflow(
            local.to_str().unwrap(),
            "main",
            WorkflowAction::Push,
            None,
            vec![],
            |args| {
                assert_eq!(args, ["push", "origin", "refs/heads/main:refs/heads/main"]);
                success()
            },
        );
        assert!(result.success);
    }

    #[test]
    fn preserves_a_configured_fork_push_remote() {
        let (_temp, local) = fixture();
        git(
            &local,
            &["remote", "add", "fork", "https://example.invalid/fork.git"],
        );
        git(&local, &["config", "branch.main.pushRemote", "fork"]);
        let result = run_workflow(
            local.to_str().unwrap(),
            "main",
            WorkflowAction::Push,
            None,
            vec![],
            |args| {
                assert_eq!(args, ["push", "fork", "refs/heads/main:refs/heads/main"]);
                success()
            },
        );
        assert!(result.success);
    }

    #[test]
    fn sync_rebases_and_pushes_diverged_history_against_a_local_remote() {
        let (_temp, local) = fixture();
        git(&local, &["checkout", "other"]);
        std::fs::write(local.join("remote.txt"), "remote").unwrap();
        git(&local, &["add", "."]);
        git(&local, &["commit", "-m", "remote"]);
        git(&local, &["push", "origin", "other:main"]);
        git(&local, &["checkout", "main"]);
        std::fs::write(local.join("local.txt"), "local").unwrap();
        let proxy = crate::network_proxy::resolve_network_proxy(
            &crate::network_proxy::NetworkProxySettings {
                mode: "disabled".into(),
                custom_proxy_url: String::new(),
                no_proxy: crate::network_proxy::DEFAULT_NO_PROXY.into(),
            },
        )
        .unwrap();
        let result = run_workflow(
            local.to_str().unwrap(),
            "main",
            WorkflowAction::CommitAndSync,
            Some("local"),
            vec!["local.txt".into()],
            |args| run_remote_command(local.to_str().unwrap(), args, "ok", "failed", &proxy),
        );
        assert!(result.success, "{}", result.message);
        assert!(result.commit_oid.is_some());
        assert_eq!(
            result.commit_oid.as_deref(),
            Some(git(&local, &["rev-parse", "HEAD"]).as_str())
        );
        assert_eq!(
            git(
                &local,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]
            ),
            "0\t0"
        );
        assert!(local.join("local.txt").exists());
        assert!(local.join("remote.txt").exists());
    }

    #[test]
    fn failed_fetch_after_commit_is_partial_success() {
        let (_temp, local) = fixture();
        std::fs::write(local.join("new.txt"), "new").unwrap();
        let result = run_workflow(
            local.to_str().unwrap(),
            "main",
            WorkflowAction::CommitAndSync,
            Some("local"),
            vec!["new.txt".into()],
            |_| Err("offline".into()),
        );
        assert!(!result.success);
        assert!(result.commit_oid.is_some());
        assert_eq!(result.failed_stage.as_deref(), Some("fetch"));
    }
}
