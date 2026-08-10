use super::window::{focus_project_window_internal, WindowRegistry};
use std::sync::Arc;
use tauri::State;
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "windows")]
const WINDOWS_TOAST_APP_ID: &str = "com.termflow.desktop";

#[tauri::command]
pub fn send_session_notification(
    app: tauri::AppHandle,
    registry: State<'_, Arc<WindowRegistry>>,
    title: String,
    body: String,
    session_id: String,
    project_path: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let registry = registry.inner().clone();
        if send_windows_session_notification(
            app.clone(),
            registry,
            title.clone(),
            body.clone(),
            session_id.clone(),
            project_path.clone(),
        )
        .is_ok()
        {
            return Ok(());
        }
    }

    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn send_windows_session_notification(
    app: tauri::AppHandle,
    registry: Arc<WindowRegistry>,
    title: String,
    body: String,
    session_id: String,
    project_path: String,
) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, Toast};

    ensure_windows_toast_registration(&app)?;

    Toast::new(WINDOWS_TOAST_APP_ID)
        .title(&title)
        .text1(&body)
        .duration(Duration::Short)
        .on_activated(move |_| {
            let _ =
                focus_project_window_internal(&app, registry.as_ref(), &project_path, &session_id);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn ensure_windows_toast_registration(app: &tauri::AppHandle) -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    let key = CURRENT_USER
        .create(format!(
            r"SOFTWARE\Classes\AppUserModelId\{WINDOWS_TOAST_APP_ID}"
        ))
        .map_err(|e| format!("创建 Windows 通知注册表失败: {e}"))?;

    key.set_string("DisplayName", "Termflow")
        .map_err(|e| format!("写入 Windows 通知显示名失败: {e}"))?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|e| format!("写入 Windows 通知背景色失败: {e}"))?;

    if let Ok(exe_path) = std::env::current_exe() {
        let icon_uri = exe_path.to_string_lossy().to_string();
        let _ = key.set_string("IconUri", &icon_uri);
    } else {
        let _ = app;
    }

    Ok(())
}
