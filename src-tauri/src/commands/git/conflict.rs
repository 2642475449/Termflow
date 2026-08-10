use std::path::Path;

use super::types::GitConflictDetail;
use super::utils::{git_command, open_repo};

/// Get conflict details for a file.
#[tauri::command]
pub fn git_conflict_detail(
    project_path: String,
    file_path: String,
) -> Result<GitConflictDetail, String> {
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
    let worktree_path = crate::path_utils::normalize_input_path(&project_path).join(&file_path);
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
}

/// Abort a merge.
#[tauri::command]
pub fn git_abort_merge(project_path: String) -> Result<(), String> {
    let path = crate::path_utils::normalize_input_path(&project_path);

    let output = git_command()
        .args(["merge", "--abort"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("执行 git merge --abort 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "中止合并失败".to_string()
        });
    }

    Ok(())
}
