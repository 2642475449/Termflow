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

    if version < 6 {
        conn.execute_batch(
            "DROP TABLE IF EXISTS clipboard_attachments;
             DROP TABLE IF EXISTS clipboard_content_objects;",
        )
        .map_err(|error| format!("删除已弃用的剪贴板图片表失败: {error}"))?;

        conn.pragma_update(None, "user_version", 6)
            .map_err(|error| format!("更新 SQLite schema 版本失败: {error}"))?;
    }

    if version < 6 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY NOT NULL,
                project_path TEXT NOT NULL,
                project_name TEXT NOT NULL,
                name TEXT NOT NULL,
                execution_kind TEXT NOT NULL,
                agent_id TEXT,
                prompt TEXT,
                command TEXT,
                shell TEXT,
                schedule_json TEXT NOT NULL,
                timezone TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                next_run_at_ms INTEGER,
                timeout_ms INTEGER NOT NULL,
                missed_run_policy TEXT NOT NULL,
                notification_policy TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                deleted_at_ms INTEGER
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
                ON scheduled_tasks (enabled, next_run_at_ms)
                WHERE deleted_at_ms IS NULL;
            CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project
                ON scheduled_tasks (project_path, updated_at_ms DESC)
                WHERE deleted_at_ms IS NULL;

            CREATE TABLE IF NOT EXISTS scheduled_task_runs (
                id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT NOT NULL,
                trigger TEXT NOT NULL,
                scheduled_at_ms INTEGER,
                status TEXT NOT NULL,
                config_snapshot_json TEXT NOT NULL,
                started_at_ms INTEGER,
                completed_at_ms INTEGER,
                exit_code INTEGER,
                summary TEXT,
                error TEXT,
                log_path TEXT,
                created_at_ms INTEGER NOT NULL,
                FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
            ) WITHOUT ROWID;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_planned
                ON scheduled_task_runs (task_id, scheduled_at_ms)
                WHERE scheduled_at_ms IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
                ON scheduled_task_runs (task_id, created_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status
                ON scheduled_task_runs (status, created_at_ms DESC);",
        )
        .map_err(|error| format!("创建定时任务数据表失败: {error}"))?;

        conn.pragma_update(None, "user_version", 6)
            .map_err(|error| format!("更新 SQLite schema 版本失败: {error}"))?;
    }

    if version < 7 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS terminal_image_objects (
                file_name TEXT PRIMARY KEY NOT NULL,
                size_bytes INTEGER NOT NULL,
                legacy INTEGER NOT NULL DEFAULT 0,
                unreferenced_at_ms INTEGER
            );
            CREATE TABLE IF NOT EXISTS terminal_image_references (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL,
                file_name TEXT NOT NULL REFERENCES terminal_image_objects(file_name) ON DELETE CASCADE,
                retained INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL,
                released_at_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_terminal_image_session ON terminal_image_references(session_id);
            CREATE INDEX IF NOT EXISTS idx_terminal_image_object ON terminal_image_references(file_name, released_at_ms);
            CREATE INDEX IF NOT EXISTS idx_terminal_image_gc ON terminal_image_objects(legacy, unreferenced_at_ms);
            CREATE TABLE IF NOT EXISTS terminal_image_deleted_sessions (session_id TEXT PRIMARY KEY NOT NULL);"
        ).map_err(|error| format!("创建截图缓存账本失败: {error}"))?;
        conn.pragma_update(None, "user_version", 7)
            .map_err(|error| format!("更新截图缓存版本失败: {error}"))?;
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

        assert_eq!(version, 7);
        assert_eq!(session_table_exists, 1);
        assert_eq!(control_table_exists, 1);
    }

    #[test]
    fn upgrades_version_six_with_clipboard_reference_tables(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "user_version", 6)?;
        migrate(&connection)?;
        migrate(&connection)?;
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('terminal_image_objects', 'terminal_image_references', 'terminal_image_deleted_sessions')", [], |row| row.get(0))?;
        assert_eq!(count, 3);
        Ok(())
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

    #[test]
    fn migration_removes_retired_clipboard_image_tables() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE clipboard_content_objects (content_hash TEXT PRIMARY KEY);
                 CREATE TABLE clipboard_attachments (attachment_id TEXT PRIMARY KEY);
                 PRAGMA user_version = 5;",
            )
            .unwrap();

        migrate(&connection).unwrap();
        let table_exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('clipboard_content_objects', 'clipboard_attachments'))",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(table_exists, 0);
    }
}
