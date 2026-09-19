use super::{read_setting, write_setting, Database};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundSettings {
    pub run_in_background: bool,
    pub ask_before_close: bool,
}

impl Default for BackgroundSettings {
    fn default() -> Self {
        Self {
            run_in_background: false,
            ask_before_close: true,
        }
    }
}

impl Database {
    pub fn load_background_settings(&self) -> Result<BackgroundSettings, String> {
        Ok(read_setting(&self.conn.lock(), "general.background")?.unwrap_or_default())
    }

    pub fn save_background_settings(&self, settings: &BackgroundSettings) -> Result<(), String> {
        write_setting(&self.conn.lock(), "general.background", settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use rusqlite::Connection;

    #[test]
    fn first_close_asks_and_choice_survives_general_settings_writes() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::migrate(&conn).unwrap();
        let db = Database {
            conn: Mutex::new(conn),
        };
        assert_eq!(
            db.load_background_settings().unwrap(),
            BackgroundSettings::default()
        );
        let settings = BackgroundSettings {
            run_in_background: true,
            ask_before_close: false,
        };
        db.save_background_settings(&settings).unwrap();
        db.save_general_persistent_settings(&Default::default())
            .unwrap();
        assert_eq!(db.load_background_settings().unwrap(), settings);
    }
}
