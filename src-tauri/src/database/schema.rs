use rusqlite::Connection;

pub fn migrate(conn: &Connection) -> Result<(), String> {
    let version = conn
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("读取 SQLite schema 版本失败: {error}"))?;

    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );",
        )
        .map_err(|error| format!("创建 app_settings 表失败: {error}"))?;

        conn.pragma_update(None, "user_version", 1)
            .map_err(|error| format!("更新 SQLite schema 版本失败: {error}"))?;
    }

    if version < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_usage_sessions (
                agent TEXT NOT NULL,
                session_key TEXT NOT NULL,
                source_fingerprint TEXT NOT NULL,
                parser_version INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                total_tokens INTEGER NOT NULL,
                total_messages INTEGER NOT NULL,
                first_seen_at_ms INTEGER NOT NULL,
                last_seen_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (agent, session_key)
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_agent_usage_sessions_updated
                ON agent_usage_sessions (agent, updated_at_ms);

            CREATE TABLE IF NOT EXISTS agent_usage_control (
                agent TEXT PRIMARY KEY NOT NULL,
                cleared_at_ms INTEGER,
                last_synced_at_ms INTEGER,
                last_error TEXT
            ) WITHOUT ROWID;",
        )
        .map_err(|error| format!("创建智能体用量账本失败: {error}"))?;

        conn.pragma_update(None, "user_version", 2)
            .map_err(|error| format!("更新 SQLite schema 版本失败: {error}"))?;
    }

    if version < 3 {
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            ["terminal.skipPermissions"],
        )
        .map_err(|error| format!("failed to remove legacy permission setting: {error}"))?;

        conn.pragma_update(None, "user_version", 3)
            .map_err(|error| format!("failed to update SQLite schema version: {error}"))?;
    }

    if version < 4 {
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            ["notification.volume"],
        )
        .map_err(|error| format!("failed to remove legacy notification volume setting: {error}"))?;

        conn.pragma_update(None, "user_version", 4)
            .map_err(|error| format!("failed to update SQLite schema version: {error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_creates_usage_ledger_and_is_idempotent() {
        let connection = Connection::open_in_memory().unwrap();

        migrate(&connection).unwrap();
        migrate(&connection).unwrap();

        let version = connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap();
        let session_table_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_usage_sessions')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let control_table_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_usage_control')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(version, 4);
        assert_eq!(session_table_exists, 1);
        assert_eq!(control_table_exists, 1);
    }

    #[test]
    fn migration_removes_legacy_global_permission_setting() {
        let connection = Connection::open_in_memory().unwrap();

        migrate(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO app_settings (key, value, updated_at_ms) VALUES (?1, ?2, ?3)",
                rusqlite::params!["terminal.skipPermissions", "true", 0_i64],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();

        migrate(&connection).unwrap();
        let legacy_setting_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = 'terminal.skipPermissions')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(legacy_setting_exists, 0);
    }

    #[test]
    fn migration_removes_legacy_notification_volume_setting() {
        let connection = Connection::open_in_memory().unwrap();

        migrate(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO app_settings (key, value, updated_at_ms) VALUES (?1, ?2, ?3)",
                rusqlite::params!["notification.volume", "60", 0_i64],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();

        migrate(&connection).unwrap();
        let legacy_setting_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = 'notification.volume')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(legacy_setting_exists, 0);
    }
}
