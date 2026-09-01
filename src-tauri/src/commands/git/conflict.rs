use std::path::Path;

use super::types::GitConflictDetail;
use super::utils::{
    git_command, open_repo, resolve_worktree_file_path, with_git_repository_access,
    GitRepositoryAccess,
};

/// Get conflict details for a file.
#[tauri::command]
pub fn git_conflict_detail(
    project_path: String,
    file_path: String,
) -> Result<GitConflictDetail, String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Read, || {
        let repo = open_repo(&project_path)?;
        let index = repo.index().map_err(|e| format!("读取索引失败: {}", e))?;

        // Check if file has conflicts
        let has_conflict = index
            .conflicts()
            .map_err(|e| format!("遍历冲突失败: {}", e))?
            .any(|conflict| {
                conflict
                    .as_ref()
                    .ok()
                    .and_then(|c| {
                        c.our
                            .as_ref()
                            .or(c.their.as_ref())
                            .or(c.ancestor.as_ref())
                            .map(|entry| {
                                let path = std::str::from_utf8(&entry.path).unwrap_or("");
                                path == file_path
                            })
                    })
                    .unwrap_or(false)
            });

        if !has_conflict {
            return Ok(GitConflictDetail {
                file_path,
                has_conflict: false,
                ours_content: None,
                theirs_content: None,
                base_content: None,
                merged_content: None,
            });
        }

        // Read merged content from worktree (contains conflict markers)
        let worktree_path = resolve_worktree_file_path(&repo, &file_path)?;
        let merged_content = if worktree_path.exists() {
            std::fs::read_to_string(&worktree_path).ok()
        } else {
            None
        };

        // Read ours content from index (stage 2)
        let ours_content = read_index_stage(&repo, &file_path, 2)?;

        // Read theirs content from index (stage 3)
        let theirs_content = read_index_stage(&repo, &file_path, 3)?;

        // Read base content from index (stage 1)
        let base_content = read_index_stage(&repo, &file_path, 1)?;

        Ok(GitConflictDetail {
            file_path,
            has_conflict: true,
            ours_content,
            theirs_content,
            base_content,
            merged_content,
        })
    })
}

/// Read a specific stage from the index.
fn read_index_stage(
    repo: &git2::Repository,
    file_path: &str,
    stage: i32,
) -> Result<Option<String>, String> {
    let index = repo.index().map_err(|e| format!("读取索引失败: {}", e))?;
    let path = Path::new(file_path);

    match index.get_path(path, stage) {
        Some(entry) => {
            let blob = repo
                .find_blob(entry.id)
                .map_err(|e| format!("读取 Blob 失败: {}", e))?;
            let content = String::from_utf8_lossy(blob.content()).to_string();
            Ok(Some(content))
        }
        None => Ok(None),
    }
}

/// Resolve a conflict.
///
/// Resolution modes:
/// - "ours": Accept current branch version
/// - "theirs": Accept incoming branch version
/// - "edited": Accept the current worktree content (user has manually edited)
#[tauri::command]
pub fn git_resolve_conflict(
    project_path: String,
    file_path: String,
    resolution: String,
) -> Result<(), String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let repo = open_repo(&project_path)?;
        resolve_worktree_file_path(&repo, &file_path)?;
        drop(repo);
        let path = crate::path_utils::normalize_input_path(&project_path);

        match resolution.as_str() {
            "ours" => {
                // Checkout ours version from index (stage 2)
                let output = git_command()
                    .args(["checkout", "--ours", "--", &file_path])
                    .current_dir(&path)
                    .output()
                    .map_err(|e| format!("执行 git checkout --ours 失败: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if !stderr.is_empty() {
                        stderr
                    } else {
                        "接受当前分支版本失败".to_string()
                    });
                }

                // Stage the resolved file
                let output = git_command()
                    .args(["add", "--", &file_path])
                    .current_dir(&path)
                    .output()
                    .map_err(|e| format!("执行 git add 失败: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if !stderr.is_empty() {
                        stderr
                    } else {
                        "暂存解决后的文件失败".to_string()
                    });
                }
            }
            "theirs" => {
                // Checkout theirs version from index (stage 3)
                let output = git_command()
                    .args(["checkout", "--theirs", "--", &file_path])
                    .current_dir(&path)
                    .output()
                    .map_err(|e| format!("执行 git checkout --theirs 失败: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if !stderr.is_empty() {
                        stderr
                    } else {
                        "接受传入分支版本失败".to_string()
                    });
                }

                // Stage the resolved file
                let output = git_command()
                    .args(["add", "--", &file_path])
                    .current_dir(&path)
                    .output()
                    .map_err(|e| format!("执行 git add 失败: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if !stderr.is_empty() {
                        stderr
                    } else {
                        "暂存解决后的文件失败".to_string()
                    });
                }
            }
            "edited" => {
                // User has manually edited the file, just stage it
                let output = git_command()
                    .args(["add", "--", &file_path])
                    .current_dir(&path)
                    .output()
                    .map_err(|e| format!("执行 git add 失败: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if !stderr.is_empty() {
                        stderr
                    } else {
                        "暂存解决后的文件失败".to_string()
                    });
                }
            }
            _ => {
                return Err(format!("未知的解决模式: {}", resolution));
            }
        }

        Ok(())
    })
}

fn abort_args_for_state(state: git2::RepositoryState) -> Result<[&'static str; 2], String> {
    match state {
        git2::RepositoryState::Merge => Ok(["merge", "--abort"]),
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => Ok(["rebase", "--abort"]),
        git2::RepositoryState::CherryPick | git2::RepositoryState::CherryPickSequence => {
            Ok(["cherry-pick", "--abort"])
        }
        git2::RepositoryState::Revert | git2::RepositoryState::RevertSequence => {
            Ok(["revert", "--abort"])
        }
        git2::RepositoryState::Clean => Err("当前没有可中止的 Git 操作".to_string()),
        git2::RepositoryState::Bisect => {
            Err("当前处于 bisect 状态，请使用 git bisect reset 结束操作".to_string())
        }
        git2::RepositoryState::ApplyMailbox | git2::RepositoryState::ApplyMailboxOrRebase => {
            Err("当前处于邮件补丁应用状态，请在终端完成或中止该操作".to_string())
        }
    }
}

fn continue_args_for_state(state: git2::RepositoryState) -> Result<[&'static str; 2], String> {
    match state {
        // `git merge --continue` delegates to `git commit` and can require an
        // editor. The existing MERGE_MSG is exactly what `--no-edit` commits,
        // so this is the non-interactive equivalent for the desktop UI.
        git2::RepositoryState::Merge => Ok(["commit", "--no-edit"]),
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => Ok(["rebase", "--continue"]),
        git2::RepositoryState::CherryPick | git2::RepositoryState::CherryPickSequence => {
            Ok(["cherry-pick", "--continue"])
        }
        git2::RepositoryState::Revert | git2::RepositoryState::RevertSequence => {
            Ok(["revert", "--continue"])
        }
        git2::RepositoryState::Clean => Err("当前没有可继续的 Git 操作".to_string()),
        git2::RepositoryState::Bisect => {
            Err("当前处于 bisect 状态，请使用 git bisect reset 结束操作".to_string())
        }
        git2::RepositoryState::ApplyMailbox | git2::RepositoryState::ApplyMailboxOrRebase => {
            Err("当前处于邮件补丁应用状态，请在终端完成或中止该操作".to_string())
        }
    }
}

fn run_abort_command(project_path: &str, args: [&str; 2]) -> Result<(), String> {
    let path = crate::path_utils::normalize_input_path(&project_path);

    let output = git_command()
        .args(args)
        .current_dir(&path)
        .output()
        .map_err(|e| format!("执行 git {} --abort 失败: {}", args[0], e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("中止 {} 操作失败", args[0])
        });
    }

    Ok(())
}

fn run_continue_command(project_path: &str, args: [&str; 2]) -> Result<(), String> {
    let path = crate::path_utils::normalize_input_path(project_path);
    let output = git_command()
        .args(args)
        .current_dir(&path)
        .output()
        .map_err(|error| format!("执行 git {} {} 失败: {}", args[0], args[1], error))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("继续 {} 操作失败", args[0])
    })
}

/// Continue a merge, rebase, cherry-pick or revert after all conflicts are resolved.
#[tauri::command]
pub fn git_continue_operation(project_path: String) -> Result<(), String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let repo = open_repo(&project_path)?;
        let index = repo
            .index()
            .map_err(|error| format!("读取 Git 索引失败: {}", error))?;
        if index.has_conflicts() {
            return Err("仍有未解决冲突，请先逐个解决并暂存冲突文件".to_string());
        }
        let args = continue_args_for_state(repo.state())?;
        drop(index);
        drop(repo);
        run_continue_command(&project_path, args)
    })
}

/// Abort the unfinished operation currently reported by the repository.
#[tauri::command]
pub fn git_abort_operation(project_path: String) -> Result<(), String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let repo = open_repo(&project_path)?;
        let args = abort_args_for_state(repo.state())?;
        drop(repo);
        run_abort_command(&project_path, args)
    })
}

/// Abort a merge.
///
/// Kept for compatibility with older front ends. New callers must use
/// `git_abort_operation`, which selects the correct command for rebase,
/// cherry-pick and revert as well.
#[tauri::command]
pub fn git_abort_merge(project_path: String) -> Result<(), String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        let repo = open_repo(&project_path)?;
        if repo.state() != git2::RepositoryState::Merge {
            return Err("当前并非合并状态；请使用通用 Git 操作中止功能".to_string());
        }
        drop(repo);
        run_abort_command(&project_path, ["merge", "--abort"])
    })
}

#[cfg(test)]
mod tests {
    use super::{abort_args_for_state, continue_args_for_state};

    #[test]
    fn selects_the_matching_abort_command_for_each_supported_operation() {
        assert_eq!(
            abort_args_for_state(git2::RepositoryState::Merge).unwrap(),
            ["merge", "--abort"]
        );
        assert_eq!(
            abort_args_for_state(git2::RepositoryState::RebaseMerge).unwrap(),
            ["rebase", "--abort"]
        );
        assert_eq!(
            abort_args_for_state(git2::RepositoryState::CherryPick).unwrap(),
            ["cherry-pick", "--abort"]
        );
        assert_eq!(
            abort_args_for_state(git2::RepositoryState::Revert).unwrap(),
            ["revert", "--abort"]
        );
    }

    #[test]
    fn selects_the_matching_continue_command_for_each_supported_operation() {
        assert_eq!(
            continue_args_for_state(git2::RepositoryState::Merge).unwrap(),
            ["commit", "--no-edit"]
        );
        assert_eq!(
            continue_args_for_state(git2::RepositoryState::RebaseInteractive).unwrap(),
            ["rebase", "--continue"]
        );
        assert_eq!(
            continue_args_for_state(git2::RepositoryState::CherryPickSequence).unwrap(),
            ["cherry-pick", "--continue"]
        );
        assert_eq!(
            continue_args_for_state(git2::RepositoryState::RevertSequence).unwrap(),
            ["revert", "--continue"]
        );
    }
}
