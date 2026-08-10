use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::database::{Database, PersistentSettingsRecord};

const PERSISTENT_THEME_UPDATED_EVENT: &str = "persistent-theme-updated";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistentThemeUpdate {
    light_theme: String,
    dark_theme: String,
    theme_category: String,
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
    database.save_persistent_settings_without_last_project(&settings)?;
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
