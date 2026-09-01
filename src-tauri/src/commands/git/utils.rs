use crate::path_utils::normalize_input_path;
use git2::{Repository, RepositoryState};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::{Arc, OnceLock};

use super::types::GitGraphRef;

/// Git 操作的访问类型。
///
/// 读取操作可以并行执行；会变更索引、引用、工作树或远程跟踪引用的操作必须独占。
#[derive(Clone, Copy)]
pub enum GitRepositoryAccess {
    Read,
    Write,
}

/// 以真实 Git 目录为键的仓库协调器。
///
/// 不能只用项目路径作为键：同一个仓库可能从不同的绝对路径进入，而 linked worktree
/// 也会拥有自己的实际 Git 目录。使用 `Repository::path()` 后再规范化，才能让同一
/// 个工作树的并发请求进入同一把读写锁。
#[derive(Default)]
struct GitOperationCoordinator {
    locks: Mutex<HashMap<PathBuf, Arc<RwLock<()>>>>,
}

impl GitOperationCoordinator {
    fn lock_for(&self, project_path: &str) -> Arc<RwLock<()>> {
        let lock_key = git_repository_lock_key(project_path);
        let mut locks = self.locks.lock();
        locks
            .entry(lock_key)
            .or_insert_with(|| Arc::new(RwLock::new(())))
            .clone()
    }

    fn run<T, F>(
        &self,
        project_path: &str,
        access: GitRepositoryAccess,
        task: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let lock = self.lock_for(project_path);
        match access {
            GitRepositoryAccess::Read => {
                let _guard = lock.read();
                task()
            }
            GitRepositoryAccess::Write => {
                let _guard = lock.write();
                task()
            }
        }
    }
}

static GIT_OPERATION_COORDINATOR: OnceLock<GitOperationCoordinator> = OnceLock::new();

fn git_operation_coordinator() -> &'static GitOperationCoordinator {
    GIT_OPERATION_COORDINATOR.get_or_init(GitOperationCoordinator::default)
}

/// 返回用于串行化同一工作树操作的稳定键。
///
/// 非仓库路径仍需有一个锁键，以避免初始化过程和紧随其后的探测相互打断；因此该场景
/// 回退为规范化后的项目目录，而不是将错误暴露给调用方。
fn git_repository_lock_key(project_path: &str) -> PathBuf {
    let normalized_path = normalize_input_path(project_path);
    let fallback = normalized_path
        .canonicalize()
        .unwrap_or_else(|_| normalized_path.clone());

    Repository::discover(&normalized_path)
        .ok()
        .and_then(|repo| {
            repo.path()
                .canonicalize()
                .ok()
                .or_else(|| Some(repo.path().to_path_buf()))
        })
        .unwrap_or(fallback)
}

/// 在后台线程中执行共享读取 Git 操作。
pub async fn run_git_read<T, F>(
    project_path: String,
    operation: &'static str,
    task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_git_with_access(project_path, GitRepositoryAccess::Read, operation, task).await
}

/// 在后台线程中串行执行会修改 Git 仓库的操作。
pub async fn run_git_write<T, F>(
    project_path: String,
    operation: &'static str,
    task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    run_git_with_access(project_path, GitRepositoryAccess::Write, operation, task).await
}

async fn run_git_with_access<T, F>(
    project_path: String,
    access: GitRepositoryAccess,
    operation: &'static str,
    task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        git_operation_coordinator().run(&project_path, access, task)
    })
    .await
    .map_err(|error| format!("{}后台任务失败: {}", operation, error))?
}

/// 对同步 Tauri 命令使用同一套仓库协调机制。
pub fn with_git_repository_access<T, F>(
    project_path: &str,
    access: GitRepositoryAccess,
    task: F,
) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    git_operation_coordinator().run(project_path, access, task)
}

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

/// 将用户传入的 Git 相对路径约束到仓库工作树内。
///
/// Git 命令可以自行处理多数非法 pathspec，但涉及直接文件读取时必须在
/// Rust 侧先完成边界校验，避免 `../`、绝对路径和符号链接逃逸工作树。
pub fn resolve_worktree_file_path(repo: &Repository, file_path: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(file_path);
    if relative_path.as_os_str().is_empty()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("拒绝访问工作树之外的路径: {}", file_path));
    }

    let worktree_root = repo
        .workdir()
        .ok_or_else(|| "当前 Git 仓库没有可访问的工作树".to_string())?
        .canonicalize()
        .map_err(|error| format!("解析 Git 工作树失败: {}", error))?;
    let candidate_path = worktree_root.join(relative_path);

    // 只有真实存在的文件才会被随后读取；这里额外解析符号链接，防止链接指向
    // 工作树外的任意文件。
    if candidate_path.exists() {
        let canonical_path = candidate_path
            .canonicalize()
            .map_err(|error| format!("解析工作树路径 {} 失败: {}", file_path, error))?;
        if !canonical_path.starts_with(&worktree_root) {
            return Err(format!("拒绝访问工作树之外的路径: {}", file_path));
        }
    }

    Ok(candidate_path)
}

/// 将 libgit2 的仓库状态转换成前端稳定使用的字符串值。
pub fn repository_operation_state(repo: &Repository) -> &'static str {
    match repo.state() {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert => "revert",
        RepositoryState::RevertSequence => "revert-sequence",
        RepositoryState::CherryPick => "cherry-pick",
        RepositoryState::CherryPickSequence => "cherry-pick-sequence",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase => "rebase",
        RepositoryState::RebaseInteractive => "rebase-interactive",
        RepositoryState::RebaseMerge => "rebase-merge",
        RepositoryState::ApplyMailbox => "apply-mailbox",
        RepositoryState::ApplyMailboxOrRebase => "apply-mailbox-or-rebase",
    }
}

/// 普通提交只能发生在干净的 Git 操作状态，且索引中没有未合并条目。
pub fn ensure_repository_allows_normal_commit(repo: &Repository) -> Result<(), String> {
    let operation_state = repository_operation_state(repo);
    if operation_state != "clean" {
        return Err(format!(
            "当前 Git 操作（{}）尚未完成；请先在冲突面板完成、继续或中止该操作",
            operation_state
        ));
    }

    let index = repo
        .index()
        .map_err(|error| format!("读取 Git 索引失败: {}", error))?;
    if index.has_conflicts() {
        return Err("索引中仍有未解决冲突；请先解决冲突后再提交".to_string());
    }

    Ok(())
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
    use super::{
        ensure_repository_allows_normal_commit, git_repository_lock_key, is_symbolic_remote_head,
        repository_operation_state, resolve_worktree_file_path, trash_worktree_path,
        GitOperationCoordinator, GitRepositoryAccess,
    };
    use git2::{Repository, RepositoryState};
    use std::fs;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };
    use std::thread;
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

    #[test]
    fn worktree_path_resolver_rejects_escape_paths() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let root = temp_dir.path().join("project");
        let outside = temp_dir.path().join("outside.txt");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/inside.txt"), "inside").unwrap();
        fs::write(&outside, "outside").unwrap();
        let repo = Repository::init(&root).unwrap();

        assert_eq!(
            resolve_worktree_file_path(&repo, "nested/inside.txt")
                .unwrap()
                .canonicalize()
                .unwrap(),
            root.join("nested/inside.txt").canonicalize().unwrap()
        );
        assert!(resolve_worktree_file_path(&repo, "../outside.txt").is_err());
        assert!(resolve_worktree_file_path(&repo, outside.to_string_lossy().as_ref()).is_err());
    }

    #[test]
    fn non_clean_repository_state_blocks_normal_commits() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let repo = Repository::init(temp_dir.path()).unwrap();
        fs::write(
            repo.path().join("MERGE_HEAD"),
            "0000000000000000000000000000000000000000\n",
        )
        .unwrap();

        assert_eq!(repository_operation_state(&repo), "merge");
        assert_eq!(repo.state(), RepositoryState::Merge);
        assert!(ensure_repository_allows_normal_commit(&repo).is_err());
    }

    #[test]
    fn uses_the_real_git_directory_as_the_lock_key() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let root = temp_dir.path().join("project");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let repo = Repository::init(&root).unwrap();

        assert_eq!(
            git_repository_lock_key(root.to_string_lossy().as_ref()),
            repo.path().canonicalize().unwrap()
        );
        assert_eq!(
            git_repository_lock_key(nested.to_string_lossy().as_ref()),
            repo.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn serializes_concurrent_writes_for_one_repository() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let root = temp_dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        Repository::init(&root).unwrap();

        let coordinator = Arc::new(GitOperationCoordinator::default());
        let barrier = Arc::new(Barrier::new(3));
        let active_writers = Arc::new(AtomicUsize::new(0));
        let peak_writers = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();

        for _ in 0..2 {
            let coordinator = coordinator.clone();
            let barrier = barrier.clone();
            let active_writers = active_writers.clone();
            let peak_writers = peak_writers.clone();
            let project_path = root.to_string_lossy().into_owned();
            handles.push(thread::spawn(move || {
                barrier.wait();
                coordinator
                    .run(&project_path, GitRepositoryAccess::Write, || {
                        let current = active_writers.fetch_add(1, Ordering::SeqCst) + 1;
                        peak_writers.fetch_max(current, Ordering::SeqCst);
                        thread::sleep(std::time::Duration::from_millis(40));
                        active_writers.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
            }));
        }

        barrier.wait();
        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(peak_writers.load(Ordering::SeqCst), 1);
    }
}
