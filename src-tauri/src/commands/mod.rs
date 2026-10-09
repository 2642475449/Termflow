pub mod agent_hooks;
pub(crate) mod agent_runner;
pub mod agent_usage;
pub mod agent_versions;
pub mod agents;
pub mod background;
pub mod claude_config;
pub mod command_library;
pub mod content_search;
pub mod explorer_context_menu;
pub mod feishu;
pub mod file_tree;
pub mod git;
pub mod image;
pub mod mcp_servers;
pub mod network_proxy;
pub mod notification;
pub mod project_launchers;
pub mod quick_commands;
pub mod remote_notification;
pub(crate) mod scheduled_tasks;
pub mod search_index;
pub mod session;
pub mod settings;
pub mod skills;
pub mod system_input;
pub mod voice;
pub mod voice_polish;
pub mod voice_shortcut;
pub mod window;

/// 将同步磁盘、进程和锁等待操作移出窗口线程及异步执行线程。
pub(crate) async fn run_background_task<T, F>(operation: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{operation}后台任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::run_background_task;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn background_work_runs_outside_the_async_executor_thread() {
        tauri::async_runtime::block_on(async {
            let executor_thread = std::thread::current().id();
            let worker_thread = run_background_task("测试", || Ok(std::thread::current().id()))
                .await
                .expect("background task succeeds");
            assert_ne!(executor_thread, worker_thread);
        });
    }

    #[test]
    fn background_work_does_not_prevent_other_runtime_tasks_from_completing() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let work = tauri::async_runtime::spawn(run_background_task("测试", move || {
            started_tx.send(()).map_err(|error| error.to_string())?;
            release_rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|error| error.to_string())?;
            Ok(42)
        }));
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("background work starts");
        let (responsive_tx, responsive_rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = responsive_tx.send(());
        });
        let responsive = responsive_rx.recv_timeout(Duration::from_secs(2));
        let _ = release_tx.send(());
        assert!(
            responsive.is_ok(),
            "runtime remains responsive during blocking work"
        );
        assert_eq!(
            tauri::async_runtime::block_on(work).expect("task joins"),
            Ok(42)
        );
    }

    #[test]
    fn background_work_preserves_business_errors() {
        let result = tauri::async_runtime::block_on(run_background_task::<(), _>("测试", || {
            Err("文件不存在".into())
        }));
        assert_eq!(result, Err("文件不存在".into()));
    }
}
