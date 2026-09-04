pub mod schema;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::BTreeMap, fs, sync::Arc};
use tauri::{AppHandle, Manager};

use crate::network_proxy::{default_no_proxy, default_proxy_mode, NetworkProxySettings};

const DATABASE_FILE_NAME: &str = "termflow.db";
const SEARCH_INDEX_PROJECT_PREFERENCES_KEY: &str = "searchIndex.projectPreferences";
const SEARCH_INDEX_STORAGE_KEY: &str = "searchIndex.storage";
pub const DEFAULT_SEARCH_INDEX_QUOTA_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexStorageSettings {
    #[serde(default)]
    pub cache_root: Option<String>,
    #[serde(default = "default_search_index_quota_bytes")]
    pub quota_bytes: u64,
}

fn default_search_index_quota_bytes() -> u64 {
    DEFAULT_SEARCH_INDEX_QUOTA_BYTES
}

impl Default for SearchIndexStorageSettings {
    fn default() -> Self {
        Self {
            cache_root: None,
            quota_bytes: default_search_index_quota_bytes(),
        }
    }
}

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

fn default_terminal_scrollback() -> i64 {
    5_000
}

fn default_editor_font_size() -> i64 {
    14
}

fn default_project_open_behavior() -> String {
    "ask".into()
}

fn default_explorer_context_menu_enabled() -> bool {
    true
}

fn default_feishu_notification_threshold_ms() -> i64 {
    300_000
}

fn default_agent_permission_defaults() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

fn default_remote_notifications() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

fn default_git_commit_message_profiles() -> serde_json::Value {
    serde_json::json!([
        {
            "id": "conventional-zh-full",
            "name": "默认",
            "instructions": "使用中文生成 Conventional Commit。第一行为 type(scope): summary 风格标题，标题后空一行，再输出 2-4 条以 `- ` 开头的正文要点。"
        },
        {
            "id": "concise-en-title",
            "name": "精简",
            "instructions": "只输出一行简洁的英文 Conventional Commit 标题，不要正文，标题尽量控制在 72 个字符以内。"
        },
        {
            "id": "team-standard",
            "name": "团队规范",
            "instructions": "使用 type(scope): subject 格式；标题使用中文，正文固定为“变更内容”和“影响范围”两个要点，不要添加无法从变更概览确认的信息。"
        },
        {
            "id": "emoji",
            "name": "Emoji",
            "instructions": "在 Conventional Commit 标题前添加一个最符合改动类型的 Emoji，例如 ✨ feat:、🐛 fix: 或 📝 docs:；正文使用中文并保持简洁。"
        }
    ])
}

fn default_git_commit_message_profile_id() -> String {
    "conventional-zh-full".into()
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
    #[serde(default = "default_proxy_mode")]
    pub network_proxy_mode: String,
    #[serde(default)]
    pub network_custom_proxy_url: String,
    #[serde(default = "default_no_proxy")]
    pub network_no_proxy: String,
    pub startup_restore_last_project: bool,
    #[serde(default = "default_explorer_context_menu_enabled")]
    pub explorer_context_menu_enabled: bool,
    #[serde(default = "default_project_open_behavior")]
    pub project_open_behavior: String,
    pub last_project_path: Option<String>,
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: i64,
    pub terminal_font_size: i64,
    pub terminal_cursor_blink: bool,
    pub terminal_line_height: f64,
    #[serde(default = "default_terminal_scrollback")]
    pub terminal_scrollback: i64,
    #[serde(default = "default_terminal_renderer")]
    pub terminal_renderer: String,
    #[serde(default = "default_agent_permission_defaults")]
    pub agent_permission_defaults: serde_json::Value,
    pub notification_enabled: bool,
    pub notification_sound_enabled: bool,
    pub notification_sound_map: NotificationSoundMapRecord,
    pub notification_threshold_ms: i64,
    #[serde(default = "default_remote_notifications")]
    pub remote_notifications: serde_json::Value,
    // Kept in sync with `remote_notifications.feishu` for databases and
    // clients that still use the pre-channel notification fields.
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
    #[serde(default = "default_git_commit_message_profiles")]
    pub git_commit_message_profiles: serde_json::Value,
    #[serde(default = "default_git_commit_message_profile_id")]
    pub default_git_commit_message_profile_id: String,
}

impl Default for PersistentSettingsRecord {
    fn default() -> Self {
        Self {
            light_theme: "light-glass".into(),
            dark_theme: "dark-starry".into(),
            theme_category: "dark".into(),
            language: "zh_CN".into(),
            network_proxy_mode: default_proxy_mode(),
            network_custom_proxy_url: String::new(),
            network_no_proxy: default_no_proxy(),
            startup_restore_last_project: true,
            explorer_context_menu_enabled: default_explorer_context_menu_enabled(),
            project_open_behavior: default_project_open_behavior(),
            last_project_path: None,
            editor_font_size: default_editor_font_size(),
            terminal_font_size: 14,
            terminal_cursor_blink: true,
            terminal_line_height: 1.2,
            terminal_scrollback: default_terminal_scrollback(),
            terminal_renderer: default_terminal_renderer(),
            agent_permission_defaults: default_agent_permission_defaults(),
            notification_enabled: true,
            notification_sound_enabled: true,
            notification_sound_map: NotificationSoundMapRecord::default(),
            notification_threshold_ms: 10_000,
            remote_notifications: default_remote_notifications(),
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
            git_commit_message_profiles: default_git_commit_message_profiles(),
            default_git_commit_message_profile_id: default_git_commit_message_profile_id(),
        }
    }
}

impl PersistentSettingsRecord {
    pub fn network_proxy_settings(&self) -> NetworkProxySettings {
        NetworkProxySettings {
            mode: self.network_proxy_mode.clone(),
            custom_proxy_url: self.network_custom_proxy_url.clone(),
            no_proxy: self.network_no_proxy.clone(),
        }
    }
}

fn legacy_feishu_notification_values(
    settings: &PersistentSettingsRecord,
) -> (bool, i64, FeishuNotificationEventsRecord) {
    let Some(channel) = settings
        .remote_notifications
        .get("feishu")
        .and_then(serde_json::Value::as_object)
    else {
        return (
            settings.feishu_notification_enabled,
            settings.feishu_notification_threshold_ms,
            settings.feishu_notification_events.clone(),
        );
    };

    let mut events = settings.feishu_notification_events.clone();
    if let Some(event_values) = channel.get("events").and_then(serde_json::Value::as_object) {
        if let Some(value) = event_values
            .get("completed")
            .and_then(serde_json::Value::as_bool)
        {
            events.completed = value;
        }
        if let Some(value) = event_values
            .get("error")
            .and_then(serde_json::Value::as_bool)
        {
            events.error = value;
        }
        if let Some(value) = event_values
            .get("waiting")
            .and_then(serde_json::Value::as_bool)
        {
            events.waiting = value;
        }
        if let Some(value) = event_values
            .get("permission")
            .and_then(serde_json::Value::as_bool)
        {
            events.permission = value;
        }
    }

    (
        channel
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(settings.feishu_notification_enabled),
        channel
            .get("thresholdMs")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value >= 0)
            .unwrap_or(settings.feishu_notification_threshold_ms),
        events,
    )
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
        settings.network_proxy_mode =
            read_setting(&conn, "network.proxyMode")?.unwrap_or(settings.network_proxy_mode);
        settings.network_custom_proxy_url = read_setting(&conn, "network.customProxyUrl")?
            .unwrap_or(settings.network_custom_proxy_url);
        settings.network_no_proxy =
            read_setting(&conn, "network.noProxy")?.unwrap_or(settings.network_no_proxy);
        settings.startup_restore_last_project =
            read_setting(&conn, "general.startupRestoreLastProject")?
                .unwrap_or(settings.startup_restore_last_project);
        settings.explorer_context_menu_enabled =
            read_setting(&conn, "general.explorerContextMenuEnabled")?
                .unwrap_or(settings.explorer_context_menu_enabled);
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
        settings.terminal_scrollback =
            read_setting(&conn, "terminal.scrollback")?.unwrap_or(settings.terminal_scrollback);
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
        settings.remote_notifications = read_setting(&conn, "notification.remoteNotifications")?
            .unwrap_or(settings.remote_notifications);
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
        settings.git_commit_message_profiles = read_setting(&conn, "git.commitMessageProfiles")?
            .unwrap_or(settings.git_commit_message_profiles);
        settings.default_git_commit_message_profile_id =
            read_setting(&conn, "git.defaultCommitMessageProfileId")?
                .unwrap_or(settings.default_git_commit_message_profile_id);

        Ok(settings)
    }

    pub fn save_persistent_settings(
        &self,
        settings: &PersistentSettingsRecord,
    ) -> Result<(), String> {
        self.save_persistent_settings_internal(settings, true, true)
    }

    /// Saves preferences owned by the settings UI without overwriting values
    /// that are changed by dedicated runtime workflows. In particular, an
    /// in-flight save from another project window cannot undo the last closed
    /// project or the Explorer context-menu opt-out.
    pub fn save_general_persistent_settings(
        &self,
        settings: &PersistentSettingsRecord,
    ) -> Result<(), String> {
        self.save_persistent_settings_internal(settings, false, false)
    }

    pub fn save_last_project_path(&self, project_path: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        write_setting(
            &conn,
            "general.lastProjectPath",
            &Some(project_path.to_string()),
        )
    }

    pub fn load_explorer_context_menu_enabled(&self) -> Result<bool, String> {
        let conn = self.conn.lock();
        Ok(read_setting(&conn, "general.explorerContextMenuEnabled")?
            .unwrap_or_else(default_explorer_context_menu_enabled))
    }

    pub fn save_explorer_context_menu_enabled(&self, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock();
        write_setting(&conn, "general.explorerContextMenuEnabled", &enabled)
    }

    pub fn load_project_search_index_enabled(&self, project_key: &str) -> Result<bool, String> {
        let conn = self.conn.lock();
        let preferences =
            read_setting::<BTreeMap<String, bool>>(&conn, SEARCH_INDEX_PROJECT_PREFERENCES_KEY)?
                .unwrap_or_default();
        Ok(preferences.get(project_key).copied().unwrap_or(false))
    }

    pub fn save_project_search_index_enabled(
        &self,
        project_key: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        let mut preferences =
            read_setting::<BTreeMap<String, bool>>(&conn, SEARCH_INDEX_PROJECT_PREFERENCES_KEY)?
                .unwrap_or_default();
        preferences.insert(project_key.to_string(), enabled);
        write_setting(&conn, SEARCH_INDEX_PROJECT_PREFERENCES_KEY, &preferences)
    }

    pub fn load_search_index_storage(&self) -> Result<SearchIndexStorageSettings, String> {
        let conn = self.conn.lock();
        Ok(read_setting(&conn, SEARCH_INDEX_STORAGE_KEY)?.unwrap_or_default())
    }

    pub fn save_search_index_storage(
        &self,
        settings: &SearchIndexStorageSettings,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        write_setting(&conn, SEARCH_INDEX_STORAGE_KEY, settings)
    }

    fn save_persistent_settings_internal(
        &self,
        settings: &PersistentSettingsRecord,
        include_last_project: bool,
        include_explorer_context_menu: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock();

        write_setting(&conn, "theme.lightTheme", &settings.light_theme)?;
        write_setting(&conn, "theme.darkTheme", &settings.dark_theme)?;
        write_setting(&conn, "theme.themeCategory", &settings.theme_category)?;
        write_setting(&conn, "general.language", &settings.language)?;
        write_setting(&conn, "network.proxyMode", &settings.network_proxy_mode)?;
        write_setting(
            &conn,
            "network.customProxyUrl",
            &settings.network_custom_proxy_url,
        )?;
        write_setting(&conn, "network.noProxy", &settings.network_no_proxy)?;
        write_setting(
            &conn,
            "general.startupRestoreLastProject",
            &settings.startup_restore_last_project,
        )?;
        if include_explorer_context_menu {
            write_setting(
                &conn,
                "general.explorerContextMenuEnabled",
                &settings.explorer_context_menu_enabled,
            )?;
        }
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
        write_setting(&conn, "terminal.scrollback", &settings.terminal_scrollback)?;
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
            "notification.remoteNotifications",
            &settings.remote_notifications,
        )?;
        let (feishu_enabled, feishu_threshold_ms, feishu_events) =
            legacy_feishu_notification_values(settings);
        write_setting(&conn, "notification.feishu.enabled", &feishu_enabled)?;
        write_setting(
            &conn,
            "notification.feishu.thresholdMs",
            &feishu_threshold_ms,
        )?;
        write_setting(&conn, "notification.feishu.events", &feishu_events)?;
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
        write_setting(
            &conn,
            "git.commitMessageProfiles",
            &settings.git_commit_message_profiles,
        )?;
        write_setting(
            &conn,
            "git.defaultCommitMessageProfileId",
            &settings.default_git_commit_message_profile_id,
        )?;

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
    use super::{
        Database, PersistentSettingsRecord, SearchIndexStorageSettings,
        DEFAULT_SEARCH_INDEX_QUOTA_BYTES,
    };

    #[test]
    fn persistent_settings_default_to_beijing_asr_region() {
        assert_eq!(PersistentSettingsRecord::default().asr_region, "beijing");
    }

    #[test]
    fn persistent_settings_default_to_system_proxy() {
        let settings = PersistentSettingsRecord::default();
        assert_eq!(settings.network_proxy_mode, "system");
        assert_eq!(settings.network_no_proxy, "localhost,127.0.0.1,::1");
    }

    #[test]
    fn persistent_settings_without_network_proxy_remain_backward_compatible() {
        let mut value = serde_json::to_value(PersistentSettingsRecord::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("networkProxyMode");
        object.remove("networkCustomProxyUrl");
        object.remove("networkNoProxy");
        let restored: PersistentSettingsRecord = serde_json::from_value(value).unwrap();
        assert_eq!(restored.network_proxy_mode, "system");
        assert_eq!(restored.network_custom_proxy_url, "");
        assert_eq!(restored.network_no_proxy, "localhost,127.0.0.1,::1");
    }

    #[test]
    fn network_proxy_settings_round_trip_through_the_database() {
        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        settings.network_proxy_mode = "custom".into();
        settings.network_custom_proxy_url = "http://127.0.0.1:7897".into();
        settings.network_no_proxy = "localhost,example.test".into();
        database.save_persistent_settings(&settings).unwrap();

        let restored = database.load_persistent_settings().unwrap();
        assert_eq!(restored.network_proxy_mode, "custom");
        assert_eq!(restored.network_custom_proxy_url, "http://127.0.0.1:7897");
        assert_eq!(restored.network_no_proxy, "localhost,example.test");
    }

    #[test]
    fn persistent_settings_default_project_open_behavior_asks() {
        assert_eq!(
            PersistentSettingsRecord::default().project_open_behavior,
            "ask"
        );
    }

    #[test]
    fn persistent_settings_default_to_enabled_explorer_context_menu() {
        assert!(PersistentSettingsRecord::default().explorer_context_menu_enabled);
    }

    #[test]
    fn persistent_settings_default_to_five_thousand_scrollback_rows() {
        assert_eq!(
            PersistentSettingsRecord::default().terminal_scrollback,
            5_000
        );
    }

    #[test]
    fn persistent_settings_without_scrollback_remain_backward_compatible() {
        let mut value = serde_json::to_value(PersistentSettingsRecord::default()).unwrap();
        value.as_object_mut().unwrap().remove("terminalScrollback");

        let restored: PersistentSettingsRecord = serde_json::from_value(value).unwrap();

        assert_eq!(restored.terminal_scrollback, 5_000);
    }

    #[test]
    fn persistent_settings_without_remote_notifications_remain_backward_compatible() {
        let mut value = serde_json::to_value(PersistentSettingsRecord::default()).unwrap();
        value.as_object_mut().unwrap().remove("remoteNotifications");

        let restored: PersistentSettingsRecord = serde_json::from_value(value).unwrap();

        assert_eq!(
            restored.remote_notifications,
            serde_json::Value::Object(Default::default())
        );
    }

    #[test]
    fn git_commit_message_profiles_remain_backward_compatible_and_round_trip() {
        let mut legacy_value = serde_json::to_value(PersistentSettingsRecord::default()).unwrap();
        let legacy_object = legacy_value.as_object_mut().unwrap();
        legacy_object.remove("gitCommitMessageProfiles");
        legacy_object.remove("defaultGitCommitMessageProfileId");

        let restored_legacy: PersistentSettingsRecord =
            serde_json::from_value(legacy_value).unwrap();
        assert_eq!(
            restored_legacy.default_git_commit_message_profile_id,
            "conventional-zh-full"
        );
        assert_eq!(
            restored_legacy
                .git_commit_message_profiles
                .as_array()
                .unwrap()
                .len(),
            4
        );

        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        settings.git_commit_message_profiles = serde_json::json!([
            { "id": "custom", "name": "Custom", "instructions": "One line only" }
        ]);
        settings.default_git_commit_message_profile_id = "custom".into();
        database.save_persistent_settings(&settings).unwrap();

        let restored = database.load_persistent_settings().unwrap();
        assert_eq!(restored.default_git_commit_message_profile_id, "custom");
        assert_eq!(
            restored.git_commit_message_profiles,
            settings.git_commit_message_profiles
        );
    }

    #[test]
    fn terminal_scrollback_preference_round_trips_through_the_database() {
        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        settings.terminal_scrollback = 20_000;

        database.save_persistent_settings(&settings).unwrap();

        assert_eq!(
            database
                .load_persistent_settings()
                .unwrap()
                .terminal_scrollback,
            20_000
        );
    }

    #[test]
    fn remote_notification_channels_round_trip_and_sync_legacy_feishu_fields() {
        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        let remote_notifications = serde_json::json!({
            "feishu": {
                "enabled": true,
                "thresholdMs": 600_000,
                "events": { "completed": false, "error": true, "waiting": false, "permission": true }
            },
            "dingtalk": {
                "enabled": true,
                "thresholdMs": 100,
                "events": { "completed": true, "error": false, "waiting": true, "permission": false }
            },
            "wechat": {
                "enabled": false,
                "thresholdMs": 200,
                "events": { "completed": false, "error": true, "waiting": true, "permission": false }
            },
            "qq": {
                "enabled": true,
                "thresholdMs": 300,
                "events": { "completed": true, "error": true, "waiting": false, "permission": false }
            },
            "telegram": {
                "enabled": false,
                "thresholdMs": 400,
                "events": { "completed": false, "error": false, "waiting": true, "permission": true }
            }
        });
        settings.remote_notifications = remote_notifications.clone();

        database
            .save_general_persistent_settings(&settings)
            .unwrap();

        let restored = database.load_persistent_settings().unwrap();
        assert_eq!(restored.remote_notifications, remote_notifications);
        assert!(restored.feishu_notification_enabled);
        assert_eq!(restored.feishu_notification_threshold_ms, 600_000);
        assert!(!restored.feishu_notification_events.completed);
        assert!(restored.feishu_notification_events.error);
        assert!(!restored.feishu_notification_events.waiting);
        assert!(restored.feishu_notification_events.permission);
    }

    #[test]
    fn persistent_settings_without_explorer_context_menu_remain_backward_compatible() {
        let mut value = serde_json::to_value(PersistentSettingsRecord::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("explorerContextMenuEnabled");

        let restored: PersistentSettingsRecord = serde_json::from_value(value).unwrap();

        assert!(restored.explorer_context_menu_enabled);
    }

    #[test]
    fn explorer_context_menu_preference_can_be_saved_without_other_settings() {
        let database = Database::open_in_memory();
        let mut initial = PersistentSettingsRecord::default();
        initial.language = "en-US".to_string();
        initial.project_open_behavior = "reuse".to_string();
        database.save_persistent_settings(&initial).unwrap();

        database.save_explorer_context_menu_enabled(false).unwrap();

        assert!(!database.load_explorer_context_menu_enabled().unwrap());
        let restored = database.load_persistent_settings().unwrap();
        assert_eq!(restored.language, "en-US");
        assert_eq!(restored.project_open_behavior, "reuse");
    }

    #[test]
    fn general_runtime_saves_cannot_overwrite_explorer_context_menu_preference() {
        let database = Database::open_in_memory();
        let mut initial = PersistentSettingsRecord::default();
        initial.explorer_context_menu_enabled = false;
        database.save_persistent_settings(&initial).unwrap();

        let mut stale_window_settings = PersistentSettingsRecord::default();
        stale_window_settings.explorer_context_menu_enabled = true;
        stale_window_settings.language = "en-US".to_string();
        database
            .save_general_persistent_settings(&stale_window_settings)
            .unwrap();

        let restored = database.load_persistent_settings().unwrap();
        assert!(!restored.explorer_context_menu_enabled);
        assert_eq!(restored.language, "en-US");
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
            .save_general_persistent_settings(&competing_window)
            .unwrap();

        let restored = database.load_persistent_settings().unwrap();
        assert_eq!(
            restored.last_project_path.as_deref(),
            Some("E:/7.project/git/renmin")
        );
        assert_eq!(restored.language, "en-US");
    }

    #[test]
    fn project_search_index_preferences_default_off_and_preserve_explicit_overrides() {
        let database = Database::open_in_memory();

        assert!(!database
            .load_project_search_index_enabled("e:/projects/termflow")
            .unwrap());

        database
            .save_project_search_index_enabled("e:/projects/termflow", true)
            .unwrap();
        database
            .save_project_search_index_enabled("e:/projects/other", false)
            .unwrap();

        assert!(database
            .load_project_search_index_enabled("e:/projects/termflow")
            .unwrap());
        assert!(!database
            .load_project_search_index_enabled("e:/projects/other")
            .unwrap());
    }

    #[test]
    fn search_index_storage_defaults_and_persists() {
        let database = Database::open_in_memory();
        let defaults = database.load_search_index_storage().unwrap();
        assert_eq!(defaults.cache_root, None);
        assert_eq!(defaults.quota_bytes, DEFAULT_SEARCH_INDEX_QUOTA_BYTES);

        let configured = SearchIndexStorageSettings {
            cache_root: Some("D:/Termflow Search Index".to_string()),
            quota_bytes: 2 * 1024 * 1024 * 1024,
        };
        database.save_search_index_storage(&configured).unwrap();

        let restored = database.load_search_index_storage().unwrap();
        assert_eq!(restored.cache_root, configured.cache_root);
        assert_eq!(restored.quota_bytes, configured.quota_bytes);
    }
}
