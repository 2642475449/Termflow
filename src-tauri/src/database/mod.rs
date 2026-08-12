pub mod schema;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{fs, sync::Arc};
use tauri::{AppHandle, Manager};

const DATABASE_FILE_NAME: &str = "termflow.db";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundMapRecord {
    pub task_complete: String,
    pub error: String,
    pub waiting: String,
}

impl Default for NotificationSoundMapRecord {
    fn default() -> Self {
        Self {
            task_complete: "default".into(),
            error: "alert".into(),
            waiting: "waiting".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuNotificationEventsRecord {
    pub completed: bool,
    pub error: bool,
    pub waiting: bool,
    pub permission: bool,
}

impl Default for FeishuNotificationEventsRecord {
    fn default() -> Self {
        Self {
            completed: true,
            error: true,
            waiting: true,
            permission: true,
        }
    }
}

fn default_terminal_renderer() -> String {
    "auto".into()
}

fn default_editor_font_size() -> i64 {
    14
}

fn default_project_open_behavior() -> String {
    "ask".into()
}

fn default_feishu_notification_threshold_ms() -> i64 {
    300_000
}

fn default_agent_permission_defaults() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

fn default_asr_auth_mode() -> String {
    "token-plan".into()
}

fn default_asr_region() -> String {
    "beijing".into()
}

fn infer_asr_auth_mode(api_key: &str) -> String {
    let normalized = api_key.trim().to_ascii_lowercase();
    if normalized.starts_with("sk-cp-") || normalized.starts_with("tp-") {
        "token-plan".into()
    } else if normalized.is_empty() {
        default_asr_auth_mode()
    } else {
        "api".into()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentSettingsRecord {
    pub light_theme: String,
    pub dark_theme: String,
    pub theme_category: String,
    pub language: String,
    pub startup_restore_last_project: bool,
    #[serde(default = "default_project_open_behavior")]
    pub project_open_behavior: String,
    pub last_project_path: Option<String>,
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: i64,
    pub terminal_font_size: i64,
    pub terminal_cursor_blink: bool,
    pub terminal_line_height: f64,
    #[serde(default = "default_terminal_renderer")]
    pub terminal_renderer: String,
    #[serde(default = "default_agent_permission_defaults")]
    pub agent_permission_defaults: serde_json::Value,
    pub notification_enabled: bool,
    pub notification_sound_enabled: bool,
    pub notification_sound_map: NotificationSoundMapRecord,
    pub notification_threshold_ms: i64,
    #[serde(default)]
    pub feishu_notification_enabled: bool,
    #[serde(default = "default_feishu_notification_threshold_ms")]
    pub feishu_notification_threshold_ms: i64,
    #[serde(default)]
    pub feishu_notification_events: FeishuNotificationEventsRecord,
    pub asr_api_key: String,
    #[serde(default = "default_asr_auth_mode")]
    pub asr_auth_mode: String,
    pub asr_model: String,
    #[serde(default = "default_asr_region")]
    pub asr_region: String,
    pub voice_shortcut: String,
    pub voice_input_target: String,
    pub voice_trigger_visible: bool,
    pub terminal_quick_commands: serde_json::Value,
    #[serde(default)]
    pub default_agent_id: Option<String>,
}

impl Default for PersistentSettingsRecord {
    fn default() -> Self {
        Self {
            light_theme: "light-glass".into(),
            dark_theme: "dark-starry".into(),
            theme_category: "dark".into(),
            language: "zh_CN".into(),
            startup_restore_last_project: true,
            project_open_behavior: default_project_open_behavior(),
            last_project_path: None,
            editor_font_size: default_editor_font_size(),
            terminal_font_size: 14,
            terminal_cursor_blink: true,
            terminal_line_height: 1.2,
            terminal_renderer: default_terminal_renderer(),
            agent_permission_defaults: default_agent_permission_defaults(),
            notification_enabled: true,
            notification_sound_enabled: true,
            notification_sound_map: NotificationSoundMapRecord::default(),
            notification_threshold_ms: 10_000,
            feishu_notification_enabled: false,
            feishu_notification_threshold_ms: default_feishu_notification_threshold_ms(),
            feishu_notification_events: FeishuNotificationEventsRecord::default(),
            asr_api_key: String::new(),
            asr_auth_mode: default_asr_auth_mode(),
            asr_model: "mimo-v2.5-asr".into(),
            asr_region: default_asr_region(),
            voice_shortcut: "Ctrl+Shift+V".into(),
            voice_input_target: "system".into(),
            voice_trigger_visible: true,
            terminal_quick_commands: serde_json::Value::Array(vec![]),
            default_agent_id: None,
        }
    }
}

pub struct Database {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub struct AgentUsageStoredSession {
    pub session_key: String,
    pub source_fingerprint: String,
    pub parser_version: i64,
    pub snapshot_json: String,
    pub total_tokens: u64,
    pub total_messages: u64,
}

#[derive(Debug, Clone, Default)]
pub struct AgentUsageControlState {
    pub cleared_at_ms: Option<i64>,
    pub last_synced_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageStorageStatus {
    pub agent: String,
    pub retained_sessions: u64,
    pub last_synced_at_ms: Option<i64>,
    pub cleared_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

impl Database {
    pub fn init(app: &AppHandle) -> Result<Arc<Self>, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("无法创建应用数据目录: {error}"))?;

        let db_path = app_data_dir.join(DATABASE_FILE_NAME);
        let conn =
            Connection::open(&db_path).map_err(|error| format!("无法打开设置数据库: {error}"))?;

        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("无法启用 SQLite WAL 模式: {error}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| format!("无法启用 SQLite foreign_keys: {error}"))?;

        schema::migrate(&conn)?;

        Ok(Arc::new(Self {
            conn: Mutex::new(conn),
        }))
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("enable in-memory foreign keys");
        schema::migrate(&conn).expect("migrate in-memory database");
        Self {
            conn: Mutex::new(conn),
        }
    }

    pub fn has_any_settings(&self) -> Result<bool, String> {
        let conn = self.conn.lock();
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_settings LIMIT 1)",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("检查设置数据库状态失败: {error}"))?;
        Ok(exists != 0)
    }

    pub fn load_persistent_settings(&self) -> Result<PersistentSettingsRecord, String> {
        let conn = self.conn.lock();
        let mut settings = PersistentSettingsRecord::default();

        settings.light_theme =
            read_setting(&conn, "theme.lightTheme")?.unwrap_or(settings.light_theme);
        settings.dark_theme =
            read_setting(&conn, "theme.darkTheme")?.unwrap_or(settings.dark_theme);
        settings.theme_category =
            read_setting(&conn, "theme.themeCategory")?.unwrap_or(settings.theme_category);
        settings.language = read_setting(&conn, "general.language")?.unwrap_or(settings.language);
        settings.startup_restore_last_project =
            read_setting(&conn, "general.startupRestoreLastProject")?
                .unwrap_or(settings.startup_restore_last_project);
        settings.project_open_behavior = read_setting(&conn, "general.projectOpenBehavior")?
            .unwrap_or(settings.project_open_behavior);
        settings.last_project_path =
            read_setting(&conn, "general.lastProjectPath")?.unwrap_or(settings.last_project_path);
        settings.editor_font_size =
            read_setting(&conn, "editor.fontSize")?.unwrap_or(settings.editor_font_size);
        settings.terminal_font_size =
            read_setting(&conn, "terminal.fontSize")?.unwrap_or(settings.terminal_font_size);
        settings.terminal_cursor_blink =
            read_setting(&conn, "terminal.cursorBlink")?.unwrap_or(settings.terminal_cursor_blink);
        settings.terminal_line_height =
            read_setting(&conn, "terminal.lineHeight")?.unwrap_or(settings.terminal_line_height);
        settings.terminal_renderer =
            read_setting(&conn, "terminal.renderer")?.unwrap_or(settings.terminal_renderer);
        settings.agent_permission_defaults = read_setting(&conn, "agents.permissionDefaults")?
            .unwrap_or(settings.agent_permission_defaults);
        settings.notification_enabled =
            read_setting(&conn, "notification.enabled")?.unwrap_or(settings.notification_enabled);
        settings.notification_sound_enabled = read_setting(&conn, "notification.soundEnabled")?
            .unwrap_or(settings.notification_sound_enabled);
        settings.notification_sound_map = read_setting(&conn, "notification.soundMap")?
            .unwrap_or(settings.notification_sound_map);
        settings.notification_threshold_ms = read_setting(&conn, "notification.thresholdMs")?
            .unwrap_or(settings.notification_threshold_ms);
        settings.feishu_notification_enabled = read_setting(&conn, "notification.feishu.enabled")?
            .unwrap_or(settings.feishu_notification_enabled);
        settings.feishu_notification_threshold_ms =
            read_setting(&conn, "notification.feishu.thresholdMs")?
                .unwrap_or(settings.feishu_notification_threshold_ms);
        settings.feishu_notification_events = read_setting(&conn, "notification.feishu.events")?
            .unwrap_or(settings.feishu_notification_events);
        settings.asr_api_key = read_setting(&conn, "voice.apiKey")?.unwrap_or(settings.asr_api_key);
        settings.asr_auth_mode = read_setting(&conn, "voice.authMode")?
            .unwrap_or_else(|| infer_asr_auth_mode(&settings.asr_api_key));
        settings.asr_model = read_setting(&conn, "voice.model")?.unwrap_or(settings.asr_model);
        settings.asr_region = read_setting(&conn, "voice.region")?.unwrap_or(settings.asr_region);
        settings.voice_shortcut =
            read_setting(&conn, "voice.shortcut")?.unwrap_or(settings.voice_shortcut);
        settings.voice_input_target =
            read_setting(&conn, "voice.inputTarget")?.unwrap_or(settings.voice_input_target);
        settings.voice_trigger_visible =
            read_setting(&conn, "voice.triggerVisible")?.unwrap_or(settings.voice_trigger_visible);
        settings.terminal_quick_commands = read_setting(&conn, "quickCommands.terminalCommands")?
            .unwrap_or(settings.terminal_quick_commands);
        settings.default_agent_id =
            read_setting(&conn, "agents.defaultAgentId")?.unwrap_or(settings.default_agent_id);

        Ok(settings)
    }

    pub fn save_persistent_settings(
        &self,
        settings: &PersistentSettingsRecord,
    ) -> Result<(), String> {
        self.save_persistent_settings_internal(settings, true)
    }

    pub fn save_persistent_settings_without_last_project(
        &self,
        settings: &PersistentSettingsRecord,
    ) -> Result<(), String> {
        self.save_persistent_settings_internal(settings, false)
    }

    pub fn save_last_project_path(&self, project_path: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        write_setting(
            &conn,
            "general.lastProjectPath",
            &Some(project_path.to_string()),
        )
    }

    fn save_persistent_settings_internal(
        &self,
        settings: &PersistentSettingsRecord,
        include_last_project: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock();

        write_setting(&conn, "theme.lightTheme", &settings.light_theme)?;
        write_setting(&conn, "theme.darkTheme", &settings.dark_theme)?;
        write_setting(&conn, "theme.themeCategory", &settings.theme_category)?;
        write_setting(&conn, "general.language", &settings.language)?;
        write_setting(
            &conn,
            "general.startupRestoreLastProject",
            &settings.startup_restore_last_project,
        )?;
        write_setting(
            &conn,
            "general.projectOpenBehavior",
            &settings.project_open_behavior,
        )?;
        if include_last_project {
            write_setting(
                &conn,
                "general.lastProjectPath",
                &settings.last_project_path,
            )?;
        }
        write_setting(&conn, "editor.fontSize", &settings.editor_font_size)?;
        write_setting(&conn, "terminal.fontSize", &settings.terminal_font_size)?;
        write_setting(
            &conn,
            "terminal.cursorBlink",
            &settings.terminal_cursor_blink,
        )?;
        write_setting(&conn, "terminal.lineHeight", &settings.terminal_line_height)?;
        write_setting(&conn, "terminal.renderer", &settings.terminal_renderer)?;
        write_setting(
            &conn,
            "agents.permissionDefaults",
            &settings.agent_permission_defaults,
        )?;
        write_setting(
            &conn,
            "notification.enabled",
            &settings.notification_enabled,
        )?;
        write_setting(
            &conn,
            "notification.soundEnabled",
            &settings.notification_sound_enabled,
        )?;
        write_setting(
            &conn,
            "notification.soundMap",
            &settings.notification_sound_map,
        )?;
        write_setting(
            &conn,
            "notification.thresholdMs",
            &settings.notification_threshold_ms,
        )?;
        write_setting(
            &conn,
            "notification.feishu.enabled",
            &settings.feishu_notification_enabled,
        )?;
        write_setting(
            &conn,
            "notification.feishu.thresholdMs",
            &settings.feishu_notification_threshold_ms,
        )?;
        write_setting(
            &conn,
            "notification.feishu.events",
            &settings.feishu_notification_events,
        )?;
        write_setting(&conn, "voice.apiKey", &settings.asr_api_key)?;
        write_setting(&conn, "voice.authMode", &settings.asr_auth_mode)?;
        write_setting(&conn, "voice.model", &settings.asr_model)?;
        write_setting(&conn, "voice.region", &settings.asr_region)?;
        write_setting(&conn, "voice.shortcut", &settings.voice_shortcut)?;
        write_setting(&conn, "voice.inputTarget", &settings.voice_input_target)?;
        write_setting(
            &conn,
            "voice.triggerVisible",
            &settings.voice_trigger_visible,
        )?;
        write_setting(
            &conn,
            "quickCommands.terminalCommands",
            &settings.terminal_quick_commands,
        )?;
        write_setting(&conn, "agents.defaultAgentId", &settings.default_agent_id)?;

        Ok(())
    }

    pub fn get_or_create_usage_salt(&self) -> Result<String, String> {
        let conn = self.conn.lock();
        if let Some(salt) = read_setting::<String>(&conn, "usage.installSalt")? {
            if !salt.is_empty() {
                return Ok(salt);
            }
        }

        let salt = conn
            .query_row("SELECT lower(hex(randomblob(32)))", [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| format!("生成用量数据匿名盐失败: {error}"))?;
        write_setting(&conn, "usage.installSalt", &salt)?;
        Ok(salt)
    }

    pub fn load_agent_usage_control(&self, agent: &str) -> Result<AgentUsageControlState, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT cleared_at_ms, last_synced_at_ms, last_error
             FROM agent_usage_control WHERE agent = ?1",
            [agent],
            |row| {
                Ok(AgentUsageControlState {
                    cleared_at_ms: row.get(0)?,
                    last_synced_at_ms: row.get(1)?,
                    last_error: row.get(2)?,
                })
            },
        )
        .optional()
        .map(|value| value.unwrap_or_default())
        .map_err(|error| format!("读取 {agent} 用量控制状态失败: {error}"))
    }

    pub fn load_agent_usage_sessions(
        &self,
        agent: &str,
    ) -> Result<Vec<AgentUsageStoredSession>, String> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare(
                "SELECT session_key, source_fingerprint, parser_version, snapshot_json,
                        total_tokens, total_messages
                 FROM agent_usage_sessions
                 WHERE agent = ?1",
            )
            .map_err(|error| format!("准备读取 {agent} 用量账本失败: {error}"))?;
        let rows = statement
            .query_map([agent], |row| {
                let total_tokens = row.get::<_, i64>(4)?;
                let total_messages = row.get::<_, i64>(5)?;
                Ok(AgentUsageStoredSession {
                    session_key: row.get(0)?,
                    source_fingerprint: row.get(1)?,
                    parser_version: row.get(2)?,
                    snapshot_json: row.get(3)?,
                    total_tokens: total_tokens.max(0) as u64,
                    total_messages: total_messages.max(0) as u64,
                })
            })
            .map_err(|error| format!("读取 {agent} 用量账本失败: {error}"))?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("解析 {agent} 用量账本失败: {error}"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_agent_usage_session(
        &self,
        agent: &str,
        session_key: &str,
        source_fingerprint: &str,
        parser_version: i64,
        snapshot_json: &str,
        total_tokens: u64,
        total_messages: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO agent_usage_sessions (
                agent, session_key, source_fingerprint, parser_version, snapshot_json,
                total_tokens, total_messages, first_seen_at_ms, last_seen_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
             ON CONFLICT(agent, session_key) DO UPDATE SET
                source_fingerprint = excluded.source_fingerprint,
                parser_version = excluded.parser_version,
                snapshot_json = excluded.snapshot_json,
                total_tokens = excluded.total_tokens,
                total_messages = excluded.total_messages,
                last_seen_at_ms = excluded.last_seen_at_ms,
                updated_at_ms = excluded.updated_at_ms",
            params![
                agent,
                session_key,
                source_fingerprint,
                parser_version,
                snapshot_json,
                u64_to_sqlite_integer(total_tokens),
                u64_to_sqlite_integer(total_messages),
                now_ms,
            ],
        )
        .map_err(|error| format!("保存 {agent} 匿名用量快照失败: {error}"))?;
        Ok(())
    }

    pub fn mark_agent_usage_sync(
        &self,
        agent: &str,
        synced_at_ms: i64,
        last_error: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO agent_usage_control (agent, last_synced_at_ms, last_error)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(agent) DO UPDATE SET
                last_synced_at_ms = excluded.last_synced_at_ms,
                last_error = excluded.last_error",
            params![agent, synced_at_ms, last_error],
        )
        .map_err(|error| format!("更新 {agent} 用量同步状态失败: {error}"))?;
        Ok(())
    }

    pub fn clear_agent_usage_history_at(
        &self,
        agent: Option<&str>,
        cleared_at_ms: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let transaction = conn
            .transaction()
            .map_err(|error| format!("开始清除用量历史事务失败: {error}"))?;

        match agent {
            Some(agent) => {
                transaction
                    .execute("DELETE FROM agent_usage_sessions WHERE agent = ?1", [agent])
                    .map_err(|error| format!("清除 {agent} 用量历史失败: {error}"))?;
                transaction
                    .execute(
                        "INSERT INTO agent_usage_control (
                            agent, cleared_at_ms, last_synced_at_ms, last_error
                         ) VALUES (?1, ?2, NULL, NULL)
                         ON CONFLICT(agent) DO UPDATE SET
                            cleared_at_ms = excluded.cleared_at_ms,
                            last_synced_at_ms = NULL,
                            last_error = NULL",
                        params![agent, cleared_at_ms],
                    )
                    .map_err(|error| format!("保存 {agent} 用量清除截止线失败: {error}"))?;
            }
            None => {
                transaction
                    .execute("DELETE FROM agent_usage_sessions", [])
                    .map_err(|error| format!("清除全部用量历史失败: {error}"))?;
                transaction
                    .execute(
                        "UPDATE agent_usage_control
                         SET cleared_at_ms = ?1, last_synced_at_ms = NULL, last_error = NULL",
                        [cleared_at_ms],
                    )
                    .map_err(|error| format!("更新全部用量清除截止线失败: {error}"))?;
                transaction
                    .execute(
                        "INSERT INTO agent_usage_control (
                            agent, cleared_at_ms, last_synced_at_ms, last_error
                         ) VALUES ('codex', ?1, NULL, NULL)
                         ON CONFLICT(agent) DO UPDATE SET
                            cleared_at_ms = excluded.cleared_at_ms,
                            last_synced_at_ms = NULL,
                            last_error = NULL",
                        [cleared_at_ms],
                    )
                    .map_err(|error| format!("保存 Codex 用量清除截止线失败: {error}"))?;
            }
        }

        transaction
            .commit()
            .map_err(|error| format!("提交用量历史清除事务失败: {error}"))
    }

    pub fn rebuild_agent_usage_history(&self, agent: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock();
        match agent {
            Some(agent) => {
                conn.execute("DELETE FROM agent_usage_sessions WHERE agent = ?1", [agent])
                    .map_err(|error| format!("重建前清除 {agent} 用量账本失败: {error}"))?;
                conn.execute(
                    "UPDATE agent_usage_control
                     SET last_synced_at_ms = NULL, last_error = NULL
                     WHERE agent = ?1",
                    [agent],
                )
                .map_err(|error| format!("重置 {agent} 用量同步状态失败: {error}"))?;
            }
            None => {
                conn.execute("DELETE FROM agent_usage_sessions", [])
                    .map_err(|error| format!("重建前清除全部用量账本失败: {error}"))?;
                conn.execute(
                    "UPDATE agent_usage_control SET last_synced_at_ms = NULL, last_error = NULL",
                    [],
                )
                .map_err(|error| format!("重置全部用量同步状态失败: {error}"))?;
            }
        }
        Ok(())
    }

    pub fn get_agent_usage_storage_status(
        &self,
        agent: &str,
    ) -> Result<AgentUsageStorageStatus, String> {
        let conn = self.conn.lock();
        let retained_sessions = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_usage_sessions
                 WHERE agent = ?1 AND (total_tokens > 0 OR total_messages > 0)",
                [agent],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("统计 {agent} 已保留会话失败: {error}"))?;
        let control = conn
            .query_row(
                "SELECT cleared_at_ms, last_synced_at_ms, last_error
                 FROM agent_usage_control WHERE agent = ?1",
                [agent],
                |row| {
                    Ok(AgentUsageControlState {
                        cleared_at_ms: row.get(0)?,
                        last_synced_at_ms: row.get(1)?,
                        last_error: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("读取 {agent} 用量状态失败: {error}"))?
            .unwrap_or_default();

        Ok(AgentUsageStorageStatus {
            agent: agent.to_string(),
            retained_sessions: retained_sessions.max(0) as u64,
            last_synced_at_ms: control.last_synced_at_ms,
            cleared_at_ms: control.cleared_at_ms,
            last_error: control.last_error,
        })
    }
}

fn u64_to_sqlite_integer(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn read_setting<T>(conn: &Connection, key: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
{
    let raw_value = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取设置 {key} 失败: {error}"))?;

    raw_value
        .map(|value| {
            serde_json::from_str::<T>(&value)
                .map_err(|error| format!("解析设置 {key} 失败: {error}"))
        })
        .transpose()
}

fn write_setting<T>(conn: &Connection, key: &str, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let serialized =
        serde_json::to_string(value).map_err(|error| format!("序列化设置 {key} 失败: {error}"))?;
    let now = chrono::Utc::now().timestamp_millis();

    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at_ms = excluded.updated_at_ms",
        params![key, serialized, now],
    )
    .map_err(|error| format!("保存设置 {key} 失败: {error}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Database, PersistentSettingsRecord};

    #[test]
    fn persistent_settings_default_to_beijing_asr_region() {
        assert_eq!(PersistentSettingsRecord::default().asr_region, "beijing");
    }

    #[test]
    fn persistent_settings_default_project_open_behavior_asks() {
        assert_eq!(
            PersistentSettingsRecord::default().project_open_behavior,
            "ask"
        );
    }

    #[test]
    fn persistent_settings_without_asr_region_remain_backward_compatible() {
        let mut value = serde_json::to_value(PersistentSettingsRecord::default()).unwrap();
        value.as_object_mut().unwrap().remove("asrRegion");

        let restored: PersistentSettingsRecord = serde_json::from_value(value).unwrap();

        assert_eq!(restored.asr_region, "beijing");
    }

    #[test]
    fn runtime_settings_cannot_overwrite_the_last_closed_project() {
        let database = Database::open_in_memory();
        let mut initial = PersistentSettingsRecord::default();
        initial.last_project_path = Some("D:/projects/initial".to_string());
        database.save_persistent_settings(&initial).unwrap();

        database
            .save_last_project_path("E:/7.project/git/renmin")
            .unwrap();

        let mut competing_window = initial;
        competing_window.last_project_path = Some("D:/3.project/Termflow".to_string());
        competing_window.language = "en-US".to_string();
        database
            .save_persistent_settings_without_last_project(&competing_window)
            .unwrap();

        let restored = database.load_persistent_settings().unwrap();
        assert_eq!(
            restored.last_project_path.as_deref(),
            Some("E:/7.project/git/renmin")
        );
        assert_eq!(restored.language, "en-US");
    }
}
