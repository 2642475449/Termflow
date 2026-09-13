use std::sync::Arc;

use tauri::State;

use crate::{
    database::Database,
    scheduled_tasks::{
        next_run_after, ScheduledTaskInput, ScheduledTaskRecord, ScheduledTaskRunRecord,
        ScheduledTaskSchedule, ScheduledTaskScheduler,
    },
};

const DEFAULT_RUN_HISTORY_LIMIT: usize = 20;
const MAX_RUN_HISTORY_LIMIT: usize = 200;

#[tauri::command]
pub fn list_scheduled_tasks(
    project_path: Option<String>,
    database: State<'_, Arc<Database>>,
) -> Result<Vec<ScheduledTaskRecord>, String> {
    database.list_scheduled_tasks(project_path.as_deref())
}

#[tauri::command]
pub fn create_scheduled_task(
    task: ScheduledTaskInput,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<ScheduledTaskRecord, String> {
    scheduler.create_task(task)
}

#[tauri::command]
pub fn update_scheduled_task(
    task_id: String,
    task: ScheduledTaskInput,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<ScheduledTaskRecord, String> {
    scheduler.update_task(&task_id, task)
}

#[tauri::command]
pub fn set_scheduled_task_enabled(
    task_id: String,
    enabled: bool,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<ScheduledTaskRecord, String> {
    scheduler.set_task_enabled(&task_id, enabled)
}

#[tauri::command]
pub fn delete_scheduled_task(
    task_id: String,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<(), String> {
    scheduler.delete_task(&task_id)
}

#[tauri::command]
pub fn run_scheduled_task_now(
    task_id: String,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<ScheduledTaskRunRecord, String> {
    scheduler.inner().run_now(&task_id)
}

#[tauri::command]
pub fn list_scheduled_task_runs(
    project_path: Option<String>,
    limit: Option<usize>,
    database: State<'_, Arc<Database>>,
) -> Result<Vec<ScheduledTaskRunRecord>, String> {
    let limit = limit
        .unwrap_or(DEFAULT_RUN_HISTORY_LIMIT)
        .clamp(1, MAX_RUN_HISTORY_LIMIT);
    database.list_scheduled_task_runs(project_path.as_deref(), limit)
}

#[tauri::command]
pub fn get_scheduled_task_run(
    run_id: String,
    database: State<'_, Arc<Database>>,
) -> Result<ScheduledTaskRunRecord, String> {
    database.get_scheduled_task_run(&run_id)
}

#[tauri::command]
pub fn get_scheduled_task_run_log(
    run_id: String,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<String, String> {
    scheduler.read_run_log(&run_id)
}

#[tauri::command]
pub fn cancel_scheduled_task_run(
    run_id: String,
    scheduler: State<'_, Arc<ScheduledTaskScheduler>>,
) -> Result<(), String> {
    scheduler.cancel_run(&run_id)
}

#[tauri::command]
pub fn preview_scheduled_task_runs(
    schedule: ScheduledTaskSchedule,
    timezone: String,
    count: Option<usize>,
) -> Result<Vec<i64>, String> {
    let count = count.unwrap_or(3).clamp(1, 5);
    let mut cursor = chrono::Utc::now().timestamp_millis().saturating_sub(1);
    let mut result = Vec::with_capacity(count);
    for _ in 0..count {
        let Some(next) = next_run_after(&schedule, &timezone, cursor)? else {
            break;
        };
        result.push(next);
        cursor = next;
    }
    Ok(result)
}
