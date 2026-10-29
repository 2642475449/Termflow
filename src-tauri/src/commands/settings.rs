use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::database::{Database, PersistentSettingsRecord};

const PERSISTENT_THEME_UPDATED_EVENT: &str = "persistent-theme-updated";
static SETTINGS_REVISION: parking_lot::Mutex<u64> = parking_lot::Mutex::new(0);
const PERSISTENT_NETWORK_PROXY_UPDATED_EVENT: &str = "persistent-network-proxy-updated";
pub const PERSISTENT_EXPLORER_CONTEXT_MENU_UPDATED_EVENT: &str =
    "persistent-explorer-context-menu-updated";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentThemeUpdate {
    revision: u64,
    light_theme: String,
    dark_theme: String,
    theme_category: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentNetworkProxyUpdate {
    revision: u64,
    network_proxy_mode: String,
    network_custom_proxy_url: String,
    network_no_proxy: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentShortcutsUpdate {
    revision: u64,
    keyboard_shortcuts: std::collections::BTreeMap<String, String>,
    voice_shortcut: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentExplorerContextMenuUpdate {
    revision: u64,
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
    changed_fields: Option<Vec<String>>,
    app: AppHandle,
) -> Result<u64, String> {
    // 保存、修订号和广播在同一把锁内，避免跨窗口命令交错后发出旧快照。
    let mut revision = SETTINGS_REVISION.lock();
    let settings = if let Some(fields) = changed_fields {
        database.save_general_persistent_settings_patch(&settings, &fields)?
    } else {
        database.save_general_persistent_settings(&settings)?;
        settings
    };
    *revision = revision.saturating_add(1);
    if let Err(error) = crate::commands::background::update_tray_language(&app, &settings.language)
    {
        log::warn!("Failed to update tray language: {error}");
    }
    let _ = app.emit(
        PERSISTENT_THEME_UPDATED_EVENT,
        PersistentThemeUpdate {
            revision: *revision,
            light_theme: settings.light_theme,
            dark_theme: settings.dark_theme,
            theme_category: settings.theme_category,
        },
    );
    let _ = app.emit(
        PERSISTENT_NETWORK_PROXY_UPDATED_EVENT,
        PersistentNetworkProxyUpdate {
            revision: *revision,
            network_proxy_mode: settings.network_proxy_mode,
            network_custom_proxy_url: settings.network_custom_proxy_url,
            network_no_proxy: settings.network_no_proxy,
        },
    );
    let _ = app.emit(
        "persistent-shortcuts-updated",
        PersistentShortcutsUpdate {
            revision: *revision,
            keyboard_shortcuts: settings.keyboard_shortcuts,
            voice_shortcut: settings.voice_shortcut,
        },
    );
    Ok(*revision)
}

#[tauri::command]
pub fn set_explorer_context_menu_enabled(
    enabled: bool,
    database: State<'_, Arc<Database>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut revision = SETTINGS_REVISION.lock();
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

    *revision = revision.saturating_add(1);
    let _ = app.emit(
        PERSISTENT_EXPLORER_CONTEXT_MENU_UPDATED_EVENT,
        PersistentExplorerContextMenuUpdate {
            revision: *revision,
            explorer_context_menu_enabled: enabled,
        },
    );

    Ok(())
}
