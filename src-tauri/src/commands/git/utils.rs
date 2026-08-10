use crate::path_utils::normalize_input_path;
use git2::Repository;
use std::collections::HashMap;
use std::process::Command as StdCommand;

use super::types::GitGraphRef;

pub async fn run_git_blocking<T, F>(operation: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{}后台任务失败: {}", operation, error))?
}

/// Create a `git` CLI command with `CREATE_NO_WINDOW` on Windows to prevent console flash.
pub fn git_command() -> StdCommand {
    let mut cmd = StdCommand::new("git");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Run a git command and return stdout as string.
pub fn run_git_text_command(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .args(args)
        .current_dir(normalize_input_path(project_path))
        .output()
        .map_err(|e| format!("执行 git 命令失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "git 命令执行失败".to_string()
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_numstat_value(value: &str) -> Option<usize> {
    value.parse::<usize>().ok()
}

fn parse_numstat_output(output: &str) -> HashMap<String, (Option<usize>, Option<usize>)> {
    let mut stats = HashMap::new();

    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let Some(insertions_raw) = parts.next() else {
            continue;
        };
        let Some(deletions_raw) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };

        if path.is_empty() {
            continue;
        }

        stats.insert(
            path.to_string(),
            (
                parse_numstat_value(insertions_raw),
                parse_numstat_value(deletions_raw),
            ),
        );
    }

    stats
}

pub fn collect_numstat(
    project_path: &str,
    staged: bool,
) -> Result<HashMap<String, (Option<usize>, Option<usize>)>, String> {
    let args: &[&str] = if staged {
        &["diff", "--cached", "--root", "--numstat", "--no-renames"]
    } else {
        &["diff", "--numstat", "--no-renames"]
    };

    let output = run_git_text_command(project_path, args)?;
    Ok(parse_numstat_output(&output))
}

/// Stage files using git add.
pub fn stage_paths(project_path: &str, files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }

    let output = git_command()
        .arg("add")
        .arg("--all")
        .arg("--")
        .args(files)
        .current_dir(normalize_input_path(project_path))
        .output()
        .map_err(|e| format!("执行 git add 失败: {}", e))?;

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
        "git add 执行失败".to_string()
    })
}

/// Move an untracked worktree path to the operating system's recycle bin.
pub fn trash_worktree_path(project_path: &str, file_path: &str) -> Result<(), String> {
    let root_path = normalize_input_path(project_path)
        .canonicalize()
        .map_err(|e| format!("解析项目目录失败: {}", e))?;
    let absolute_path = root_path.join(file_path);
    if !absolute_path.exists() {
        return Ok(());
    }
    let canonical_path = absolute_path
        .canonicalize()
        .map_err(|e| format!("解析未跟踪路径 {} 失败: {}", file_path, e))?;
    if canonical_path == root_path || !canonical_path.starts_with(&root_path) {
        return Err(format!("拒绝丢弃项目目录之外的路径: {}", file_path));
    }
    trash::delete(&canonical_path).map_err(|e| format!("移动 {} 到回收站失败: {}", file_path, e))
}

/// Open a git repository.
pub fn open_repo(project_path: &str) -> Result<Repository, String> {
    let path = normalize_input_path(project_path);
    Repository::open(&path).map_err(|e| format!("打开 Git 仓库失败: {}", e))
}

/// Collect all refs (branches, tags) grouped by commit OID.
pub fn collect_commit_refs(
    repo: &Repository,
) -> Result<std::collections::HashMap<String, Vec<GitGraphRef>>, String> {
    let mut refs_by_oid: std::collections::HashMap<String, Vec<GitGraphRef>> =
        std::collections::HashMap::new();
    let references = repo
        .references()
        .map_err(|e| format!("读取 Git 引用失败: {}", e))?;

    for reference_result in references {
        let reference = reference_result.map_err(|e| format!("读取 Git 引用失败: {}", e))?;
        if reference.is_remote() && is_symbolic_remote_head(reference.shorthand()) {
            continue;
        }
        let oid = match reference
            .target()
            .or_else(|| reference.peel_to_commit().ok().map(|commit| commit.id()))
        {
            Some(value) => value,
            None => continue,
        };

        let is_head_ref = reference.name() == Some("HEAD");

        let name = if is_head_ref {
            "HEAD".to_string()
        } else {
            reference
                .shorthand()
                .or_else(|| reference.name())
                .unwrap_or("")
                .to_string()
        };
        if name.is_empty() {
            continue;
        }

        let kind = if is_head_ref {
            "head"
        } else if reference.is_branch() {
            "branch"
        } else if reference.is_remote() {
            "remote"
        } else if reference.is_tag() {
            "tag"
        } else {
            "ref"
        };

        refs_by_oid
            .entry(oid.to_string())
            .or_default()
            .push(GitGraphRef {
                name,
                kind: kind.to_string(),
            });
    }

    for refs in refs_by_oid.values_mut() {
        refs.sort_by(|a, b| {
            let rank = |kind: &str| match kind {
                "head" => 0,
                "branch" => 1,
                "remote" => 2,
                "tag" => 3,
                _ => 4,
            };
            rank(&a.kind)
                .cmp(&rank(&b.kind))
                .then_with(|| a.name.cmp(&b.name))
        });
    }

    Ok(refs_by_oid)
}

fn is_symbolic_remote_head(shorthand: Option<&str>) -> bool {
    shorthand.is_some_and(|name| name.ends_with("/HEAD"))
}

/// Decode bytes to UTF-8 text.
pub fn decode_text_content(bytes: Vec<u8>) -> Result<String, ()> {
    String::from_utf8(bytes).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{is_symbolic_remote_head, trash_worktree_path};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn symbolic_remote_head_is_not_a_graph_badge() {
        assert!(is_symbolic_remote_head(Some("origin/HEAD")));
        assert!(is_symbolic_remote_head(Some("upstream/HEAD")));
        assert!(!is_symbolic_remote_head(Some("origin/main")));
        assert!(!is_symbolic_remote_head(None));
    }

    #[test]
    fn trash_worktree_path_rejects_parent_traversal() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = std::env::temp_dir().join(format!("termflow-trash-safety-{suffix}"));
        let root = parent.join("project");
        let outside = parent.join("outside.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "keep me").unwrap();

        let result = trash_worktree_path(root.to_string_lossy().as_ref(), "../outside.txt");
        assert!(result.is_err());
        assert!(outside.exists());

        fs::remove_dir_all(parent).unwrap();
    }
}
