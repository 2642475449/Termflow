use crate::database::{background::BackgroundSettings, Database};
use crate::events::{BACKGROUND_SETTINGS_CHANGED_EVENT, WORKSPACE_CLOSE_REQUESTED_EVENT};
use crate::pty::PtyManager;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewWindow};

pub fn is_workspace(label: &str) -> bool {
    label != "voice-overlay" && label != "voice-worker"
}

fn show_workspaces(app: &tauri::AppHandle) {
    let mut windows: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|window| is_workspace(window.label()))
        .collect();
    windows.sort_by_key(|window| window.label().to_string());
    for window in windows {
        if let Err(error) = window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
        {
            log::error!("Failed to restore workspace: {error}");
        }
    }
}

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let language = app
        .state::<Arc<Database>>()
        .load_persistent_settings()
        .map(|settings| settings.language)
        .unwrap_or_default();
    let (show_label, quit_label) = tray_labels(&language);
    let show = MenuItem::with_id(app, "background-show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "background-quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    app.manage(TrayMenuState {
        show,
        quit,
        language: parking_lot::Mutex::new(language),
    });
    let mut builder = TrayIconBuilder::with_id("termflow-background")
        .tooltip("Termflow")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_workspaces(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "background-show" => show_workspaces(app),
            "background-quit" => {
                // 交给前端统一检查更新下载状态，再执行显式退出。
                if let Some(window) = app.get_webview_window("main").or_else(|| {
                    app.webview_windows()
                        .into_values()
                        .find(|window| is_workspace(window.label()))
                }) {
                    let _ = window.show();
                    let _ = window.set_focus();
                    if let Err(error) =
                        window.emit_to(window.label(), WORKSPACE_CLOSE_REQUESTED_EVENT, true)
                    {
                        log::error!("Failed to request application exit: {error}");
                    }
                }
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

struct TrayMenuState {
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    language: parking_lot::Mutex<String>,
}

fn tray_labels(language: &str) -> (String, String) {
    let catalog = match language {
        "en" => include_str!("../../../src/locales/en-US.json"),
        "zh_TW" => include_str!("../../../src/locales/zh-TW.json"),
        "ja" => include_str!("../../../src/locales/ja-JP.json"),
        _ => include_str!("../../../src/locales/zh-CN.json"),
    };
    let value: serde_json::Value = serde_json::from_str(catalog).unwrap_or_default();
    let label = |key: &str| {
        value["background"][key]
            .as_str()
            .unwrap_or("Termflow")
            .to_string()
    };
    (label("trayShow"), label("trayQuit"))
}

pub fn update_tray_language(app: &tauri::AppHandle, language: &str) -> tauri::Result<()> {
    if let Some(state) = app.try_state::<TrayMenuState>() {
        let mut previous = state.language.lock();
        if *previous != language {
            let (show, quit) = tray_labels(language);
            state.show.set_text(show)?;
            state.quit.set_text(quit)?;
            *previous = language.to_string();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_background_settings(
    database: State<'_, Arc<Database>>,
) -> Result<BackgroundSettings, String> {
    database.load_background_settings()
}

#[tauri::command]
pub fn set_background_settings(
    settings: BackgroundSettings,
    database: State<'_, Arc<Database>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    database.save_background_settings(&settings)?;
    app.emit(BACKGROUND_SETTINGS_CHANGED_EVENT, &settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn complete_workspace_close(window: WebviewWindow, background: bool) -> Result<(), String> {
    if !is_workspace(window.label()) {
        return Err("Not a workspace window".into());
    }
    if background {
        if window
            .app_handle()
            .tray_by_id("termflow-background")
            .is_none()
        {
            return Err("System tray is unavailable".into());
        }
        // 隐藏而不销毁，保留 PTY、工作区与调度器。
        window.hide().map_err(|error| error.to_string())
    } else {
        window.destroy().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn exit_background_application(app: tauri::AppHandle) {
    app.state::<Arc<PtyManager>>().cleanup_all();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voice_windows_never_enter_the_background_close_flow() {
        assert!(!is_workspace("voice-overlay"));
        assert!(!is_workspace("voice-worker"));
        assert!(is_workspace("main"));
        assert!(is_workspace("project:example"));
    }
}
