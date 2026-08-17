use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::database::{Database, PersistentSettingsRecord};

const PERSISTENT_THEME_UPDATED_EVENT: &str = "persistent-theme-updated";
pub const PERSISTENT_EXPLORER_CONTEXT_MENU_UPDATED_EVENT: &str =
    "persistent-explorer-context-menu-updated";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentThemeUpdate {
    light_theme: String,
    dark_theme: String,
    theme_category: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentExplorerContextMenuUpdate {
    pub explorer_context_menu_enabled: bool,
}

#[tauri::command]
pub fn initialize_persistent_settings(
    database: State<'_, Arc<Database>>,
    legacy_settings: Option<PersistentSettingsRecord>,
) -> Result<PersistentSettingsRecord, String> {
    if !database.has_any_settings()? {
        let initial_settings = legacy_settings.unwrap_or_default();
        database.save_persistent_settings(&initial_settings)?;
    }

    database.load_persistent_settings()
}

#[tauri::command]
pub fn get_persistent_settings(
    database: State<'_, Arc<Database>>,
) -> Result<PersistentSettingsRecord, String> {
    database.load_persistent_settings()
}

#[tauri::command]
pub fn save_persistent_settings(
    database: State<'_, Arc<Database>>,
    settings: PersistentSettingsRecord,
    app: AppHandle,
) -> Result<(), String> {
    database.save_general_persistent_settings(&settings)?;
    let _ = app.emit(
        PERSISTENT_THEME_UPDATED_EVENT,
        PersistentThemeUpdate {
            light_theme: settings.light_theme,
            dark_theme: settings.dark_theme,
            theme_category: settings.theme_category,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn set_explorer_context_menu_enabled(
    enabled: bool,
    database: State<'_, Arc<Database>>,
    app: AppHandle,
) -> Result<(), String> {
    let previous_enabled = database.load_explorer_context_menu_enabled()?;

    crate::commands::explorer_context_menu::set_explorer_context_menu_enabled(enabled)?;

    if let Err(error) = database.save_explorer_context_menu_enabled(enabled) {
        // The registry operation has already succeeded. Best-effort rollback
        // keeps the operating-system integration aligned with the persisted
        // preference when storage is temporarily unavailable.
        if let Err(rollback_error) =
            crate::commands::explorer_context_menu::set_explorer_context_menu_enabled(
                previous_enabled,
            )
        {
            return Err(format!(
                "保存资源管理器右键菜单设置失败: {error}; 回滚注册表也失败: {rollback_error}"
            ));
        }

        return Err(format!("保存资源管理器右键菜单设置失败: {error}"));
    }

    let _ = app.emit(
        PERSISTENT_EXPLORER_CONTEXT_MENU_UPDATED_EVENT,
        PersistentExplorerContextMenuUpdate {
            explorer_context_menu_enabled: enabled,
        },
    );

    Ok(())
}
