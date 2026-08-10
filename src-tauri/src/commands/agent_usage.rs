use super::claude_config::{self, AgentUsageOverview, AggregatedTranscriptStats};
use crate::database::{AgentUsageStorageStatus, AgentUsageStoredSession, Database};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::UNIX_EPOCH;
use tauri::State;

const CODEX_AGENT_ID: &str = "codex";
const CODEX_USAGE_PARSER_VERSION: i64 = 1;
static CODEX_USAGE_SYNC_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn get_agent_usage_overview(
    database: State<'_, Arc<Database>>,
) -> Result<AgentUsageOverview, String> {
    let codex_usage = sync_codex_usage_history(&database);
    Ok(claude_config::build_agent_usage_overview(codex_usage))
}

#[tauri::command]
pub fn get_agent_usage_storage_status(
    database: State<'_, Arc<Database>>,
) -> Result<AgentUsageStorageStatus, String> {
    database.get_agent_usage_storage_status(CODEX_AGENT_ID)
}

#[tauri::command]
pub fn clear_agent_usage_history(
    database: State<'_, Arc<Database>>,
    scope: String,
) -> Result<AgentUsageStorageStatus, String> {
    let _guard = lock_codex_usage_sync()?;
    let agent = usage_scope_agent(&scope)?;
    database.clear_agent_usage_history_at(agent, Utc::now().timestamp_millis())?;
    database.get_agent_usage_storage_status(CODEX_AGENT_ID)
}

#[tauri::command]
pub fn rebuild_agent_usage_history(
    database: State<'_, Arc<Database>>,
    scope: String,
) -> Result<AgentUsageStorageStatus, String> {
    let _guard = lock_codex_usage_sync()?;
    let agent = usage_scope_agent(&scope)?;
    database.rebuild_agent_usage_history(agent)?;
    sync_codex_usage_files_unlocked(&database, collect_codex_session_files())?;
    database.get_agent_usage_storage_status(CODEX_AGENT_ID)
}

fn usage_scope_agent(scope: &str) -> Result<Option<&'static str>, String> {
    match scope {
        "codex" => Ok(Some(CODEX_AGENT_ID)),
        "all" => Ok(None),
        _ => Err("无效的用量历史范围".to_string()),
    }
}

fn lock_codex_usage_sync() -> Result<MutexGuard<'static, ()>, String> {
    CODEX_USAGE_SYNC_LOCK
        .lock()
        .map_err(|_| "Codex 用量同步锁已损坏".to_string())
}

fn anonymized_session_key(salt: &str, source_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update([0]);
    hasher.update(CODEX_AGENT_ID.as_bytes());
    hasher.update([0]);
    hasher.update(source_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn source_fingerprint(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("读取 Codex 用量日志元数据失败: {error}"))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    Ok(format!("{}:{modified_nanos}", metadata.len()))
}

fn load_persisted_codex_stats(
    database: &Database,
) -> Result<(AggregatedTranscriptStats, Vec<String>), String> {
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut warnings = Vec::new();
    for stored in database.load_agent_usage_sessions(CODEX_AGENT_ID)? {
        match serde_json::from_str::<AggregatedTranscriptStats>(&stored.snapshot_json) {
            Ok(stats) => claude_config::merge_aggregated_stats(&mut aggregate, stats),
            Err(error) => warnings.push(format!("忽略一条损坏的 Codex 匿名用量快照: {error}")),
        }
    }
    Ok((aggregate, warnings))
}

fn sync_codex_usage_history(database: &Database) -> Result<AggregatedTranscriptStats, String> {
    let _guard = lock_codex_usage_sync()?;
    sync_codex_usage_files_unlocked(database, collect_codex_session_files())
}

#[cfg(test)]
fn sync_codex_usage_files(
    database: &Database,
    files: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    let _guard = lock_codex_usage_sync()?;
    sync_codex_usage_files_unlocked(database, files)
}

fn sync_codex_usage_files_unlocked(
    database: &Database,
    files: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    let salt = database.get_or_create_usage_salt()?;
    let control = database.load_agent_usage_control(CODEX_AGENT_ID)?;
    let stored_sessions = database.load_agent_usage_sessions(CODEX_AGENT_ID)?;
    let mut stored_by_key = stored_sessions
        .into_iter()
        .map(|session| (session.session_key.clone(), session))
        .collect::<BTreeMap<_, _>>();
    let mut warnings = Vec::new();
    let now_ms = Utc::now().timestamp_millis();

    for path in files {
        let source_key = codex_session_file_key(&path);
        let session_key = anonymized_session_key(&salt, &source_key);
        let fingerprint = match source_fingerprint(&path) {
            Ok(value) => value,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };

        if stored_by_key.get(&session_key).is_some_and(|stored| {
            stored.parser_version == CODEX_USAGE_PARSER_VERSION
                && stored.source_fingerprint == fingerprint
        }) {
            continue;
        }

        let stats =
            match claude_config::build_codex_usage_session_stats(&path, control.cleared_at_ms) {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(error);
                    continue;
                }
            };
        let total_tokens = stats.total_tokens();
        let total_messages = stats.total_messages();

        if stored_by_key.get(&session_key).is_some_and(|stored| {
            stored.parser_version == CODEX_USAGE_PARSER_VERSION
                && (total_tokens < stored.total_tokens || total_messages < stored.total_messages)
        }) {
            warnings.push("Codex 用量日志出现回退，已保留上次成功快照".to_string());
            continue;
        }

        let snapshot_json = serde_json::to_string(&stats)
            .map_err(|error| format!("序列化 Codex 匿名用量快照失败: {error}"))?;
        database.upsert_agent_usage_session(
            CODEX_AGENT_ID,
            &session_key,
            &fingerprint,
            CODEX_USAGE_PARSER_VERSION,
            &snapshot_json,
            total_tokens,
            total_messages,
            now_ms,
        )?;
        stored_by_key.insert(
            session_key.clone(),
            AgentUsageStoredSession {
                session_key,
                source_fingerprint: fingerprint,
                parser_version: CODEX_USAGE_PARSER_VERSION,
                snapshot_json,
                total_tokens,
                total_messages,
            },
        );
    }

    let (aggregate, stored_warnings) = load_persisted_codex_stats(database)?;
    warnings.extend(stored_warnings);
    let warning = if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("；"))
    };
    database.mark_agent_usage_sync(CODEX_AGENT_ID, now_ms, warning.as_deref())?;
    Ok(aggregate)
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_jsonl_files(&path, output);
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            output.push(path);
        }
    }
}

fn termflow_user_data_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) = env::var_os("TERMFLOW_USER_DATA_PATH").filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value));
    }
    if cfg!(windows) {
        if let Some(value) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            let app_data = PathBuf::from(value);
            paths.push(app_data.join("com.termflow.desktop"));
            paths.push(app_data.join("Termflow"));
        } else if let Some(home_dir) = dirs_next::home_dir() {
            paths.push(
                home_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("com.termflow.desktop"),
            );
            paths.push(home_dir.join("AppData").join("Roaming").join("Termflow"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home_dir) = dirs_next::home_dir() {
            paths.push(
                home_dir
                    .join("Library")
                    .join("Application Support")
                    .join("com.termflow.desktop"),
            );
            paths.push(
                home_dir
                    .join("Library")
                    .join("Application Support")
                    .join("Termflow"),
            );
        }
    } else if let Some(value) = env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        let xdg_config = PathBuf::from(value);
        paths.push(xdg_config.join("com.termflow.desktop"));
        paths.push(xdg_config.join("termflow"));
    } else if let Some(home_dir) = dirs_next::home_dir() {
        paths.push(home_dir.join(".config").join("com.termflow.desktop"));
        paths.push(home_dir.join(".config").join("termflow"));
    }
    paths
}

fn termflow_managed_codex_home_paths() -> Vec<PathBuf> {
    termflow_user_data_paths()
        .into_iter()
        .map(|path| path.join("codex-runtime-home").join("home"))
        .collect()
}

fn path_dedupe_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        key.to_ascii_lowercase()
    } else {
        key
    }
}

fn codex_session_file_key(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| format!("session:{value}"))
        .unwrap_or_else(|| format!("path:{}", path_dedupe_key(path)))
}

fn collect_codex_session_files_from_homes(homes: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique_homes = Vec::new();
    let mut seen_homes = BTreeSet::new();
    for home in homes {
        if seen_homes.insert(path_dedupe_key(&home)) {
            unique_homes.push(home);
        }
    }

    let mut files = Vec::new();
    let mut seen_roots = BTreeSet::new();
    let mut seen_files = BTreeSet::new();

    // Scan every active root before archived roots. If a session temporarily
    // exists in both locations (for example during archive/unarchive), the
    // active rollout is authoritative and the session is still counted once.
    for directory_name in ["sessions", "archived_sessions"] {
        for home in &unique_homes {
            let root = home.join(directory_name);
            if !seen_roots.insert(path_dedupe_key(&root)) {
                continue;
            }

            let mut root_files = Vec::new();
            collect_jsonl_files(&root, &mut root_files);
            root_files.sort();

            for path in root_files {
                if seen_files.insert(codex_session_file_key(&path)) {
                    files.push(path);
                }
            }
        }
    }

    files
}

pub(crate) fn collect_codex_session_files() -> Vec<PathBuf> {
    let mut homes = Vec::<PathBuf>::new();
    if let Some(raw_home) = env::var_os("TERMFLOW_CODEX_HOME").filter(|value| !value.is_empty()) {
        homes.push(PathBuf::from(raw_home));
    }
    for home in termflow_managed_codex_home_paths() {
        homes.push(home);
    }
    if let Some(raw_home) = env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        homes.push(PathBuf::from(raw_home));
    }
    if let Some(home_dir) = dirs_next::home_dir() {
        homes.push(home_dir.join(".codex"));
    }

    collect_codex_session_files_from_homes(homes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "termflow-agent-usage-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn create_rollout(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "{}\n").unwrap();
    }

    fn write_usage_rollout(path: &Path, raw_session_id: &str, events: &[(&str, u64, u64)]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut lines = vec![
            serde_json::json!({
                "timestamp": "2026-07-20T00:00:00Z",
                "type": "session_meta",
                "payload": {
                    "id": raw_session_id,
                    "cwd": "C:/private/project"
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-07-20T00:00:01Z",
                "type": "turn_context",
                "payload": {
                    "cwd": "C:/private/project",
                    "model": "gpt-5.6-sol"
                }
            })
            .to_string(),
        ];
        for (timestamp, total_tokens, last_tokens) in events {
            lines.push(
                serde_json::json!({
                    "timestamp": timestamp,
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "total_token_usage": {
                                "input_tokens": total_tokens,
                                "cached_input_tokens": 0,
                                "output_tokens": 0,
                                "reasoning_output_tokens": 0,
                                "total_tokens": total_tokens
                            },
                            "last_token_usage": {
                                "input_tokens": last_tokens,
                                "cached_input_tokens": 0,
                                "output_tokens": 0,
                                "reasoning_output_tokens": 0,
                                "total_tokens": last_tokens
                            }
                        }
                    }
                })
                .to_string(),
            );
        }
        fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    #[test]
    fn collects_active_and_archived_codex_sessions() {
        let directory = test_directory("active-and-archived");
        let home = directory.join("home");
        let active = home
            .join("sessions")
            .join("2026")
            .join("07")
            .join("21")
            .join("rollout-active.jsonl");
        let archived = home
            .join("archived_sessions")
            .join("rollout-archived.jsonl");
        create_rollout(&active);
        create_rollout(&archived);

        let files = collect_codex_session_files_from_homes(vec![home]);

        assert_eq!(files.len(), 2);
        assert!(files.contains(&active));
        assert!(files.contains(&archived));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn deduplicates_active_and_archived_copies_in_the_same_home() {
        let directory = test_directory("same-home-duplicate");
        let home = directory.join("home");
        let active = home
            .join("sessions")
            .join("2026")
            .join("07")
            .join("21")
            .join("rollout-duplicate.jsonl");
        let archived = home
            .join("archived_sessions")
            .join("rollout-duplicate.jsonl");
        create_rollout(&active);
        create_rollout(&archived);

        let files = collect_codex_session_files_from_homes(vec![home]);

        assert_eq!(files, vec![active]);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn deduplicates_session_ids_across_codex_homes() {
        let directory = test_directory("cross-home-duplicate");
        let first_home = directory.join("first-home");
        let second_home = directory.join("second-home");
        let archived = first_home
            .join("archived_sessions")
            .join("rollout-duplicate.jsonl");
        let active = second_home
            .join("sessions")
            .join("2026")
            .join("07")
            .join("21")
            .join("rollout-duplicate.jsonl");
        create_rollout(&archived);
        create_rollout(&active);

        let files = collect_codex_session_files_from_homes(vec![first_home, second_home]);

        assert_eq!(files, vec![active]);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn retains_anonymous_usage_after_the_source_file_is_deleted() {
        let directory = test_directory("deleted-source-retention");
        let path = directory
            .join("sessions")
            .join("rollout-private-session.jsonl");
        write_usage_rollout(
            &path,
            "raw-private-session-id",
            &[("2026-07-20T00:01:00Z", 120, 120)],
        );
        let database = Database::open_in_memory();

        let initial = sync_codex_usage_files(&database, vec![path.clone()]).unwrap();
        assert_eq!(initial.total_tokens(), 120);
        fs::remove_file(&path).unwrap();

        let retained = sync_codex_usage_files(&database, Vec::new()).unwrap();
        let stored = database.load_agent_usage_sessions(CODEX_AGENT_ID).unwrap();

        assert_eq!(retained.total_tokens(), 120);
        assert_eq!(stored.len(), 1);
        assert!(!stored[0].session_key.contains("raw-private-session-id"));
        assert!(!stored[0].snapshot_json.contains("raw-private-session-id"));
        assert!(!stored[0].snapshot_json.contains("C:/private/project"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clear_cutoff_prevents_old_events_from_being_reimported() {
        let directory = test_directory("clear-cutoff");
        let path = directory
            .join("sessions")
            .join("rollout-clear-cutoff.jsonl");
        write_usage_rollout(
            &path,
            "clear-cutoff-session",
            &[
                ("2026-07-20T00:01:00Z", 100, 100),
                ("2026-07-20T00:03:00Z", 150, 50),
            ],
        );
        let database = Database::open_in_memory();
        let cutoff = chrono::DateTime::parse_from_rfc3339("2026-07-20T00:02:00Z")
            .unwrap()
            .timestamp_millis();
        database
            .clear_agent_usage_history_at(Some(CODEX_AGENT_ID), cutoff)
            .unwrap();

        let after_clear = sync_codex_usage_files(&database, vec![path.clone()]).unwrap();
        let repeated = sync_codex_usage_files(&database, vec![path.clone()]).unwrap();

        assert_eq!(after_clear.total_tokens(), 50);
        assert_eq!(after_clear.total_messages(), 1);
        assert_eq!(repeated.total_tokens(), 50);
        assert_eq!(repeated.total_messages(), 1);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rebuild_keeps_the_manual_clear_cutoff() {
        let database = Database::open_in_memory();
        database
            .clear_agent_usage_history_at(Some(CODEX_AGENT_ID), 123_456)
            .unwrap();

        database
            .rebuild_agent_usage_history(Some(CODEX_AGENT_ID))
            .unwrap();

        let control = database.load_agent_usage_control(CODEX_AGENT_ID).unwrap();
        assert_eq!(control.cleared_at_ms, Some(123_456));
    }
}
