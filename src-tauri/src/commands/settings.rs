use std::sync::Arc;

use tauri::State;

use crate::database::{Database, PersistentSettingsRecord};

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
) -> Result<(), String> {
    database.save_persistent_settings_without_last_project(&settings)
}
