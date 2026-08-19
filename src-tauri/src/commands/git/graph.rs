use std::path::Path;

use git2::{Commit, Delta, DiffOptions, ErrorCode, Oid, Repository, Tree};

use super::types::{
    GitDiffContentResult, GitGraphChangedFile, GitGraphCommit, GitGraphCommitDetail,
};
use super::utils::{collect_commit_refs, decode_text_content, open_repo, run_git_blocking};

/// 默认分页大小
const DEFAULT_HISTORY_PAGE_SIZE: usize = 100;
/// 单次请求允许的最大分页大小；提交历史总数不受此值限制
const MAX_HISTORY_PAGE_SIZE: usize = 200;
/// 短 OID 长度
const SHORT_OID_LENGTH: usize = 7;

/// Get commit history for graph.
#[tauri::command]
pub async fn git_graph_history(
    project_path: String,
    limit: Option<usize>,
    cursor: Option<String>,
    file_path: Option<String>,
) -> Result<Vec<GitGraphCommit>, String> {
    run_git_blocking("读取 Git 提交历史", move || {
        git_graph_history_sync(project_path, limit, cursor, file_path)
    })
    .await
}

fn git_graph_history_sync(
    project_path: String,
    limit: Option<usize>,
    cursor: Option<String>,
    file_path: Option<String>,
) -> Result<Vec<GitGraphCommit>, String> {
    let repo = open_repo(&project_path)?;
    let file_path = file_path
        .map(|path| path.trim().replace('\\', "/"))
        .filter(|path| !path.is_empty());
    let refs_by_oid = collect_commit_refs(&repo)?;
    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("创建提交历史遍历失败: {}", e))?;
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| format!("设置提交历史排序失败: {}", e))?;
    revwalk
        .push_head()
        .map_err(|e| format!("读取 HEAD 提交历史失败: {}", e))?;
    for reference_glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
        revwalk
            .push_glob(reference_glob)
            .map_err(|e| format!("读取 Git 引用 {} 的提交历史失败: {}", reference_glob, e))?;
    }

    let page_size = limit
        .unwrap_or(DEFAULT_HISTORY_PAGE_SIZE)
        .clamp(1, MAX_HISTORY_PAGE_SIZE);
    let mut commits = Vec::new();
    let mut cursor_reached = cursor.is_none();

    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| format!("遍历提交历史失败: {}", e))?;
        if !cursor_reached {
            if cursor.as_deref() == Some(oid.to_string().as_str()) {
                cursor_reached = true;
            }
            continue;
        }

        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("读取提交 {} 失败: {}", oid, e))?;
        if let Some(file_path) = file_path.as_deref() {
            if !commit_touches_path(&repo, &commit, file_path)? {
                continue;
            }
        }
        let oid_string = oid.to_string();
        let short_oid: String = oid_string.chars().take(SHORT_OID_LENGTH).collect();
        let parent_oids = commit
            .parents()
            .map(|parent| parent.id().to_string())
            .collect();
        let refs = refs_by_oid.get(&oid_string).cloned().unwrap_or_default();

        commits.push(GitGraphCommit {
            oid: oid_string,
            short_oid,
            summary: commit.summary().unwrap_or("无提交信息").to_string(),
            author_name: commit.author().name().unwrap_or("Unknown").to_string(),
            author_email: commit.author().email().unwrap_or("").to_string(),
            timestamp_ms: commit.time().seconds().saturating_mul(1000),
            parent_oids,
            refs,
        });

        if commits.len() >= page_size {
            break;
        }
    }

    Ok(commits)
}

fn commit_touches_path(
    repo: &Repository,
    commit: &Commit<'_>,
    file_path: &str,
) -> Result<bool, String> {
    let tree = commit
        .tree()
        .map_err(|e| format!("读取提交 {} 的树失败: {}", commit.id(), e))?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| format!("读取提交 {} 的父提交失败: {}", commit.id(), e))?
                .tree()
                .map_err(|e| format!("读取提交 {} 的父树失败: {}", commit.id(), e))?,
        )
    } else {
        None
    };
    let mut options = DiffOptions::new();
    options.pathspec(file_path).disable_pathspec_match(true);
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut options))
        .map_err(|e| {
            format!(
                "读取文件 {} 在提交 {} 的更改失败: {}",
                file_path,
                commit.id(),
                e
            )
        })?;
    let changed = diff
        .deltas()
        .any(|delta| delta.status() != Delta::Unmodified);
    Ok(changed)
}

/// Get commit detail for graph hover card.
#[tauri::command]
pub async fn git_graph_commit_detail(
    project_path: String,
    oid: String,
) -> Result<GitGraphCommitDetail, String> {
    run_git_blocking("读取 Git 提交详情", move || {
        git_graph_commit_detail_sync(project_path, oid)
    })
    .await
}

fn git_graph_commit_detail_sync(
    project_path: String,
    oid: String,
) -> Result<GitGraphCommitDetail, String> {
    let repo = open_repo(&project_path)?;
    let commit_oid = Oid::from_str(&oid).map_err(|e| format!("解析提交 OID 失败: {}", e))?;
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|e| format!("读取提交 {} 失败: {}", oid, e))?;
    let tree = commit
        .tree()
        .map_err(|e| format!("读取提交 {} 的树失败: {}", oid, e))?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| format!("读取提交 {} 的父提交失败: {}", oid, e))?
                .tree()
                .map_err(|e| format!("读取提交 {} 的父树失败: {}", oid, e))?,
        )
    } else {
        None
    };

    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| format!("计算提交 {} 的差异失败: {}", oid, e))?;
    diff.find_similar(None)
        .map_err(|e| format!("Detecting renamed files for commit {} failed: {}", oid, e))?;
    let stats = diff
        .stats()
        .map_err(|e| format!("读取提交 {} 的统计信息失败: {}", oid, e))?;

    let files = diff
        .deltas()
        .filter_map(|delta| {
            let status = graph_file_status(delta.status())?;
            let old_path = delta
                .old_file()
                .path()
                .map(|path| path.to_string_lossy().into_owned());
            let new_path = delta
                .new_file()
                .path()
                .map(|path| path.to_string_lossy().into_owned());
            let path = new_path.clone().or_else(|| old_path.clone())?;
            let old_path = old_path.filter(|old_path| Some(old_path) != new_path.as_ref());

            Some(GitGraphChangedFile {
                path,
                old_path,
                status: status.to_string(),
            })
        })
        .collect();
    Ok(GitGraphCommitDetail {
        oid,
        body: commit.body().unwrap_or("").trim().to_string(),
        changed_files: stats.files_changed(),
        insertions: stats.insertions(),
        deletions: stats.deletions(),
        files,
    })
}
fn graph_file_status(status: Delta) -> Option<&'static str> {
    match status {
        Delta::Added => Some("added"),
        Delta::Deleted => Some("deleted"),
        Delta::Modified => Some("modified"),
        Delta::Renamed => Some("renamed"),
        Delta::Copied => Some("copied"),
        Delta::Typechange => Some("typechange"),
        Delta::Conflicted => Some("conflicted"),
        Delta::Untracked => Some("untracked"),
        Delta::Unreadable => Some("unreadable"),
        Delta::Unmodified | Delta::Ignored => None,
    }
}

fn read_tree_blob(
    repo: &Repository,
    tree: Option<&Tree<'_>>,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let Some(tree) = tree else {
        return Ok(Vec::new());
    };
    let entry = match tree.get_path(Path::new(file_path)) {
        Ok(entry) => entry,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Reading committed file {} failed: {}",
                file_path, error
            ))
        }
    };
    let blob = repo.find_blob(entry.id()).map_err(|error| {
        format!(
            "Reading committed file content {} failed: {}",
            file_path, error
        )
    })?;
    Ok(blob.content().to_vec())
}

#[tauri::command]
pub async fn git_graph_file_diff(
    project_path: String,
    oid: String,
    file_path: String,
    old_file_path: Option<String>,
) -> Result<GitDiffContentResult, String> {
    run_git_blocking("Read Git history file diff", move || {
        git_graph_file_diff_sync(project_path, oid, file_path, old_file_path)
    })
    .await
}

fn git_graph_file_diff_sync(
    project_path: String,
    oid: String,
    file_path: String,
    old_file_path: Option<String>,
) -> Result<GitDiffContentResult, String> {
    let repo = open_repo(&project_path)?;
    let commit_oid =
        Oid::from_str(&oid).map_err(|e| format!("Parsing commit OID failed: {}", e))?;
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|e| format!("Reading commit {} failed: {}", oid, e))?;
    let tree = commit
        .tree()
        .map_err(|e| format!("Reading tree for commit {} failed: {}", oid, e))?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| format!("Reading parent for commit {} failed: {}", oid, e))?
                .tree()
                .map_err(|e| format!("Reading parent tree for commit {} failed: {}", oid, e))?,
        )
    } else {
        None
    };

    let original_path = old_file_path.as_deref().unwrap_or(&file_path);
    let original_bytes = read_tree_blob(&repo, parent_tree.as_ref(), original_path)?;
    let modified_bytes = read_tree_blob(&repo, Some(&tree), &file_path)?;
    let short_oid: String = oid.chars().take(SHORT_OID_LENGTH).collect();
    let parent_label = commit
        .parent_id(0)
        .ok()
        .map(|parent_oid| {
            parent_oid
                .to_string()
                .chars()
                .take(SHORT_OID_LENGTH)
                .collect()
        })
        .unwrap_or_else(|| "empty".to_string());

    let (original_content, modified_content, is_binary) = match (
        decode_text_content(original_bytes),
        decode_text_content(modified_bytes),
    ) {
        (Ok(original), Ok(modified)) => (original, modified, false),
        _ => (String::new(), String::new(), true),
    };

    Ok(GitDiffContentResult {
        file_path: file_path.clone(),
        original_content,
        modified_content,
        is_binary,
        content_kind: Some(if is_binary { "binary" } else { "text" }.to_string()),
        original_label: parent_label,
        modified_label: short_oid,
    })
}
#[cfg(test)]
mod tests {
    use super::git_graph_history_sync;
    use git2::{Oid, Repository, Signature};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_repo_path(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-repos");
        fs::create_dir_all(&test_root).unwrap();
        test_root.join(format!("{}-{}-{}", prefix, std::process::id(), suffix))
    }

    fn commit_file(
        repo: &Repository,
        signature: &Signature<'_>,
        file_path: &str,
        content: &str,
        message: &str,
    ) -> Oid {
        fs::write(repo.workdir().unwrap().join(file_path), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file_path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent = repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .map(|oid| repo.find_commit(oid).unwrap());

        match parent.as_ref() {
            Some(parent) => repo
                .commit(
                    Some("HEAD"),
                    signature,
                    signature,
                    message,
                    &tree,
                    &[parent],
                )
                .unwrap(),
            None => repo
                .commit(Some("HEAD"), signature, signature, message, &tree, &[])
                .unwrap(),
        }
    }

    #[test]
    fn graph_history_includes_remote_tracking_commits() {
        let repo_path = test_repo_path("termflow-graph-remote");
        let repo = Repository::init(&repo_path).unwrap();
        let signature = Signature::now("Termflow Test", "termflow@example.com").unwrap();
        let tree_oid = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let local_oid = repo
            .commit(Some("HEAD"), &signature, &signature, "local", &tree, &[])
            .unwrap();
        let local_commit = repo.find_commit(local_oid).unwrap();
        let remote_oid = repo
            .commit(
                None,
                &signature,
                &signature,
                "remote only",
                &tree,
                &[&local_commit],
            )
            .unwrap();
        repo.reference(
            "refs/remotes/origin/master",
            remote_oid,
            true,
            "test remote tracking ref",
        )
        .unwrap();
        drop(local_commit);
        drop(tree);
        drop(repo);

        let commits = git_graph_history_sync(
            repo_path.to_string_lossy().into_owned(),
            Some(100),
            None,
            None,
        )
        .unwrap();
        let remote_commit = commits
            .iter()
            .find(|commit| commit.oid == remote_oid.to_string())
            .expect("remote-only commit should be present in graph history");
        assert!(remote_commit
            .refs
            .iter()
            .any(|reference| reference.kind == "remote" && reference.name == "origin/master"));

        fs::remove_dir_all(repo_path).unwrap();
    }

    #[test]
    fn graph_history_can_be_filtered_to_one_file() {
        let repo_path = test_repo_path("termflow-graph-file-history");
        let repo = Repository::init(&repo_path).unwrap();
        let signature = Signature::now("Termflow Test", "termflow@example.com").unwrap();
        let target_created = commit_file(&repo, &signature, "target.txt", "one", "create target");
        let unrelated = commit_file(&repo, &signature, "other.txt", "other", "change other");
        let target_updated = commit_file(&repo, &signature, "target.txt", "two", "update target");
        drop(repo);

        let commits = git_graph_history_sync(
            repo_path.to_string_lossy().into_owned(),
            Some(100),
            None,
            Some("target.txt".to_string()),
        )
        .unwrap();
        assert!(commits
            .iter()
            .any(|commit| commit.oid == target_created.to_string()));
        assert!(commits
            .iter()
            .any(|commit| commit.oid == target_updated.to_string()));
        assert!(!commits
            .iter()
            .any(|commit| commit.oid == unrelated.to_string()));

        fs::remove_dir_all(repo_path).unwrap();
    }
}
