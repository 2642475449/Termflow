use git2::{ErrorCode, Repository};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use super::types::{GitBranchInfo, GitFileStatus, GitRepoInfo};
use super::utils::{
    collect_numstat, git_command, open_repo, repository_operation_state, run_git_read,
    run_git_write,
};

#[tauri::command]
pub async fn git_init_repository(project_path: String) -> Result<(), String> {
    let lock_path = project_path.clone();
    run_git_write(lock_path, "初始化 Git 仓库", move || {
        let path = Path::new(&project_path);
        if !path.is_dir() {
            return Err("Project directory does not exist".to_string());
        }

        Repository::init(path)
            .map(|_| ())
            .map_err(|error| format!("Failed to initialize Git repository: {error}"))
    })
    .await
}

/// Porcelain v1 uses NUL-delimited paths; rename records contain destination first.
/// Parse bytes before decoding paths so spaces, tabs and newlines stay intact.
fn parse_status_output(output: &[u8]) -> Result<Vec<GitFileStatus>, String> {
    let mut records = output.split(|byte| *byte == 0);
    let mut result = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("Invalid git status record".to_string());
        }
        let x = record[0];
        let y = record[1];
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let old_path = if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            let old = records
                .next()
                .filter(|old| !old.is_empty())
                .ok_or_else(|| "Missing source path in git status rename".to_string())?;
            Some(String::from_utf8_lossy(old).into_owned())
        } else {
            None
        };
        let conflict = matches!(
            (x, y),
            (b'D', b'D')
                | (b'A', b'U')
                | (b'U', b'D')
                | (b'U', b'A')
                | (b'D', b'U')
                | (b'A', b'A')
                | (b'U', b'U')
        );
        if conflict || (x == b'?' && y == b'?') {
            result.push(GitFileStatus {
                path,
                old_path: None,
                status_type: if conflict { "conflicted" } else { "untracked" }.to_string(),
                staged: false,
                insertions: None,
                deletions: None,
            });
            continue;
        }
        for (code, staged) in [(x, true), (y, false)] {
            let status_type = match code {
                b' ' | b'!' => continue,
                b'A' => "added",
                b'M' => "modified",
                b'D' => "deleted",
                b'R' => "renamed",
                b'C' => "added",
                b'T' => "typechange",
                _ => return Err(format!("Unsupported git status code: {}", code as char)),
            };
            result.push(GitFileStatus {
                path: path.clone(),
                old_path: if matches!(code, b'R' | b'C') {
                    old_path.clone()
                } else {
                    None
                },
                status_type: status_type.to_string(),
                staged,
                insertions: None,
                deletions: None,
            });
        }
    }
    Ok(result)
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
    status: &str,
    relative_path: &str,
    collision_keys: &HashSet<String>,
    worktree_root: &Path,
) -> bool {
    cfg!(target_os = "windows")
        && status == "deleted"
        && collision_keys.contains(&relative_path.replace('\\', "/").to_lowercase())
        && worktree_root.join(relative_path).exists()
}

/// Resolve branch info from repository.
pub fn resolve_branch_info(repo: &Repository) -> Result<GitBranchInfo, String> {
    let head = match repo.head() {
        Ok(head) => head,
        // 新初始化仓库还没有首个提交。它仍是有效 Git 仓库，不能把它误判为非仓库。
        Err(error) if error.code() == ErrorCode::UnbornBranch => {
            let branch_name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|head| head.shorthand().map(ToOwned::to_owned))
                .unwrap_or_else(|| "HEAD".to_string());
            return Ok(GitBranchInfo {
                branch_name,
                ahead: 0,
                behind: 0,
                is_detached: false,
                operation_state: repository_operation_state(repo).to_string(),
            });
        }
        Err(error) => return Err(format!("获取 HEAD 失败: {}", error)),
    };

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
        operation_state: repository_operation_state(repo).to_string(),
    })
}

/// Get repository info.
#[tauri::command]
pub async fn git_repo_info(project_path: String) -> Result<GitRepoInfo, String> {
    let lock_path = project_path.clone();
    run_git_read(lock_path, "读取 Git 仓库信息", move || {
        git_repo_info_sync(project_path)
    })
    .await
}

fn git_repo_info_sync(project_path: String) -> Result<GitRepoInfo, String> {
    let path = crate::path_utils::normalize_input_path(&project_path);
    match Repository::open(&path) {
        Ok(repo) => {
            let branch_info = Some(resolve_branch_info(&repo)?);
            Ok(GitRepoInfo {
                is_repo: true,
                branch_info,
            })
        }
        Err(error) if error.code() == ErrorCode::NotFound && !path.join(".git").exists() => {
            Ok(GitRepoInfo {
                is_repo: false,
                branch_info: None,
            })
        }
        Err(error) => Err(format!("读取 Git 仓库失败: {}", error)),
    }
}

/// Get file statuses.
#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let lock_path = project_path.clone();
    run_git_read(lock_path, "读取 Git 状态", move || {
        git_status_sync(project_path)
    })
    .await
}

fn git_status_sync(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&project_path)?;
    let worktree_root = crate::path_utils::normalize_input_path(&project_path);
    let staged_numstat = collect_numstat(&project_path, true)?;
    let unstaged_numstat = collect_numstat(&project_path, false)?;
    let case_collision_keys = case_insensitive_index_collisions(&repo)?;

    let output = git_command()
        .args(["status", "--porcelain=v1", "-z", "-uall", "--renames"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(&worktree_root)
        .output()
        .map_err(|error| format!("Failed to execute git status: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut result = parse_status_output(&output.stdout)?;
    // Keep the existing Windows workaround for repositories containing paths
    // that differ only in case and cannot coexist on the local filesystem.
    result.retain(|entry| {
        entry.staged
            || !is_case_insensitive_phantom_deletion(
                &entry.status_type,
                &entry.path,
                &case_collision_keys,
                &worktree_root,
            )
    });
    for entry in &mut result {
        let (insertions, deletions) = if entry.status_type == "untracked" {
            count_untracked_lines(&worktree_root, &entry.path)
        } else {
            let stats = if entry.staged {
                &staged_numstat
            } else {
                &unstaged_numstat
            };
            stats.get(&entry.path).copied().unwrap_or((None, None))
        };
        entry.insertions = insertions;
        entry.deletions = deletions;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        collect_case_insensitive_index_collisions, count_untracked_lines, git_status_sync,
        is_case_insensitive_phantom_deletion, parse_status_output, resolve_branch_info,
    };
    use git2::{Repository, Signature};
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
    fn distinguishes_a_plain_directory_from_a_broken_git_directory() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().to_str().unwrap().to_string();
        assert!(!super::git_repo_info_sync(path.clone()).unwrap().is_repo);
        fs::write(temp.path().join(".git"), "gitdir: missing-directory").unwrap();
        assert!(super::git_repo_info_sync(path).is_err());
    }

    #[test]
    fn parses_both_sides_and_special_paths() {
        let entries =
            parse_status_output(b"AM folder/space \t\n.txt\0?? new.txt\0T  type.txt\0").unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].path, "folder/space \t\n.txt");
        assert_eq!(entries[0].status_type, "added");
        assert!(entries[0].staged);
        assert_eq!(entries[1].status_type, "modified");
        assert!(!entries[1].staged);
        assert_eq!(entries[2].status_type, "untracked");
        assert_eq!(entries[3].status_type, "typechange");
    }

    #[test]
    fn parses_all_unmerged_pairs_as_one_conflict() {
        for pair in ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] {
            let entries = parse_status_output(format!("{pair} conflict.txt\0").as_bytes()).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].status_type, "conflicted");
            assert!(!entries[0].staged);
        }
    }

    #[test]
    fn parses_rename_destination_before_source() {
        let entries = parse_status_output(b"RM new name.txt\0old name.txt\0").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "new name.txt");
        assert_eq!(entries[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(entries[0].status_type, "renamed");
        assert!(entries[1].old_path.is_none());
        assert!(parse_status_output(b"R  dest\0").is_err());
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
            "deleted",
            lower_path,
            &collisions,
            &root,
        ));
        assert!(!is_case_insensitive_phantom_deletion(
            "modified",
            lower_path,
            &collisions,
            &root,
        ));

        fs::remove_file(root.join(upper_path)).unwrap();
        assert!(!is_case_insensitive_phantom_deletion(
            "deleted",
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

        let output = super::git_command()
            .args(["add", "--all"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(output.status.success());
        let statuses = git_status_sync(root.to_string_lossy().into_owned()).unwrap();
        let renamed = statuses
            .iter()
            .find(|entry| entry.status_type == "renamed")
            .unwrap();
        assert_eq!(renamed.path, "after.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("before.txt"));
        assert!(renamed.staged);

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

    #[test]
    fn cli_status_preserves_partial_staging_and_special_path_numstat() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        let name = "中文 file.txt";
        commit_file(&repo, temp.path(), name);
        let run = |args: &[&str]| {
            let output = super::git_command()
                .args(args)
                .current_dir(temp.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        fs::write(temp.path().join(name), "staged content\n").unwrap();
        run(&["add", "--", name]);
        fs::write(temp.path().join(name), "working content\nsecond line\n").unwrap();
        fs::write(temp.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(temp.path().join("ignored.txt"), "ignored\n").unwrap();
        let entries = git_status_sync(temp.path().to_string_lossy().into_owned()).unwrap();
        let entries: Vec<_> = entries.iter().filter(|entry| entry.path == name).collect();
        assert_eq!(entries.len(), 2);
        let staged = entries.iter().find(|entry| entry.staged).unwrap();
        assert_eq!((staged.insertions, staged.deletions), (Some(1), Some(1)));
        let unstaged = entries.iter().find(|entry| !entry.staged).unwrap();
        assert_eq!(
            (unstaged.insertions, unstaged.deletions),
            (Some(2), Some(1))
        );
        let all = git_status_sync(temp.path().to_string_lossy().into_owned()).unwrap();
        assert!(!all.iter().any(|entry| entry.path == "ignored.txt"));
    }

    #[test]
    fn cli_status_respects_lf_attributes_after_crlf_checkout() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        repo.config()
            .unwrap()
            .set_bool("core.autocrlf", true)
            .unwrap();
        commit_file(&repo, temp.path(), "config.toml");
        // Record a CRLF worktree in the index stat cache, then restore LF bytes
        // and add an LF rule without touching the index, as code generators do.
        fs::write(temp.path().join("config.toml"), "same content\r\n").unwrap();
        let output = super::git_command()
            .args(["add", "--", "config.toml"])
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(temp.path().join("config.toml"), "same content\n").unwrap();
        fs::write(
            temp.path().join(".gitattributes"),
            "config.toml text eol=lf\n",
        )
        .unwrap();
        let before = fs::read(repo.path().join("index")).unwrap();
        let entries = git_status_sync(temp.path().to_string_lossy().into_owned()).unwrap();
        let output = super::git_command()
            .args(["status", "--porcelain=v1", "-z", "-uall", "--renames"])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let expected = parse_status_output(&output.stdout).unwrap();
        let summary = |entries: &[super::GitFileStatus]| {
            entries
                .iter()
                .map(|entry| (entry.path.clone(), entry.status_type.clone(), entry.staged))
                .collect::<Vec<_>>()
        };
        assert_eq!(summary(&entries), summary(&expected));
        assert_eq!(before, fs::read(repo.path().join("index")).unwrap());
    }

    #[test]
    fn new_repository_has_branch_info_before_the_first_commit() {
        let (root, repo) = temp_repo();

        let branch_info = resolve_branch_info(&repo).unwrap();

        assert_eq!(branch_info.ahead, 0);
        assert_eq!(branch_info.behind, 0);
        assert!(!branch_info.is_detached);
        assert_eq!(branch_info.operation_state, "clean");

        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
}

/// Get branch info.
#[tauri::command]
pub async fn git_branch_info(project_path: String) -> Result<GitBranchInfo, String> {
    let lock_path = project_path.clone();
    run_git_read(lock_path, "读取 Git 分支信息", move || {
        git_branch_info_sync(project_path)
    })
    .await
}

fn git_branch_info_sync(project_path: String) -> Result<GitBranchInfo, String> {
    let repo = open_repo(&project_path)?;
    resolve_branch_info(&repo)
}
