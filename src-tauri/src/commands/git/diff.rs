use git2::{DiffFlags, DiffOptions};
use std::path::Path;

use super::types::{
    GitDiffContentResult, GitDiffHunk, GitDiffHunkResult, GitDiffLine, GitDiffResult,
};
use super::utils::{
    decode_text_content, ensure_repository_allows_normal_commit, git_command, open_repo,
    resolve_worktree_file_path, with_git_repository_access, GitRepositoryAccess,
};

const BINARY_CONTENT_ERROR: &str = "__TERMFLOW_BINARY_GIT_CONTENT__";

/// Read file content from HEAD.
fn read_head_content(repo: &git2::Repository, file_path: &str) -> Result<Option<String>, String> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(_) => return Ok(None),
    };
    let commit = head
        .peel_to_commit()
        .map_err(|e| format!("获取 HEAD 提交失败: {}", e))?;
    let tree = commit
        .tree()
        .map_err(|e| format!("读取 HEAD 树失败: {}", e))?;
    let entry = match tree.get_path(Path::new(file_path)) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    let object = entry
        .to_object(repo)
        .map_err(|e| format!("读取 HEAD 对象失败: {}", e))?;
    let blob = object
        .as_blob()
        .ok_or_else(|| format!("HEAD 文件内容不可读取: {}", file_path))?;
    decode_text_content(blob.content().to_vec())
        .map(Some)
        .map_err(|_| BINARY_CONTENT_ERROR.to_string())
}

/// Read file content from index.
fn read_index_content(repo: &git2::Repository, file_path: &str) -> Result<Option<String>, String> {
    let index = repo.index().map_err(|e| format!("读取索引失败: {}", e))?;
    let Some(entry) = index.get_path(Path::new(file_path), 0) else {
        return Ok(None);
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| format!("读取索引 Blob 失败: {}", e))?;
    decode_text_content(blob.content().to_vec())
        .map(Some)
        .map_err(|_| BINARY_CONTENT_ERROR.to_string())
}

/// Read file content from worktree.
fn read_worktree_content(
    repo: &git2::Repository,
    file_path: &str,
) -> Result<Option<String>, String> {
    let absolute_path = resolve_worktree_file_path(repo, file_path)?;
    if !absolute_path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&absolute_path).map_err(|e| format!("读取工作树文件失败: {}", e))?;
    decode_text_content(bytes)
        .map(Some)
        .map_err(|_| BINARY_CONTENT_ERROR.to_string())
}

fn binary_diff_content(file_path: String, staged: bool) -> GitDiffContentResult {
    let (original_label, modified_label) = if staged {
        ("HEAD".to_string(), "Index".to_string())
    } else {
        ("HEAD".to_string(), "Worktree".to_string())
    };

    GitDiffContentResult {
        file_path,
        original_content: String::new(),
        modified_content: String::new(),
        is_binary: true,
        content_kind: Some("binary".to_string()),
        original_label,
        modified_label,
    }
}

/// Get diff for a file.
#[tauri::command]
pub fn git_diff(project_path: String, file_path: String) -> Result<GitDiffResult, String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Read, || {
        let repo = open_repo(&project_path)?;
        resolve_worktree_file_path(&repo, &file_path)?;

        let mut opts = DiffOptions::new();
        opts.pathspec(&file_path);

        // Try unstaged diff first (workdir vs index)
        let diff = repo
            .diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| format!("生成 diff 失败: {}", e))?;

        let mut is_binary = false;
        for delta in diff.deltas() {
            if delta.flags().contains(DiffFlags::BINARY) {
                is_binary = true;
                break;
            }
        }

        let mut diff_bytes = Vec::new();
        diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            diff_bytes.extend_from_slice(line.content());
            true
        })
        .map_err(|e| format!("打印 diff 失败: {}", e))?;

        let mut diff_text = String::from_utf8_lossy(&diff_bytes).to_string();

        // If no unstaged diff, try staged diff (index vs HEAD)
        if diff_text.is_empty() {
            let mut opts2 = DiffOptions::new();
            opts2.pathspec(&file_path);

            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

            let staged_diff = repo
                .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts2))
                .map_err(|e| format!("生成 staged diff 失败: {}", e))?;

            for delta in staged_diff.deltas() {
                if delta.flags().contains(DiffFlags::BINARY) {
                    is_binary = true;
                }
            }

            let mut staged_bytes = Vec::new();
            staged_diff
                .print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
                    staged_bytes.extend_from_slice(line.content());
                    true
                })
                .map_err(|e| format!("打印 staged diff 失败: {}", e))?;

            diff_text = String::from_utf8_lossy(&staged_bytes).to_string();
        }

        Ok(GitDiffResult {
            file_path,
            diff_text,
            is_binary,
        })
    })
}

/// Get diff content (original vs modified).
#[tauri::command]
pub fn git_diff_content(
    project_path: String,
    file_path: String,
    old_file_path: Option<String>,
    staged: bool,
) -> Result<GitDiffContentResult, String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Read, || {
        let repo = open_repo(&project_path)?;
        resolve_worktree_file_path(&repo, &file_path)?;
        if let Some(old_path) = old_file_path.as_deref() {
            resolve_worktree_file_path(&repo, old_path)?;
        }
        let original_path = old_file_path.as_deref().unwrap_or(&file_path);

        let content_result = (|| {
            if staged {
                Ok((
                    read_head_content(&repo, original_path)?.unwrap_or_default(),
                    read_index_content(&repo, &file_path)?.unwrap_or_default(),
                    "HEAD".to_string(),
                    "索引".to_string(),
                ))
            } else {
                let index_content = read_index_content(&repo, original_path)?;
                let has_index_content = index_content.is_some();
                let original_content = match index_content {
                    Some(content) => content,
                    None => read_head_content(&repo, original_path)?.unwrap_or_default(),
                };
                Ok((
                    original_content,
                    read_worktree_content(&repo, &file_path)?.unwrap_or_default(),
                    if has_index_content { "索引" } else { "HEAD" }.to_string(),
                    "工作树".to_string(),
                ))
            }
        })();

        match content_result {
            Ok((original_content, modified_content, original_label, modified_label)) => {
                Ok(GitDiffContentResult {
                    file_path,
                    original_content,
                    modified_content,
                    is_binary: false,
                    content_kind: Some("text".to_string()),
                    original_label,
                    modified_label,
                })
            }
            Err(error) if error == BINARY_CONTENT_ERROR => {
                Ok(binary_diff_content(file_path, staged))
            }
            Err(error) => Err(error),
        }
    })
}

/// Get diff hunks for a file.
#[tauri::command]
pub fn git_diff_hunks(
    project_path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiffHunkResult, String> {
    with_git_repository_access(&project_path, GitRepositoryAccess::Read, || {
        let repo = open_repo(&project_path)?;
        resolve_worktree_file_path(&repo, &file_path)?;
        let mut opts = DiffOptions::new();
        opts.pathspec(&file_path);

        let diff = if staged {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
                .map_err(|e| format!("生成 staged diff 失败: {}", e))?
        } else {
            repo.diff_index_to_workdir(None, Some(&mut opts))
                .map_err(|e| format!("生成 diff 失败: {}", e))?
        };

        // Use print() to collect patch data, then parse hunks from it
        let mut patch_bytes = Vec::new();
        diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            patch_bytes.extend_from_slice(line.content());
            true
        })
        .map_err(|e| format!("打印 diff 失败: {}", e))?;

        let patch_text = String::from_utf8_lossy(&patch_bytes);
        let hunks = parse_patch_hunks(&patch_text);

        Ok(GitDiffHunkResult { file_path, hunks })
    })
}

/// Parse patch text into structured hunks.
pub(crate) fn parse_patch_hunks(patch_text: &str) -> Vec<GitDiffHunk> {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<GitDiffHunk> = None;

    for line in patch_text.lines() {
        if line.starts_with("@@") {
            // Save previous hunk
            if let Some(h) = current_hunk.take() {
                hunks.push(h);
            }

            // Parse hunk header: @@ -old_start,old_lines +new_start,new_lines @@
            let (old_start, old_lines, new_start, new_lines) = parse_hunk_header(line);

            current_hunk = Some(GitDiffHunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
                header: line.to_string(),
                lines: Vec::new(),
                decision: None,
            });
        } else if let Some(ref mut hunk) = current_hunk {
            let (origin, content) = if let Some(rest) = line.strip_prefix('+') {
                ('+', rest.to_string())
            } else if let Some(rest) = line.strip_prefix('-') {
                ('-', rest.to_string())
            } else if let Some(rest) = line.strip_prefix(' ') {
                (' ', rest.to_string())
            } else if line.starts_with("\\") {
                ('\\', line.to_string())
            } else {
                (' ', line.to_string())
            };

            hunk.lines.push(GitDiffLine {
                origin,
                content,
                old_lineno: None,
                new_lineno: None,
            });
        }
    }

    // Don't forget the last hunk
    if let Some(h) = current_hunk.take() {
        hunks.push(h);
    }

    hunks
}

/// Parse hunk header line to extract line numbers.
fn parse_hunk_header(header: &str) -> (u32, u32, u32, u32) {
    // Format: @@ -old_start,old_lines +new_start,new_lines @@
    let parts: Vec<&str> = header.split_whitespace().collect();
    if parts.len() < 3 {
        return (0, 0, 0, 0);
    }

    let old = parts[1]; // -old_start,old_lines
    let new = parts[2]; // +new_start,new_lines

    let (old_start, old_lines) = parse_range(old);
    let (new_start, new_lines) = parse_range(new);

    (old_start, old_lines, new_start, new_lines)
}

/// Parse a range like "-10,5" or "+10,5".
fn parse_range(range: &str) -> (u32, u32) {
    let range = range.trim_start_matches('-').trim_start_matches('+');
    let parts: Vec<&str> = range.split(',').collect();
    let start = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let lines = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    (start, lines)
}

fn git_patch_text(project_path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    let path = crate::path_utils::normalize_input_path(project_path);
    let mut args = vec!["diff", "--no-ext-diff", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file_path);

    let output = git_command()
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| format!("执行 git diff 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "生成 diff 失败".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn single_hunk_patch(patch_text: &str, hunk_header: &str) -> Result<String, String> {
    let target_header = hunk_header.trim();
    let mut file_header = Vec::new();
    let mut hunk_lines = Vec::new();
    let mut in_target_hunk = false;
    let mut saw_any_hunk = false;

    for line in patch_text.lines() {
        if line.starts_with("@@") {
            saw_any_hunk = true;
            if in_target_hunk {
                break;
            }
            in_target_hunk = line.trim() == target_header;
            if in_target_hunk {
                hunk_lines.push(line);
            }
            continue;
        }

        if !saw_any_hunk {
            file_header.push(line);
        } else if in_target_hunk {
            hunk_lines.push(line);
        }
    }

    if hunk_lines.is_empty() {
        return Err("未找到匹配的 hunk".to_string());
    }

    let mut result = String::new();
    result.push_str(&file_header.join("\n"));
    result.push('\n');
    result.push_str(&hunk_lines.join("\n"));
    result.push('\n');
    Ok(result)
}

fn apply_hunk_patch(project_path: &str, patch: &str, reverse: bool) -> Result<(), String> {
    let path = crate::path_utils::normalize_input_path(project_path);
    let mut args = vec!["apply", "--cached"];
    if reverse {
        args.push("--reverse");
    }

    let mut output = git_command()
        .args(&args)
        .current_dir(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 git apply 失败: {}", e))?;

    if let Some(mut stdin) = output.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("写入 patch 失败: {}", e))?;
    }

    let result = output
        .wait_with_output()
        .map_err(|e| format!("等待 git apply 完成失败: {}", e))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "应用 hunk 失败".to_string()
        } else {
            stderr
        });
    }

    Ok(())
}

fn apply_single_hunk(
    project_path: &str,
    file_path: &str,
    hunk_header: &str,
    staged: bool,
) -> Result<(), String> {
    let repo = open_repo(project_path)?;
    resolve_worktree_file_path(&repo, file_path)?;
    ensure_repository_allows_normal_commit(&repo)?;
    drop(repo);
    let patch_text = git_patch_text(project_path, file_path, staged)?;
    let patch = single_hunk_patch(&patch_text, hunk_header)?;
    apply_hunk_patch(project_path, &patch, staged)
}

/// Stage a specific hunk by its header.
#[tauri::command]
#[allow(unreachable_code)]
pub fn git_stage_hunk(
    project_path: String,
    file_path: String,
    hunk_header: String,
) -> Result<(), String> {
    return with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        apply_single_hunk(&project_path, &file_path, &hunk_header, false)
    });

    let path = crate::path_utils::normalize_input_path(&project_path);

    // Get the patch for the file (unstaged)
    let repo = open_repo(&project_path)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(&file_path);

    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| format!("生成 diff 失败: {}", e))?;

    // Build the full patch text, filtering to only the matching hunk
    let mut patch_bytes = Vec::new();
    let mut in_target_hunk = false;
    let mut file_header_written = false;

    diff.print(git2::DiffFormat::Patch, |_delta, hunk, line| {
        let hunk_header_bytes = hunk.map(|h| h.header().to_vec());

        if let Some(ref header_bytes) = hunk_header_bytes {
            let header = String::from_utf8_lossy(header_bytes).trim().to_string();
            if header == hunk_header {
                in_target_hunk = true;
                if !file_header_written {
                    // Write file header (diff --git a/... b/... etc.)
                    // We need to construct this from the delta info
                    file_header_written = true;
                }
            } else {
                in_target_hunk = false;
            }
        }

        if in_target_hunk {
            patch_bytes.extend_from_slice(line.content());
        }

        true
    })
    .map_err(|e| format!("打印 diff 失败: {}", e))?;

    if patch_bytes.is_empty() {
        return Err("未找到匹配的 hunk".to_string());
    }

    // Use git apply --cached to stage the hunk
    let patch = String::from_utf8_lossy(&patch_bytes).to_string();

    // Construct a minimal patch with file header
    let full_patch = format!(
        "diff --git a/{0} b/{0}\n--- a/{0}\n+++ b/{0}\n{1}",
        file_path, patch
    );

    let mut output = git_command()
        .args(["apply", "--cached", "--unidiff-zero"])
        .current_dir(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 git apply 失败: {}", e))?;

    // Write patch to stdin
    if let Some(mut stdin) = output.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(full_patch.as_bytes())
            .map_err(|e| format!("写入 patch 失败: {}", e))?;
    }

    let result = output
        .wait_with_output()
        .map_err(|e| format!("等待 git apply 完成失败: {}", e))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else {
            "暂存 hunk 失败".to_string()
        });
    }

    Ok(())
}

/// Unstage a specific hunk by its header (reverse apply).
#[tauri::command]
#[allow(unreachable_code)]
pub fn git_unstage_hunk(
    project_path: String,
    file_path: String,
    hunk_header: String,
) -> Result<(), String> {
    return with_git_repository_access(&project_path, GitRepositoryAccess::Write, || {
        apply_single_hunk(&project_path, &file_path, &hunk_header, true)
    });

    let path = crate::path_utils::normalize_input_path(&project_path);

    // Get the patch for the file (staged diff: index vs HEAD)
    let repo = open_repo(&project_path)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(&file_path);

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(|e| format!("生成 staged diff 失败: {}", e))?;

    // Build the patch for the matching hunk
    let mut patch_bytes = Vec::new();
    let mut in_target_hunk = false;

    diff.print(git2::DiffFormat::Patch, |_delta, hunk, line| {
        let hunk_header_bytes = hunk.map(|h| h.header().to_vec());

        if let Some(ref header_bytes) = hunk_header_bytes {
            let header = String::from_utf8_lossy(header_bytes).trim().to_string();
            if header == hunk_header {
                in_target_hunk = true;
            } else {
                in_target_hunk = false;
            }
        }

        if in_target_hunk {
            patch_bytes.extend_from_slice(line.content());
        }

        true
    })
    .map_err(|e| format!("打印 diff 失败: {}", e))?;

    if patch_bytes.is_empty() {
        return Err("未找到匹配的 hunk".to_string());
    }

    let patch = String::from_utf8_lossy(&patch_bytes).to_string();
    let full_patch = format!(
        "diff --git a/{0} b/{0}\n--- a/{0}\n+++ b/{0}\n{1}",
        file_path, patch
    );

    // Use git apply --cached --reverse to unstage
    let mut output = git_command()
        .args(["apply", "--cached", "--reverse", "--unidiff-zero"])
        .current_dir(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 git apply 失败: {}", e))?;

    if let Some(mut stdin) = output.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(full_patch.as_bytes())
            .map_err(|e| format!("写入 patch 失败: {}", e))?;
    }

    let result = output
        .wait_with_output()
        .map_err(|e| format!("等待 git apply 完成失败: {}", e))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else {
            "取消暂存 hunk 失败".to_string()
        });
    }

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::git_diff_content;
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo(label: &str) -> (PathBuf, Repository) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "termflow-git-binary-diff-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        let repo = Repository::init(&path).unwrap();
        (path, repo)
    }

    fn write_binary(path: &Path, marker: u8) {
        fs::write(path, [0, 159, 146, 150, marker]).unwrap();
    }

    fn add_to_index(repo: &Repository, file_name: &str) {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file_name)).unwrap();
        index.write().unwrap();
    }

    fn commit_index(repo: &Repository) {
        let mut index = repo.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = Signature::now("Termflow Test", "termflow@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "binary", &tree, &[])
            .unwrap();
    }

    #[test]
    fn untracked_binary_content_is_a_supported_non_diff() {
        let (root, repo) = temp_repo("untracked");
        write_binary(&root.join("image.png"), 1);

        let result = git_diff_content(
            root.to_string_lossy().into_owned(),
            "image.png".to_string(),
            None,
            false,
        )
        .expect("binary content should not be an error");

        assert!(result.is_binary);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tracked_binary_content_is_a_supported_non_diff_when_staged_or_unstaged() {
        let (root, repo) = temp_repo("tracked");
        let file_name = "image.png";
        write_binary(&root.join(file_name), 1);
        add_to_index(&repo, file_name);
        commit_index(&repo);

        write_binary(&root.join(file_name), 2);
        let unstaged = git_diff_content(
            root.to_string_lossy().into_owned(),
            file_name.to_string(),
            None,
            false,
        )
        .expect("unstaged binary content should not be an error");
        assert!(unstaged.is_binary);

        add_to_index(&repo, file_name);
        let staged = git_diff_content(
            root.to_string_lossy().into_owned(),
            file_name.to_string(),
            None,
            true,
        )
        .expect("staged binary content should not be an error");
        assert!(staged.is_binary);

        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diff_content_rejects_a_path_outside_the_worktree() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = std::env::temp_dir().join(format!(
            "termflow-git-diff-path-safety-{}-{suffix}",
            std::process::id()
        ));
        let root = parent.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(parent.join("outside.txt"), "must not be readable").unwrap();
        let repo = Repository::init(&root).unwrap();

        let error = git_diff_content(
            root.to_string_lossy().into_owned(),
            "../outside.txt".to_string(),
            None,
            false,
        )
        .unwrap_err();

        assert!(error.contains("工作树之外"));
        drop(repo);
        fs::remove_dir_all(parent).unwrap();
    }
}
