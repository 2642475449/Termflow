use super::types::{GitBranchListItem, GitRemoteResult};
use super::utils::{git_command, open_repo, with_git_repository_access, GitRepositoryAccess};

/// List all branches (local and remote).
#[tauri::command]
pub fn git_list_branches(project_path: String) -> Result<Vec<GitBranchListItem>, String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Read, || {
        let repo = open_repo(&project_path)?;

        // Get current HEAD branch name
        let current_branch = repo
            .head()
            .ok()
            .and_then(|head| head.shorthand().map(|s| s.to_string()))
            .unwrap_or_default();

        let mut branches = Vec::new();

        // Local branches
        for branch_result in repo
            .branches(Some(git2::BranchType::Local))
            .map_err(|e| format!("列举本地分支失败: {}", e))?
        {
            let (branch, _) = branch_result.map_err(|e| format!("读取分支失败: {}", e))?;

            let name = branch
                .name()
                .map_err(|e| format!("获取分支名称失败: {}", e))?
                .unwrap_or("")
                .to_string();

            if name.is_empty() {
                continue;
            }

            let is_current = name == current_branch;

            // Get upstream info
            let (upstream, ahead, behind) = match branch.upstream() {
                Ok(upstream_branch) => {
                    let upstream_name =
                        upstream_branch.name().ok().flatten().map(|s| s.to_string());

                    let (ahead, behind) = if let (Some(local_oid), Some(upstream_oid)) =
                        (branch.get().target(), upstream_branch.get().target())
                    {
                        repo.graph_ahead_behind(local_oid, upstream_oid)
                            .unwrap_or((0, 0))
                    } else {
                        (0, 0)
                    };

                    (upstream_name, ahead, behind)
                }
                Err(_) => (None, 0, 0),
            };

            branches.push(GitBranchListItem {
                name,
                is_current,
                is_remote: false,
                upstream,
                ahead,
                behind,
            });
        }

        // Remote branches
        for branch_result in repo
            .branches(Some(git2::BranchType::Remote))
            .map_err(|e| format!("列举远程分支失败: {}", e))?
        {
            let (branch, _) = branch_result.map_err(|e| format!("读取远程分支失败: {}", e))?;

            let name = branch
                .name()
                .map_err(|e| format!("获取远程分支名称失败: {}", e))?
                .unwrap_or("")
                .to_string();

            if name.is_empty() {
                continue;
            }

            branches.push(GitBranchListItem {
                name,
                is_current: false,
                is_remote: true,
                upstream: None,
                ahead: 0,
                behind: 0,
            });
        }

        // Sort: current first, then local, then remote
        branches.sort_by(|a, b| {
            a.is_current
                .cmp(&b.is_current)
                .reverse()
                .then_with(|| a.is_remote.cmp(&b.is_remote))
                .then_with(|| a.name.cmp(&b.name))
        });

        Ok(branches)
    })
}

/// Create a new branch from HEAD.
#[tauri::command]
pub fn git_create_branch(project_path: String, name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("分支名称不能为空".to_string());
    }

    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let repo = open_repo(&project_path)?;
        let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {}", e))?;
        let commit = head
            .peel_to_commit()
            .map_err(|e| format!("获取 HEAD 提交失败: {}", e))?;

        repo.branch(&name, &commit, false)
            .map_err(|e| format!("创建分支失败: {}", e))?;

        Ok(())
    })
}

/// Switch to a branch.
#[tauri::command]
pub fn git_switch_branch(project_path: String, name: String) -> Result<(), String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let path = crate::path_utils::normalize_input_path(&project_path);
        let repo = open_repo(&project_path)?;
        let is_remote_branch =
            repo.find_branch(&name, git2::BranchType::Remote).is_ok() && !name.ends_with("/HEAD");

        // Use git CLI for checkout (more reliable with worktree updates)
        let mut command = git_command();
        command.arg("checkout");
        if is_remote_branch {
            command.arg("--track");
        }
        let output = command
            .arg(&name)
            .current_dir(&path)
            .output()
            .map_err(|e| format!("执行 git checkout 失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "切换分支失败".to_string()
            });
        }

        Ok(())
    })
}

/// Delete a branch.
#[tauri::command]
pub fn git_delete_branch(
    project_path: String,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let path = crate::path_utils::normalize_input_path(&project_path);

        let flag = if force.unwrap_or(false) { "-D" } else { "-d" };

        let output = git_command()
            .args(["branch", flag, &name])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("执行 git branch 删除失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "删除分支失败".to_string()
            });
        }

        Ok(())
    })
}

/// Merge a branch into the current branch.
#[tauri::command]
pub fn git_merge_branch(
    project_path: String,
    branch_name: String,
) -> Result<GitRemoteResult, String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let path = crate::path_utils::normalize_input_path(&project_path);

        let output = git_command()
            .args(["merge", &branch_name])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("执行 git merge 失败: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let combined = format!("{}{}", stdout, stderr).trim().to_string();

        if output.status.success() {
            Ok(GitRemoteResult {
                success: true,
                message: if combined.is_empty() {
                    "合并成功".to_string()
                } else {
                    combined
                },
            })
        } else {
            Ok(GitRemoteResult {
                success: false,
                message: if combined.is_empty() {
                    "合并失败".to_string()
                } else {
                    combined
                },
            })
        }
    })
}
