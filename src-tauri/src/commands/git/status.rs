use git2::{Repository, StatusOptions};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use super::types::{GitBranchInfo, GitFileStatus, GitRepoInfo};
use super::utils::{collect_numstat, open_repo, run_git_blocking};

#[tauri::command]
pub async fn git_init_repository(project_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.is_dir() {
            return Err("Project directory does not exist".to_string());
        }

        Repository::init(path)
            .map(|_| ())
            .map_err(|error| format!("Failed to initialize Git repository: {error}"))
    })
    .await
    .map_err(|error| format!("Git initialization task failed: {error}"))?
}

fn map_index_status(status: git2::Status) -> &'static str {
    if status.contains(git2::Status::INDEX_TYPECHANGE) {
        "typechange"
    } else if status.contains(git2::Status::INDEX_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::INDEX_NEW) {
        "added"
    } else if status.contains(git2::Status::INDEX_DELETED) {
        "deleted"
    } else {
        "modified"
    }
}

fn map_worktree_status(status: git2::Status) -> &'static str {
    if status.contains(git2::Status::CONFLICTED) {
        "conflicted"
    } else if status.contains(git2::Status::WT_TYPECHANGE) {
        "typechange"
    } else if status.contains(git2::Status::WT_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::WT_NEW) {
        "untracked"
    } else if status.contains(git2::Status::WT_DELETED) {
        "deleted"
    } else {
        "modified"
    }
}

fn rename_paths(delta: Option<git2::DiffDelta<'_>>, fallback: &str) -> (String, Option<String>) {
    let Some(delta) = delta else {
        return (fallback.to_string(), None);
    };
    let old_path = delta
        .old_file()
        .path()
        .map(|path| path.to_string_lossy().to_string());
    let new_path = delta
        .new_file()
        .path()
        .map(|path| path.to_string_lossy().to_string());
    let path = new_path
        .or_else(|| old_path.clone())
        .unwrap_or_else(|| fallback.to_string());
    let previous = old_path.filter(|old| old != &path);
    (path, previous)
}

fn count_untracked_lines(
    project_path: &Path,
    relative_path: &str,
) -> (Option<usize>, Option<usize>) {
    let path = project_path.join(relative_path);
    let Ok(mut file) = std::fs::File::open(path) else {
        return (None, None);
    };

    let mut buffer = [0_u8; 16 * 1024];
    let mut line_count = 0_usize;
    let mut has_bytes = false;
    let mut ends_with_newline = false;
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return (None, None);
        };
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        if chunk.contains(&0) {
            return (None, None);
        }
        has_bytes = true;
        line_count += chunk.iter().filter(|byte| **byte == b'\n').count();
        ends_with_newline = chunk.last() == Some(&b'\n');
    }

    if has_bytes && !ends_with_newline {
        line_count += 1;
    }
    (Some(line_count), Some(0))
}

fn collect_case_insensitive_index_collisions<I, S>(paths: I) -> HashSet<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut first_path_by_key = HashMap::new();
    let mut collisions = HashSet::new();

    for path in paths {
        let path = path.as_ref().replace('\\', "/");
        let key = path.to_lowercase();
        if let Some(first_path) = first_path_by_key.get(&key) {
            if first_path != &path {
                collisions.insert(key);
            }
        } else {
            first_path_by_key.insert(key, path);
        }
    }

    collisions
}

fn case_insensitive_index_collisions(repo: &Repository) -> Result<HashSet<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let index = repo
            .index()
            .map_err(|e| format!("读取 Git 索引失败: {}", e))?;
        Ok(collect_case_insensitive_index_collisions(index.iter().map(
            |entry| String::from_utf8_lossy(&entry.path).into_owned(),
        )))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = repo;
        Ok(HashSet::new())
    }
}

fn is_case_insensitive_phantom_deletion(
    status: git2::Status,
    relative_path: &str,
    collision_keys: &HashSet<String>,
    worktree_root: &Path,
) -> bool {
    cfg!(target_os = "windows")
        && status.contains(git2::Status::WT_DELETED)
        && collision_keys.contains(&relative_path.replace('\\', "/").to_lowercase())
        && worktree_root.join(relative_path).exists()
}

/// Resolve branch info from repository.
pub fn resolve_branch_info(repo: &Repository) -> Result<GitBranchInfo, String> {
    let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {}", e))?;

    let is_detached = head.is_branch();
    let branch_name = head.shorthand().unwrap_or("HEAD").to_string();

    let (ahead, behind) = if let Ok(branch) =
        repo.find_branch(head.shorthand().unwrap_or("main"), git2::BranchType::Local)
    {
        if let Ok(upstream) = branch.upstream() {
            let local_oid = head
                .target()
                .ok_or_else(|| "获取本地 OID 失败".to_string())?;
            let upstream_oid = upstream
                .get()
                .target()
                .ok_or_else(|| "获取远端 OID 失败".to_string())?;
            repo.graph_ahead_behind(local_oid, upstream_oid)
                .map_err(|e| format!("计算 ahead/behind 失败: {}", e))?
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    Ok(GitBranchInfo {
        branch_name,
        ahead,
        behind,
        is_detached: !is_detached,
    })
}

/// Get repository info.
#[tauri::command]
pub async fn git_repo_info(project_path: String) -> Result<GitRepoInfo, String> {
    run_git_blocking("读取 Git 仓库信息", move || {
        git_repo_info_sync(project_path)
    })
    .await
}

fn git_repo_info_sync(project_path: String) -> Result<GitRepoInfo, String> {
    let path = crate::path_utils::normalize_input_path(&project_path);
    match Repository::open(&path) {
        Ok(repo) => {
            let branch_info = resolve_branch_info(&repo).ok();
            Ok(GitRepoInfo {
                is_repo: true,
                branch_info,
            })
        }
        Err(_) => Ok(GitRepoInfo {
            is_repo: false,
            branch_info: None,
        }),
    }
}

/// Get file statuses.
#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    run_git_blocking("读取 Git 状态", move || git_status_sync(project_path)).await
}

fn git_status_sync(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&project_path)?;
    let worktree_root = crate::path_utils::normalize_input_path(&project_path);
    let staged_numstat = collect_numstat(&project_path, true)?;
    let unstaged_numstat = collect_numstat(&project_path, false)?;
    let case_collision_keys = case_insensitive_index_collisions(&repo)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .renames_from_rewrites(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("获取 Git 状态失败: {}", e))?;

    let mut result = Vec::new();

    for entry in statuses.iter() {
        let s = entry.status();
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };

        // Staged changes (in index)
        if s.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            let (staged_path, old_path) = rename_paths(entry.head_to_index(), &path);
            let (insertions, deletions) = staged_numstat
                .get(&staged_path)
                .cloned()
                .unwrap_or((None, None));
            result.push(GitFileStatus {
                path: staged_path,
                old_path,
                status_type: map_index_status(s).to_string(),
                staged: true,
                insertions,
                deletions,
            });
        }

        // Unstaged changes (in working tree)
        if s.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::WT_NEW
                | git2::Status::CONFLICTED,
        ) && !is_case_insensitive_phantom_deletion(
            s,
            &path,
            &case_collision_keys,
            &worktree_root,
        ) {
            let (worktree_path, old_path) = rename_paths(entry.index_to_workdir(), &path);
            let (insertions, deletions) = if s.contains(git2::Status::WT_NEW) {
                count_untracked_lines(&worktree_root, &worktree_path)
            } else {
                unstaged_numstat
                    .get(&worktree_path)
                    .cloned()
                    .unwrap_or((None, None))
            };
            result.push(GitFileStatus {
                path: worktree_path,
                old_path,
                status_type: map_worktree_status(s).to_string(),
                staged: false,
                insertions,
                deletions,
            });
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        collect_case_insensitive_index_collisions, count_untracked_lines, git_status_sync,
        is_case_insensitive_phantom_deletion, map_index_status, map_worktree_status, rename_paths,
    };
    use git2::{Repository, Signature, StatusOptions};
    use std::collections::HashSet;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo() -> (std::path::PathBuf, Repository) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termflow-git-status-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        let repo = Repository::init(&path).unwrap();
        (path, repo)
    }

    fn commit_file(repo: &Repository, root: &std::path::Path, name: &str) {
        fs::write(root.join(name), "same content\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(name)).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = Signature::now("Termflow Test", "termflow@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
    }

    #[test]
    fn maps_staged_and_worktree_status_independently() {
        let mixed = git2::Status::INDEX_NEW | git2::Status::WT_MODIFIED;
        assert_eq!(map_index_status(mixed), "added");
        assert_eq!(map_worktree_status(mixed), "modified");
    }

    #[test]
    fn rename_takes_precedence_within_each_side() {
        assert_eq!(map_index_status(git2::Status::INDEX_RENAMED), "renamed");
        assert_eq!(map_worktree_status(git2::Status::WT_RENAMED), "renamed");
    }

    #[test]
    fn detects_only_distinct_index_paths_that_differ_by_case() {
        let collisions = collect_case_insensitive_index_collisions([
            "src/AcademicPostAction.java",
            "src/academicPostAction.java",
            "src/Other.java",
            "src/Other.java",
        ]);

        assert_eq!(
            collisions,
            HashSet::from(["src/academicpostaction.java".to_string()])
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn hides_case_collision_deletion_only_while_the_physical_file_exists() {
        let (root, repo) = temp_repo();
        let upper_path = "src/AcademicPostAction.java";
        let lower_path = "src/academicPostAction.java";
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(upper_path), "same content\n").unwrap();
        let collisions = collect_case_insensitive_index_collisions([upper_path, lower_path]);

        assert!(is_case_insensitive_phantom_deletion(
            git2::Status::WT_DELETED,
            lower_path,
            &collisions,
            &root,
        ));
        assert!(!is_case_insensitive_phantom_deletion(
            git2::Status::WT_MODIFIED,
            lower_path,
            &collisions,
            &root,
        ));

        fs::remove_file(root.join(upper_path)).unwrap();
        assert!(!is_case_insensitive_phantom_deletion(
            git2::Status::WT_DELETED,
            lower_path,
            &collisions,
            &root,
        ));

        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_detection_preserves_old_and_new_paths() {
        let (root, repo) = temp_repo();
        commit_file(&repo, &root, "before.txt");
        fs::rename(root.join("before.txt"), root.join("after.txt")).unwrap();

        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .renames_index_to_workdir(true);
        let statuses = repo.statuses(Some(&mut options)).unwrap();
        let entry = statuses.iter().next().unwrap();
        assert!(entry.status().contains(git2::Status::WT_RENAMED));
        let (path, old_path) = rename_paths(entry.index_to_workdir(), entry.path().unwrap());
        assert_eq!(path, "after.txt");
        assert_eq!(old_path.as_deref(), Some("before.txt"));

        drop(statuses);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn counts_untracked_text_lines_with_or_without_trailing_newline() {
        let (root, repo) = temp_repo();
        fs::write(root.join("without-newline.txt"), "first\nsecond").unwrap();
        fs::write(root.join("with-newline.txt"), "first\nsecond\n").unwrap();

        assert_eq!(
            count_untracked_lines(&root, "without-newline.txt"),
            (Some(2), Some(0))
        );
        assert_eq!(
            count_untracked_lines(&root, "with-newline.txt"),
            (Some(2), Some(0))
        );

        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn does_not_report_binary_untracked_files_as_lines() {
        let (root, repo) = temp_repo();
        fs::write(root.join("binary.dat"), [1_u8, 0, 2, b'\n']).unwrap();

        assert_eq!(count_untracked_lines(&root, "binary.dat"), (None, None));

        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_status_includes_line_count_for_untracked_text_file() {
        let (root, repo) = temp_repo();
        commit_file(&repo, &root, "tracked.txt");
        fs::write(root.join("untracked.md"), "alpha\nbeta\ngamma\n").unwrap();

        let statuses = git_status_sync(root.to_string_lossy().into_owned()).unwrap();
        let untracked = statuses
            .iter()
            .find(|status| status.path == "untracked.md")
            .unwrap();
        assert_eq!(untracked.status_type, "untracked");
        assert_eq!(untracked.insertions, Some(3));
        assert_eq!(untracked.deletions, Some(0));

        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
}

/// Get branch info.
#[tauri::command]
pub async fn git_branch_info(project_path: String) -> Result<GitBranchInfo, String> {
    run_git_blocking("读取 Git 分支信息", move || {
        git_branch_info_sync(project_path)
    })
    .await
}

fn git_branch_info_sync(project_path: String) -> Result<GitBranchInfo, String> {
    let repo = open_repo(&project_path)?;
    resolve_branch_info(&repo)
}
