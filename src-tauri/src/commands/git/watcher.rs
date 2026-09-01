use log::{debug, error};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use super::utils::git_command;

/// Git 文件变化事件名称
pub const GIT_FILE_CHANGE_EVENT: &str = "git:file-change";

/// 需要忽略的 Git 临时文件模式。
const IGNORED_PATHS: &[&str] = &["/index.lock", "/watchman-cookie-"];

/// 一个实际交给 notify 的监听目标。
///
/// 同一物理路径的递归和非递归监听语义不同，必须把模式也作为引用计数键的一部分。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct WatchTarget {
    path: PathBuf,
    recursive: bool,
}

impl WatchTarget {
    fn recursive(path: PathBuf) -> Self {
        Self {
            path,
            recursive: true,
        }
    }

    fn non_recursive(path: PathBuf) -> Self {
        Self {
            path,
            recursive: false,
        }
    }

    fn recursive_mode(&self) -> RecursiveMode {
        if self.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        }
    }
}

struct WatchSubscription {
    project_path: PathBuf,
    targets: Vec<WatchTarget>,
    ref_count: usize,
}

/// Git 文件系统监听器。
///
/// 订阅以规范化后的工作树路径计数。这样多个窗口同时打开同一项目时，某一个窗口关闭
/// 不会错误地取消其他窗口仍在使用的监听。linked worktree 的 HEAD、index 和公共 refs
/// 位于工作树之外，因此还会通过 `git rev-parse --git-path` 监听真实元数据目录。
pub struct GitWatcher {
    inner: Arc<Mutex<GitWatcherInner>>,
    app_handle: AppHandle,
}

struct GitWatcherInner {
    watcher: Option<RecommendedWatcher>,
    subscriptions: HashMap<PathBuf, WatchSubscription>,
    target_ref_counts: HashMap<WatchTarget, usize>,
}

impl GitWatcher {
    /// 创建新的 Git 文件系统监听器
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(GitWatcherInner {
                watcher: None,
                subscriptions: HashMap::new(),
                target_ref_counts: HashMap::new(),
            })),
            app_handle,
        }
    }

    /// 开始监听指定项目路径。
    pub fn watch(&self, project_path: &Path) -> Result<(), String> {
        let project_path = canonical_project_path(project_path)?;
        let targets = resolve_watch_targets(&project_path);
        let mut inner = self.inner.lock();

        if let Some(subscription) = inner.subscriptions.get_mut(&project_path) {
            subscription.ref_count += 1;
            debug!(
                "[GitWatcher] Reused subscription: {:?}, refs={}",
                project_path, subscription.ref_count
            );
            return Ok(());
        }

        if inner.watcher.is_none() {
            inner.watcher = Some(self.create_watcher()?);
        }

        let mut acquired_targets = Vec::new();
        for target in &targets {
            if let Err(error) = acquire_target(&mut inner, target) {
                for acquired_target in acquired_targets.into_iter().rev() {
                    release_target(&mut inner, &acquired_target);
                }
                return Err(error);
            }
            acquired_targets.push(target.clone());
        }

        inner.subscriptions.insert(
            project_path.clone(),
            WatchSubscription {
                project_path: project_path.clone(),
                targets,
                ref_count: 1,
            },
        );
        debug!("[GitWatcher] Started watching: {:?}", project_path);
        Ok(())
    }

    /// 停止监听指定项目路径；仅在最后一个窗口退出后才释放底层 notify 监听。
    pub fn unwatch(&self, project_path: &Path) {
        let Ok(project_path) = canonical_project_path(project_path) else {
            return;
        };
        let mut inner = self.inner.lock();

        let Some(subscription) = inner.subscriptions.get_mut(&project_path) else {
            return;
        };
        if subscription.ref_count > 1 {
            subscription.ref_count -= 1;
            debug!(
                "[GitWatcher] Retained subscription: {:?}, refs={}",
                project_path, subscription.ref_count
            );
            return;
        }

        let targets = inner
            .subscriptions
            .remove(&project_path)
            .map(|subscription| subscription.targets)
            .unwrap_or_default();
        for target in targets {
            release_target(&mut inner, &target);
        }
        debug!("[GitWatcher] Stopped watching: {:?}", project_path);
    }

    /// 停止所有监听
    pub fn unwatch_all(&self) {
        let mut inner = self.inner.lock();
        let targets: Vec<WatchTarget> = inner.target_ref_counts.keys().cloned().collect();

        if let Some(watcher) = inner.watcher.as_mut() {
            for target in &targets {
                let _ = watcher.unwatch(&target.path);
            }
        }

        inner.subscriptions.clear();
        inner.target_ref_counts.clear();
        debug!("[GitWatcher] Stopped watching all paths");
    }

    /// 创建文件系统监听器
    fn create_watcher(&self) -> Result<RecommendedWatcher, String> {
        let app_handle = self.app_handle.clone();
        let inner = self.inner.clone();

        RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| match result {
                Ok(event) => {
                    if should_ignore_event(&event) {
                        return;
                    }

                    let affected_projects: Vec<PathBuf> = inner
                        .lock()
                        .subscriptions
                        .values()
                        .filter(|subscription| subscription_matches_event(subscription, &event))
                        .map(|subscription| subscription.project_path.clone())
                        .collect();

                    for project_path in affected_projects {
                        if let Err(error) = app_handle.emit(
                            GIT_FILE_CHANGE_EVENT,
                            serde_json::json!({
                                "projectPath": project_path.to_string_lossy(),
                                "kind": format!("{:?}", event.kind),
                            }),
                        ) {
                            error!("[GitWatcher] Failed to emit event: {}", error);
                        }
                    }
                }
                Err(error) => {
                    error!("[GitWatcher] Watch error: {}", error);
                }
            },
            Config::default()
                .with_poll_interval(Duration::from_secs(2))
                .with_compare_contents(false),
        )
        .map_err(|error| format!("Failed to create watcher: {}", error))
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        self.unwatch_all();
    }
}

fn canonical_project_path(project_path: &Path) -> Result<PathBuf, String> {
    project_path
        .canonicalize()
        .map_err(|error| format!("解析 Git 监听项目路径失败: {}", error))
}

fn acquire_target(inner: &mut GitWatcherInner, target: &WatchTarget) -> Result<(), String> {
    if let Some(ref_count) = inner.target_ref_counts.get_mut(target) {
        *ref_count += 1;
        return Ok(());
    }

    let watcher = inner
        .watcher
        .as_mut()
        .ok_or_else(|| "Git 文件监听器未初始化".to_string())?;
    watcher
        .watch(&target.path, target.recursive_mode())
        .map_err(|error| format!("监听路径 {} 失败: {}", target.path.display(), error))?;
    inner.target_ref_counts.insert(target.clone(), 1);
    Ok(())
}

fn release_target(inner: &mut GitWatcherInner, target: &WatchTarget) {
    let Some(ref_count) = inner.target_ref_counts.get_mut(target) else {
        return;
    };
    if *ref_count > 1 {
        *ref_count -= 1;
        return;
    }

    inner.target_ref_counts.remove(target);
    if let Some(watcher) = inner.watcher.as_mut() {
        let _ = watcher.unwatch(&target.path);
    }
}

/// 解析一个工作树实际需要监听的路径。
///
/// 普通仓库仅监听工作树即可；linked worktree 的 `.git` 是指向外部 gitdir 的文件，故
/// 额外查询 HEAD、index、refs 和 common-dir。命令失败时回退为工作树监听，使非仓库
/// 项目也可以在之后执行 git init 而无需重新加载页面。
fn resolve_watch_targets(project_path: &Path) -> Vec<WatchTarget> {
    let mut targets = vec![WatchTarget::recursive(project_path.to_path_buf())];

    for (git_path, recursive) in [
        ("HEAD", false),
        ("index", false),
        ("refs", true),
        ("packed-refs", false),
    ] {
        let Some(path) = resolve_git_path(project_path, git_path) else {
            continue;
        };
        let target_path = if recursive {
            path
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        };
        push_metadata_target(&mut targets, project_path, target_path, recursive);
    }

    if let Some(common_dir) = resolve_git_common_dir(project_path) {
        push_metadata_target(&mut targets, project_path, common_dir, false);
    }

    targets.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.recursive.cmp(&right.recursive))
    });
    targets.dedup();
    targets
}

fn push_metadata_target(
    targets: &mut Vec<WatchTarget>,
    worktree_path: &Path,
    target_path: PathBuf,
    recursive: bool,
) {
    let target_path = target_path.canonicalize().unwrap_or(target_path);
    if target_path.starts_with(worktree_path) {
        return;
    }
    targets.push(if recursive {
        WatchTarget::recursive(target_path)
    } else {
        WatchTarget::non_recursive(target_path)
    });
}

fn resolve_git_path(project_path: &Path, git_path: &str) -> Option<PathBuf> {
    resolve_git_path_command(project_path, ["--git-path", git_path].as_slice())
}

fn resolve_git_common_dir(project_path: &Path) -> Option<PathBuf> {
    resolve_git_path_command(project_path, ["--git-common-dir"].as_slice())
}

fn resolve_git_path_command(project_path: &Path, args: &[&str]) -> Option<PathBuf> {
    let output = git_command()
        .arg("rev-parse")
        .arg("--path-format=absolute")
        .args(args)
        .current_dir(project_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let raw_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw_path.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw_path);
    Some(path.canonicalize().unwrap_or(path))
}

/// 判断是否应该忽略这个事件。
fn should_ignore_event(event: &Event) -> bool {
    match event.kind {
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {}
        _ => return true,
    }

    event.paths.iter().all(|path| {
        let path = path.to_string_lossy().replace('\\', "/").to_lowercase();
        IGNORED_PATHS.iter().any(|ignored| path.contains(ignored))
            || path.contains("/.git/objects/")
            || path.contains("/.git/hooks/")
    })
}

fn subscription_matches_event(subscription: &WatchSubscription, event: &Event) -> bool {
    event.paths.iter().any(|event_path| {
        subscription
            .targets
            .iter()
            .any(|target| path_intersects(&target.path, event_path))
    })
}

fn path_intersects(left: &Path, right: &Path) -> bool {
    let left = comparable_path(left);
    let right = comparable_path(right);
    right.starts_with(&left) || left.starts_with(&right)
}

fn comparable_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_path_buf()
    }
}

/// Tauri 命令：开始监听 Git 文件变化
#[tauri::command]
pub fn git_watch_start(
    project_path: String,
    git_watcher: State<'_, Arc<GitWatcher>>,
) -> Result<(), String> {
    git_watcher.watch(Path::new(&project_path))
}

/// Tauri 命令：停止监听 Git 文件变化
#[tauri::command]
pub fn git_watch_stop(project_path: String, git_watcher: State<'_, Arc<GitWatcher>>) {
    git_watcher.unwatch(Path::new(&project_path));
}

#[cfg(test)]
mod tests {
    use super::{path_intersects, subscription_matches_event, WatchSubscription, WatchTarget};
    use notify::{Event, EventKind};
    use std::path::PathBuf;

    #[test]
    fn metadata_event_is_routed_to_the_linked_worktree_subscription() {
        let worktree = PathBuf::from("C:/repo/worktree");
        let metadata = PathBuf::from("C:/repo/.git/worktrees/worktree");
        let subscription = WatchSubscription {
            project_path: worktree.clone(),
            targets: vec![
                WatchTarget::recursive(worktree),
                WatchTarget::non_recursive(metadata.clone()),
            ],
            ref_count: 1,
        };
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![metadata.join("HEAD")],
            attrs: Default::default(),
        };

        assert!(subscription_matches_event(&subscription, &event));
    }

    #[test]
    fn path_intersection_handles_file_and_directory_events() {
        let refs = PathBuf::from("C:/repo/.git/refs");
        assert!(path_intersects(&refs, &refs.join("remotes/origin/main")));
        assert!(path_intersects(&refs.join("heads/main"), &refs));
        assert!(!path_intersects(
            &refs,
            &PathBuf::from("C:/another-repo/.git/refs/heads/main")
        ));
    }
}
