use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::utils::run_git_blocking;

const GIT_CLONE_EVENT: &str = "git-clone-task-event";
static CLONE_TASK_PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
static CANCELLED_CLONE_TASKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
    pub project_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneStartResult {
    pub task_id: String,
    pub project_path: String,
    pub directory_name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneEventPayload {
    pub task_id: String,
    pub status: String,
    pub project_path: String,
    pub directory_name: String,
    pub remote_url: String,
    pub stage: Option<String>,
    pub progress_percent: Option<u8>,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub transferred: Option<String>,
    pub speed: Option<String>,
    pub detail: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct CloneProgressUpdate {
    stage: String,
    progress_percent: Option<u8>,
    current: Option<u64>,
    total: Option<u64>,
    transferred: Option<String>,
    speed: Option<String>,
    detail: Option<String>,
}

fn validate_directory_name(value: &str) -> Result<&str, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("项目文件夹名称不能为空".to_string());
    }
    if name == "."
        || name == ".."
        || name.ends_with('.')
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err("项目文件夹名称包含无效字符".to_string());
    }
    let windows_stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let is_windows_reserved = matches!(windows_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (windows_stem.len() == 4
            && (windows_stem.starts_with("COM") || windows_stem.starts_with("LPT"))
            && matches!(windows_stem.as_bytes()[3], b'1'..=b'9'));
    if is_windows_reserved {
        return Err("该项目文件夹名称是 Windows 保留名称".to_string());
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("项目文件夹名称必须是单独的目录名".to_string());
    }
    Ok(name)
}

fn clone_task_pids() -> &'static Mutex<HashMap<String, u32>> {
    CLONE_TASK_PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled_clone_tasks() -> &'static Mutex<HashSet<String>> {
    CANCELLED_CLONE_TASKS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn register_clone_pid(task_id: &str, pid: u32) {
    if let Ok(mut tasks) = clone_task_pids().lock() {
        tasks.insert(task_id.to_string(), pid);
    }
}

fn unregister_clone_pid(task_id: &str) {
    if let Ok(mut tasks) = clone_task_pids().lock() {
        tasks.remove(task_id);
    }
}

fn mark_clone_cancelled(task_id: &str) {
    if let Ok(mut tasks) = cancelled_clone_tasks().lock() {
        tasks.insert(task_id.to_string());
    }
}

fn take_clone_cancelled(task_id: &str) -> bool {
    cancelled_clone_tasks()
        .lock()
        .ok()
        .is_some_and(|mut tasks| tasks.remove(task_id))
}

#[cfg(target_os = "windows")]
fn terminate_process_tree_by_pid(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut taskkill = Command::new("taskkill.exe");
    taskkill
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    taskkill.status().is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree_by_pid(pid: u32) -> bool {
    Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[tauri::command]
pub fn git_cancel_clone_task(app: AppHandle, task_id: String) -> Result<(), String> {
    let pid = clone_task_pids()
        .lock()
        .map_err(|_| "无法访问后台克隆任务".to_string())?
        .remove(&task_id);

    let pid = pid.ok_or_else(|| "后台克隆任务不存在或已结束".to_string())?;
    mark_clone_cancelled(&task_id);

    if !terminate_process_tree_by_pid(pid) {
        let _ = cancelled_clone_tasks()
            .lock()
            .map(|mut tasks| tasks.remove(&task_id));
        return Err("无法结束后台克隆任务".to_string());
    }

    emit_clone_event(
        &app,
        GitCloneEventPayload {
            task_id,
            status: "cancelled".to_string(),
            project_path: String::new(),
            directory_name: String::new(),
            remote_url: String::new(),
            stage: None,
            progress_percent: None,
            current: None,
            total: None,
            transferred: None,
            speed: None,
            detail: None,
            error: None,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn git_clone_repository(
    app: AppHandle,
    database: tauri::State<'_, std::sync::Arc<crate::database::Database>>,
    remote_url: String,
    parent_directory: String,
    directory_name: String,
    branch: Option<String>,
    shallow: bool,
) -> Result<GitCloneStartResult, String> {
    let network_proxy = super::super::network_proxy::load_resolved_proxy(&database)?;
    let remote_url = remote_url.trim().to_string();
    if remote_url.is_empty() || remote_url.starts_with('-') || remote_url.contains(['\r', '\n']) {
        return Err("请输入有效的 Git 仓库地址".to_string());
    }

    let directory_name = validate_directory_name(&directory_name)?.to_string();
    let parent = crate::path_utils::normalize_input_path(&parent_directory);
    if !parent.is_dir() {
        return Err("保存位置不存在或不是文件夹".to_string());
    }
    let destination = parent.join(&directory_name);
    if destination.exists() {
        return Err(format!("目标文件夹已存在：{}", destination.display()));
    }

    let normalized_branch = branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if normalized_branch
        .as_deref()
        .is_some_and(|value| value.contains(['\r', '\n']))
    {
        return Err("分支名称无效".to_string());
    }

    let task_id = format!(
        "clone-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    let project_path = destination.to_string_lossy().to_string();

    let app_handle = app.clone();
    let task_id_for_spawn = task_id.clone();
    let project_path_for_spawn = project_path.clone();
    let directory_name_for_spawn = directory_name.clone();
    let remote_url_for_spawn = remote_url.clone();
    tauri::async_runtime::spawn(async move {
        emit_clone_event(
            &app_handle,
            GitCloneEventPayload {
                task_id: task_id_for_spawn.clone(),
                status: "progress".to_string(),
                project_path: project_path_for_spawn.clone(),
                directory_name: directory_name_for_spawn.clone(),
                remote_url: remote_url_for_spawn.clone(),
                stage: Some("starting".to_string()),
                progress_percent: None,
                current: None,
                total: None,
                transferred: None,
                speed: None,
                detail: None,
                error: None,
            },
        );

        let progress_app_handle = app_handle.clone();
        let progress_task_id = task_id_for_spawn.clone();
        let progress_project_path = project_path_for_spawn.clone();
        let progress_directory_name = directory_name_for_spawn.clone();
        let progress_remote_url = remote_url_for_spawn.clone();
        let clone_result = run_git_blocking("克隆 Git 仓库", move || {
            let mut command = super::utils::git_command_with_proxy(&network_proxy);
            command.arg("clone").arg("--progress");
            if shallow {
                command.arg("--depth").arg("1");
            }
            if let Some(branch) = normalized_branch.as_deref() {
                command.arg("--branch").arg(branch);
            }
            command
                .arg("--")
                .arg(&remote_url_for_spawn)
                .arg(&destination)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env("GIT_TERMINAL_PROMPT", "0");

            let mut child = command.spawn().map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    "未找到 Git，请先安装 Git 并确保它已加入 PATH".to_string()
                } else {
                    format!("无法启动 Git：{}", error)
                }
            })?;
            register_clone_pid(&progress_task_id, child.id());

            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| "无法读取 Git 进度输出".to_string())?;
            let mut stderr_reader = BufReader::new(stderr);
            let mut stdout = child.stdout.take();
            let mut stderr_log = String::new();
            read_clone_progress(
                &mut stderr_reader,
                |update| {
                    emit_clone_event(
                        &progress_app_handle,
                        GitCloneEventPayload {
                            task_id: progress_task_id.clone(),
                            status: "progress".to_string(),
                            project_path: progress_project_path.clone(),
                            directory_name: progress_directory_name.clone(),
                            remote_url: progress_remote_url.clone(),
                            stage: Some(update.stage),
                            progress_percent: update.progress_percent,
                            current: update.current,
                            total: update.total,
                            transferred: update.transferred,
                            speed: update.speed,
                            detail: update.detail,
                            error: None,
                        },
                    );
                },
                &mut stderr_log,
            )?;

            let status = child
                .wait()
                .map_err(|error| format!("等待 Git 克隆进程失败：{}", error))?;
            unregister_clone_pid(&progress_task_id);
            let mut stdout_text = String::new();
            if let Some(mut stdout_reader) = stdout.take() {
                let _ = stdout_reader.read_to_string(&mut stdout_text);
            }

            if !status.success() {
                if take_clone_cancelled(&progress_task_id) {
                    return Err("__clone_cancelled__".to_string());
                }
                let _ = std::fs::remove_dir_all(&destination);
                let stderr = stderr_log.trim().to_string();
                let stdout = stdout_text.trim().to_string();
                return Err(if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    "Git 克隆失败，请检查仓库地址和网络连接".to_string()
                });
            }

            Ok(GitCloneResult {
                project_path: destination.to_string_lossy().to_string(),
            })
        })
        .await;

        emit_clone_event(
            &app_handle,
            GitCloneEventPayload {
                task_id: task_id_for_spawn,
                status: if clone_result.is_ok() {
                    "completed".to_string()
                } else if clone_result
                    .as_ref()
                    .is_err_and(|error| error == "__clone_cancelled__")
                {
                    "cancelled".to_string()
                } else {
                    "failed".to_string()
                },
                project_path: project_path_for_spawn,
                directory_name: directory_name_for_spawn,
                remote_url: remote_url,
                stage: None,
                progress_percent: if clone_result.is_ok() {
                    Some(100)
                } else {
                    None
                },
                current: None,
                total: None,
                transferred: None,
                speed: None,
                detail: None,
                error: clone_result
                    .err()
                    .filter(|error| error != "__clone_cancelled__"),
            },
        );
    });

    Ok(GitCloneStartResult {
        task_id,
        project_path,
        directory_name,
    })
}

fn emit_clone_event(app: &AppHandle, payload: GitCloneEventPayload) {
    let _ = app.emit(GIT_CLONE_EVENT, payload);
}

fn read_clone_progress<R, F>(
    reader: &mut BufReader<R>,
    mut on_update: F,
    stderr_log: &mut String,
) -> Result<(), String>
where
    R: Read,
    F: FnMut(CloneProgressUpdate),
{
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let bytes = reader
            .read_until(b'\r', &mut buffer)
            .map_err(|error| format!("读取 Git 进度失败：{}", error))?;
        if bytes == 0 {
            break;
        }

        let chunk = String::from_utf8_lossy(&buffer);
        for raw_segment in chunk.split(['\r', '\n']) {
            let line = raw_segment.trim();
            if line.is_empty() {
                continue;
            }
            if !stderr_log.is_empty() {
                stderr_log.push('\n');
            }
            stderr_log.push_str(line);
            if let Some(update) = parse_clone_progress_line(line) {
                on_update(update);
            }
        }
    }
    Ok(())
}

fn parse_clone_progress_line(line: &str) -> Option<CloneProgressUpdate> {
    let normalized = line.trim();
    if normalized.is_empty() {
        return None;
    }

    if normalized.starts_with("Cloning into ") {
        return Some(CloneProgressUpdate {
            stage: "starting".to_string(),
            progress_percent: None,
            current: None,
            total: None,
            transferred: None,
            speed: None,
            detail: Some(normalized.to_string()),
        });
    }

    let stripped = normalized.strip_prefix("remote: ").unwrap_or(normalized);
    let (label, rest) = stripped.split_once(':')?;
    let stage = normalize_clone_stage(label);
    let (progress_percent, current, total, tail) = parse_progress_metrics(rest);
    let (transferred, speed, detail) = parse_progress_tail(&stage, tail);

    Some(CloneProgressUpdate {
        stage,
        progress_percent,
        current,
        total,
        transferred,
        speed,
        detail,
    })
}

fn normalize_clone_stage(label: &str) -> String {
    let normalized = label.trim().to_ascii_lowercase();
    if normalized.starts_with("enumerating objects") {
        "enumerating".to_string()
    } else if normalized.starts_with("counting objects") {
        "counting".to_string()
    } else if normalized.starts_with("compressing objects") {
        "compressing".to_string()
    } else if normalized.starts_with("receiving objects") {
        "receiving".to_string()
    } else if normalized.starts_with("resolving deltas") {
        "resolving".to_string()
    } else if normalized.starts_with("updating files") {
        "updating".to_string()
    } else {
        normalized
    }
}

fn parse_progress_metrics(rest: &str) -> (Option<u8>, Option<u64>, Option<u64>, Option<String>) {
    let trimmed = rest.trim().trim_end_matches('.');
    let progress_percent = trimmed
        .find('%')
        .and_then(|percent_index| parse_trailing_u8(&trimmed[..percent_index]));

    let (current, total, tail) =
        if let Some((current, total, close_index)) = parse_fraction_range(trimmed) {
            let tail = trimmed[close_index + 1..]
                .trim()
                .trim_start_matches(',')
                .trim()
                .trim_end_matches(',')
                .trim();
            (
                Some(current),
                Some(total),
                (!tail.is_empty() && !tail.eq_ignore_ascii_case("done")).then(|| tail.to_string()),
            )
        } else {
            (
                None,
                None,
                (!trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("done"))
                    .then(|| trimmed.to_string()),
            )
        };

    (progress_percent, current, total, tail)
}

fn parse_progress_tail(
    stage: &str,
    tail: Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(tail) = tail else {
        return (None, None, None);
    };
    let normalized_tail = tail.trim();
    if stage == "receiving" {
        if let Some((transferred, speed)) = normalized_tail.split_once('|') {
            return (
                Some(transferred.trim().trim_end_matches(',').to_string()),
                Some(speed.trim().to_string()),
                None,
            );
        }
        return (Some(normalized_tail.to_string()), None, None);
    }

    (None, None, Some(normalized_tail.to_string()))
}

fn parse_trailing_u8(value: &str) -> Option<u8> {
    let digits: String = value
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit() || character.is_ascii_whitespace())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .trim()
        .to_string();
    digits.parse::<u8>().ok()
}

fn parse_fraction_range(value: &str) -> Option<(u64, u64, usize)> {
    let open_index = value.find('(')?;
    let close_index = value[open_index + 1..].find(')')? + open_index + 1;
    let range = value[open_index + 1..close_index].trim();
    let (current, total) = range.split_once('/')?;
    let current = current.trim().parse::<u64>().ok()?;
    let total = total.trim().parse::<u64>().ok()?;
    Some((current, total, close_index))
}

#[cfg(test)]
mod tests {
    use super::validate_directory_name;

    #[test]
    fn validates_clone_directory_names() {
        assert_eq!(validate_directory_name("termflow").unwrap(), "termflow");
        assert!(validate_directory_name("../termflow").is_err());
        assert!(validate_directory_name("term:flow").is_err());
        assert!(validate_directory_name("CON").is_err());
        assert!(validate_directory_name("repo.").is_err());
        assert!(validate_directory_name("  ").is_err());
    }
}
