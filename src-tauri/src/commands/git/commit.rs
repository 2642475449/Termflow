use super::types::GitCommitResult;
use super::utils::{git_command, open_repo, run_git_blocking, stage_paths};

/// Create a commit.
#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
    files: Vec<String>,
) -> Result<GitCommitResult, String> {
    run_git_blocking("创建 Git 提交", move || {
        git_commit_sync(project_path, message, files)
    })
    .await
}

fn git_commit_sync(
    project_path: String,
    message: String,
    files: Vec<String>,
) -> Result<GitCommitResult, String> {
    stage_paths(&project_path, &files)?;
    run_commit_command(&project_path, &message, false)?;
    let oid = read_head_commit_oid(&project_path)?;

    Ok(GitCommitResult {
        commit_oid: oid.to_string(),
        message,
    })
}

/// Stage files.
#[tauri::command]
pub async fn git_stage_files(project_path: String, files: Vec<String>) -> Result<(), String> {
    run_git_blocking("暂存 Git 文件", move || {
        git_stage_files_sync(project_path, files)
    })
    .await
}

fn git_stage_files_sync(project_path: String, files: Vec<String>) -> Result<(), String> {
    open_repo(&project_path)?;
    stage_paths(&project_path, &files)
}

/// Unstage files.
#[tauri::command]
pub async fn git_unstage_files(project_path: String, files: Vec<String>) -> Result<(), String> {
    run_git_blocking("取消暂存 Git 文件", move || {
        git_unstage_files_sync(project_path, files)
    })
    .await
}

fn git_unstage_files_sync(project_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&project_path)?;

    if let Ok(head) = repo.head() {
        let head_commit = head
            .peel_to_commit()
            .map_err(|e| format!("获取 HEAD 提交失败: {}", e))?;

        let pathspecs: Vec<&std::path::Path> = files
            .iter()
            .map(|f| std::path::Path::new(f.as_str()))
            .collect();
        repo.reset_default(Some(&head_commit.into_object()), pathspecs.iter().copied())
            .map_err(|e| format!("取消暂存失败: {}", e))?;
        return Ok(());
    }

    // Initial repository without HEAD: unstage by removing entries from the index.
    let mut index = repo.index().map_err(|e| format!("获取索引失败: {}", e))?;
    for file in &files {
        index
            .remove_path(std::path::Path::new(file))
            .map_err(|e| format!("取消暂存 {} 失败: {}", file, e))?;
    }
    index.write().map_err(|e| format!("写入索引失败: {}", e))?;

    Ok(())
}

/// Discard changes.
#[tauri::command]
pub async fn git_discard_changes(project_path: String, files: Vec<String>) -> Result<(), String> {
    run_git_blocking("丢弃 Git 更改", move || {
        git_discard_changes_sync(project_path, files)
    })
    .await
}

fn git_discard_changes_sync(project_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&project_path)?;

    let mut status_opts = git2::StatusOptions::new();
    status_opts
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);
    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| format!("获取 Git 状态失败: {}", e))?;
    let mut status_map = std::collections::HashMap::new();
    for entry in statuses.iter() {
        if let Some(path) = entry.path() {
            status_map.insert(path.to_string(), entry.status());
        }
    }

    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    let mut has_checkout_target = false;
    for file in &files {
        let status = status_map
            .get(file.as_str())
            .copied()
            .unwrap_or(git2::Status::CURRENT);
        let has_staged_change = status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        );
        let is_untracked_only = status.contains(git2::Status::WT_NEW) && !has_staged_change;

        if is_untracked_only {
            super::utils::trash_worktree_path(&project_path, file)?;
            continue;
        }

        checkout_opts.path(file);
        has_checkout_target = true;
    }

    if has_checkout_target {
        // Restore the working tree from the index so staged content is preserved.
        repo.checkout_index(None, Some(checkout_opts.force()))
            .map_err(|e| format!("丢弃更改失败: {}", e))?;
    }

    Ok(())
}

/// Amend a commit.
#[tauri::command]
pub async fn git_commit_amend(
    project_path: String,
    message: String,
    files: Vec<String>,
) -> Result<GitCommitResult, String> {
    run_git_blocking("修改 Git 提交", move || {
        git_commit_amend_sync(project_path, message, files)
    })
    .await
}

fn git_commit_amend_sync(
    project_path: String,
    message: String,
    files: Vec<String>,
) -> Result<GitCommitResult, String> {
    stage_paths(&project_path, &files)?;
    run_commit_command(&project_path, &message, true)?;
    let oid = read_head_commit_oid(&project_path)?;

    Ok(GitCommitResult {
        commit_oid: oid.to_string(),
        message,
    })
}

fn run_commit_command(project_path: &str, message: &str, amend: bool) -> Result<(), String> {
    let mut command = git_command();
    command.arg("commit");
    if amend {
        command.arg("--amend");
    }
    command
        .arg("-m")
        .arg(message)
        .current_dir(crate::path_utils::normalize_input_path(project_path));

    let output = command
        .output()
        .map_err(|e| format!("执行 git commit 失败: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else if amend {
        "修改提交失败".to_string()
    } else {
        "创建提交失败".to_string()
    })
}

fn read_head_commit_oid(project_path: &str) -> Result<String, String> {
    let repo = open_repo(project_path)?;
    let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {}", e))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| format!("获取 HEAD 提交失败: {}", e))?;
    Ok(commit.id().to_string())
}
