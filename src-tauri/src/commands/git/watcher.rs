use log::{debug, error};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Git 文件变化事件名称
pub const GIT_FILE_CHANGE_EVENT: &str = "git:file-change";

/// 需要忽略的路径模式
const IGNORED_PATHS: &[&str] = &[".git/index.lock", ".git/watchman-cookie-"];

/// Git 文件系统监听器
///
/// 监听工作目录和 .git 目录的文件变化，
/// 通过 Tauri 事件系统通知前端刷新。
pub struct GitWatcher {
    inner: Mutex<GitWatcherInner>,
    app_handle: AppHandle,
}

struct GitWatcherInner {
    watcher: Option<RecommendedWatcher>,
    watched_paths: HashSet<PathBuf>,
}

impl GitWatcher {
    /// 创建新的 Git 文件系统监听器
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            inner: Mutex::new(GitWatcherInner {
                watcher: None,
                watched_paths: HashSet::new(),
            }),
            app_handle,
        }
    }

    /// 开始监听指定项目路径
    pub fn watch(&self, project_path: &Path) -> Result<(), String> {
        let mut inner = self.inner.lock();

        // 如果已经在监听这个路径，跳过
        if inner.watched_paths.contains(project_path) {
            debug!("[GitWatcher] Already watching: {:?}", project_path);
            return Ok(());
        }

        // 如果没有 watcher，创建一个新的
        if inner.watcher.is_none() {
            let watcher = self.create_watcher()?;
            inner.watcher = Some(watcher);
        }

        if let Some(ref mut watcher) = inner.watcher {
            // Watch the complete worktree so changes below src/, docs/, etc. refresh Git state.
            if let Err(e) = watcher.watch(project_path, RecursiveMode::Recursive) {
                error!("[GitWatcher] Failed to watch project path: {}", e);
                return Err(format!("Failed to watch project path: {}", e));
            }

            inner.watched_paths.insert(project_path.to_path_buf());
            debug!("[GitWatcher] Started watching: {:?}", project_path);
        }

        Ok(())
    }

    /// 停止监听指定项目路径
    pub fn unwatch(&self, project_path: &Path) {
        let mut inner = self.inner.lock();

        if !inner.watched_paths.contains(project_path) {
            return;
        }

        if let Some(ref mut watcher) = inner.watcher {
            let _ = watcher.unwatch(project_path);
        }

        inner.watched_paths.remove(project_path);
        debug!("[GitWatcher] Stopped watching: {:?}", project_path);
    }

    /// 停止所有监听
    pub fn unwatch_all(&self) {
        let mut inner = self.inner.lock();

        // 先收集所有路径，避免借用冲突
        let paths: Vec<PathBuf> = inner.watched_paths.iter().cloned().collect();

        if let Some(ref mut watcher) = inner.watcher {
            for path in &paths {
                let _ = watcher.unwatch(path);
            }
        }

        inner.watched_paths.clear();
        debug!("[GitWatcher] Stopped watching all paths");
    }

    /// 创建文件系统监听器
    fn create_watcher(&self) -> Result<RecommendedWatcher, String> {
        let app_handle = self.app_handle.clone();

        let watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                match result {
                    Ok(event) => {
                        // 过滤不需要的事件
                        if should_ignore_event(&event) {
                            return;
                        }

                        // 从事件中提取项目路径
                        if let Some(project_path) = extract_project_path(&event) {
                            // 发送事件到前端
                            if let Err(e) = app_handle.emit(
                                GIT_FILE_CHANGE_EVENT,
                                serde_json::json!({
                                    "projectPath": project_path.to_string_lossy(),
                                    "kind": format!("{:?}", event.kind),
                                }),
                            ) {
                                error!("[GitWatcher] Failed to emit event: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        error!("[GitWatcher] Watch error: {}", e);
                    }
                }
            },
            Config::default()
                .with_poll_interval(Duration::from_secs(2))
                .with_compare_contents(false),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        Ok(watcher)
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        self.unwatch_all();
    }
}

/// 判断是否应该忽略这个事件
fn should_ignore_event(event: &Event) -> bool {
    // 只关注修改、创建、删除事件
    match event.kind {
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {}
        _ => return true,
    }

    // 检查路径是否应该被忽略
    for path in &event.paths {
        let path_str = path.to_string_lossy().replace('\\', "/");
        for ignored in IGNORED_PATHS {
            if path_str.contains(ignored) {
                return true;
            }
        }

        // 忽略 .git 目录内的大部分文件变化
        // 只关注 HEAD、refs/ 目录的变化
        if path_str.contains("/.git/") {
            let relative = path
                .strip_prefix(
                    path.ancestors()
                        .find(|p| p.join(".git").exists())
                        .unwrap_or(path),
                )
                .unwrap_or(path);

            let relative_str = relative.to_string_lossy().replace('\\', "/");
            if !relative_str.starts_with(".git/HEAD")
                && !relative_str.starts_with(".git/refs/")
                && !relative_str.starts_with(".git/index")
            {
                return true;
            }
        }
    }

    false
}

/// 从事件中提取项目路径
fn extract_project_path(event: &Event) -> Option<PathBuf> {
    for path in &event.paths {
        // 找到包含 .git 的祖先目录
        for ancestor in path.ancestors() {
            if ancestor.join(".git").exists() {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    None
}

/// Tauri 命令：开始监听 Git 文件变化
#[tauri::command]
pub fn git_watch_start(
    project_path: String,
    git_watcher: State<'_, Arc<GitWatcher>>,
) -> Result<(), String> {
    let path = PathBuf::from(&project_path);
    git_watcher.watch(&path)
}

/// Tauri 命令：停止监听 Git 文件变化
#[tauri::command]
pub fn git_watch_stop(project_path: String, git_watcher: State<'_, Arc<GitWatcher>>) {
    let path = PathBuf::from(&project_path);
    git_watcher.unwatch(&path);
}
