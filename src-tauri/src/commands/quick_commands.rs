use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::database::Database;
use crate::path_utils::display_path;

// 项目文件为权威来源；数据库仅用于迁移旧项目命令，旧全局记录原样保留但不再使用。
static QUICK_COMMAND_LOCK: Mutex<()> = Mutex::new(());
const FILE_NAME: &str = "quick-commands.json";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const UPDATED_EVENT: &str = "quick-commands-updated";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum QuickCommandScope {
    Repository {
        #[serde(rename = "repositoryId")]
        repository_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDefinition {
    id: String,
    label: String,
    action: String,
    command: String,
    #[serde(default = "default_append_enter")]
    append_enter: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
}

fn default_append_enter() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QuickCommand {
    #[serde(flatten)]
    definition: CommandDefinition,
    scope: QuickCommandScope,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectCommandFile {
    version: u32,
    commands: Vec<CommandDefinition>,
}

fn validate(commands: &[CommandDefinition]) -> Result<(), String> {
    if commands.len() > 40 {
        return Err("快捷命令数量不能超过 40 条".into());
    }
    let mut ids = HashSet::new();
    for command in commands {
        if command.id.trim().is_empty()
            || command.id.chars().count() > 80
            || !ids.insert(&command.id)
        {
            return Err("快捷命令 ID 为空、过长或重复".into());
        }
        if command.label.chars().count() > 80 || command.command.chars().count() > 4000 {
            return Err("快捷命令名称或正文过长".into());
        }
        if command.action != "terminal-command" && command.action != "agent-prompt" {
            return Err("快捷命令类型无效".into());
        }
        if let Some(agent) = &command.agent_id {
            if !["claude", "codex", "antigravity", "opencode", "qoder", "pi"]
                .contains(&agent.as_str())
            {
                return Err("快捷命令绑定的智能体类型无效".into());
            }
        }
    }
    Ok(())
}

fn project_file(project_path: &str) -> Result<PathBuf, String> {
    if project_path.trim().is_empty() {
        return Err("快捷命令需要项目路径".into());
    }
    let root =
        fs::canonicalize(project_path).map_err(|error| format!("无法打开项目目录: {error}"))?;
    if !root.is_dir() {
        return Err("项目路径不是目录".into());
    }
    let directory = root.join(".termflow");
    let file = directory.join(FILE_NAME);
    // 不沿用指向项目外部的配置目录或文件。
    for path in [&directory, &file] {
        if path.exists() {
            let resolved = fs::canonicalize(path).map_err(|error| error.to_string())?;
            if !resolved.starts_with(&root) {
                return Err(".termflow 配置路径必须位于项目目录内".into());
            }
        } else if fs::symlink_metadata(path).is_ok() {
            return Err(".termflow 配置路径包含无效链接".into());
        }
    }
    Ok(file)
}

fn same_project(first: &str, second: &str) -> bool {
    let key = |value: &str| {
        let path = fs::canonicalize(value)
            .map(display_path)
            .unwrap_or_else(|_| value.to_string());
        let path = path.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        }
    };
    key(first) == key(second)
}

fn same_scope(first: &QuickCommandScope, second: &QuickCommandScope) -> bool {
    match (first, second) {
        (
            QuickCommandScope::Repository {
                repository_id: first,
            },
            QuickCommandScope::Repository {
                repository_id: second,
            },
        ) => same_project(first, second),
    }
}

fn read_local(database: &Database) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_value(database.load_stored_quick_commands()?)
        .map_err(|error| format!("无法读取本地快捷命令: {error}"))
}

fn write_local(database: &Database, commands: &[serde_json::Value]) -> Result<(), String> {
    let value = serde_json::to_value(commands).map_err(|error| error.to_string())?;
    database.save_stored_quick_commands(&value)
}

fn legacy_scope(command: &serde_json::Value) -> Option<QuickCommandScope> {
    serde_json::from_value(command.get("scope")?.clone()).ok()
}

fn legacy_commands(
    local: &[serde_json::Value],
    scope: &QuickCommandScope,
) -> Result<Vec<CommandDefinition>, String> {
    local
        .iter()
        .filter(|command| legacy_scope(command).is_some_and(|value| same_scope(&value, scope)))
        .map(|command| {
            serde_json::from_value::<QuickCommand>(command.clone())
                .map(|command| command.definition)
                .map_err(|error| format!("无法读取旧项目快捷命令: {error}"))
        })
        .collect()
}

fn write_file(path: &Path, commands: &[CommandDefinition]) -> Result<(), String> {
    validate(commands)?;
    let directory = path.parent().ok_or("配置文件路径无效")?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建 .termflow 目录: {error}"))?;
    let temporary = directory.join(format!(
        ".quick-commands-{}-{}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(&ProjectCommandFile {
            version: 1,
            commands: commands.to_vec(),
        })
        .map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法写入快捷命令: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法保存快捷命令: {error}"))?;
        drop(file);
        // 同目录替换，失败时保留旧配置，不先删除用户文件。
        fs::rename(&temporary, path).map_err(|error| format!("无法替换快捷命令配置: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn load_scope(
    database: &Database,
    scope: &QuickCommandScope,
) -> Result<Vec<CommandDefinition>, String> {
    let QuickCommandScope::Repository { repository_id } = scope;
    let path = project_file(repository_id)?;
    let local = read_local(database)?;
    let commands = match read_project_file(&path)? {
        Some(commands) => commands,
        None => {
            let commands = legacy_commands(&local, scope)?;
            if !commands.is_empty() {
                write_file(&path, &commands)?;
            }
            commands
        }
    };
    // 成功读取或写入项目文件后才移除对应的旧项目记录，其他记录（含旧全局数据）不变。
    let remaining: Vec<_> = local
        .iter()
        .filter(|command| !legacy_scope(command).is_some_and(|value| same_scope(&value, scope)))
        .cloned()
        .collect();
    if remaining.len() != local.len() {
        write_local(database, &remaining)?;
    }
    Ok(commands)
}

fn read_project_file(path: &Path) -> Result<Option<Vec<CommandDefinition>>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取快捷命令配置: {error}")),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return Err("快捷命令配置文件过大".into());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let file: ProjectCommandFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("快捷命令配置格式错误: {error}"))?;
    if file.version != 1 {
        return Err("不支持此快捷命令配置版本".into());
    }
    validate(&file.commands)?;
    Ok(Some(file.commands))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommandReadError {
    project_path: String,
    error: String,
}

#[derive(Serialize)]
pub struct QuickCommandCatalog {
    commands: Vec<QuickCommand>,
    errors: Vec<ProjectCommandReadError>,
}

// 设置页只汇总读取已知项目，不因查看“全部”而迁移或重写其他项目。
fn load_catalog(
    database: &Database,
    project_paths: &[String],
) -> Result<QuickCommandCatalog, String> {
    let local = read_local(database)?;
    let mut paths = project_paths.to_vec();
    paths.extend(local.iter().filter_map(legacy_scope).map(|scope| {
        let QuickCommandScope::Repository { repository_id } = scope;
        repository_id
    }));
    let mut catalog = QuickCommandCatalog {
        commands: vec![],
        errors: vec![],
    };
    let mut seen: Vec<String> = vec![];
    for path in paths {
        if path.trim().is_empty() || seen.iter().any(|previous| same_project(previous, &path)) {
            continue;
        }
        seen.push(path.clone());
        let scope = QuickCommandScope::Repository {
            repository_id: path.clone(),
        };
        let legacy = || legacy_commands(&local, &scope);
        let commands = if !Path::new(&path).is_dir() {
            catalog.errors.push(ProjectCommandReadError {
                project_path: path.clone(),
                error: "项目目录不可用".into(),
            });
            // 尚未迁移的命令仍可查看；编辑时会正常报告路径不可用。
            legacy()?
        } else {
            match project_file(&path).and_then(|file| read_project_file(&file)) {
                Ok(Some(commands)) => commands,
                Ok(None) => legacy()?,
                Err(error) => {
                    catalog.errors.push(ProjectCommandReadError {
                        project_path: path.clone(),
                        error,
                    });
                    continue;
                }
            }
        };
        catalog
            .commands
            .extend(commands.into_iter().map(|definition| QuickCommand {
                definition,
                scope: scope.clone(),
            }));
    }
    Ok(catalog)
}

fn save_scope(scope: &QuickCommandScope, commands: &[CommandDefinition]) -> Result<(), String> {
    validate(commands)?;
    match scope {
        QuickCommandScope::Repository { repository_id } => {
            write_file(&project_file(repository_id)?, commands)
        }
    }
}

fn load_commands(
    database: &Database,
    project_path: Option<&str>,
) -> Result<Vec<QuickCommand>, String> {
    let Some(path) = project_path.filter(|path| !path.trim().is_empty()) else {
        return Ok(vec![]);
    };
    let scope = QuickCommandScope::Repository {
        repository_id: path.to_string(),
    };
    Ok(load_scope(database, &scope)?
        .into_iter()
        .map(|definition| QuickCommand {
            definition,
            scope: scope.clone(),
        })
        .collect())
}

fn upsert(
    database: &Database,
    command: QuickCommand,
    previous_scope: Option<QuickCommandScope>,
) -> Result<(), String> {
    validate(std::slice::from_ref(&command.definition))?;
    let original = load_scope(database, &command.scope)?;
    let source = previous_scope.filter(|scope| !same_scope(scope, &command.scope));
    if source.is_some() && original.iter().any(|item| item.id == command.definition.id) {
        return Err("目标项目已存在相同 ID 的快捷命令".into());
    }
    let mut source_commands = source
        .as_ref()
        .map(|scope| load_scope(database, scope))
        .transpose()?;
    let mut target = original.clone();
    if let Some(existing) = target
        .iter_mut()
        .find(|item| item.id == command.definition.id)
    {
        *existing = command.definition.clone();
    } else {
        target.push(command.definition.clone());
    }
    save_scope(&command.scope, &target)?;
    if let (Some(scope), Some(commands)) = (source, source_commands.as_mut()) {
        commands.retain(|item| item.id != command.definition.id);
        if let Err(error) = save_scope(&scope, commands) {
            if let Err(rollback) = save_scope(&command.scope, &original) {
                return Err(format!("{error}; 回滚目标配置失败: {rollback}"));
            }
            return Err(error);
        }
    }
    Ok(())
}

fn remove(database: &Database, id: &str, scope: &QuickCommandScope) -> Result<(), String> {
    let mut commands = load_scope(database, scope)?;
    commands.retain(|command| command.id != id);
    save_scope(scope, &commands)
}

#[tauri::command]
pub fn load_quick_command_usage(
    database: State<'_, Arc<Database>>,
    project_path: String,
) -> Result<BTreeMap<String, u64>, String> {
    database.load_quick_command_usage(&project_path)
}

#[tauri::command]
pub fn record_quick_command_use(
    database: State<'_, Arc<Database>>,
    project_path: String,
    command_id: String,
    used_at: u64,
) -> Result<u64, String> {
    database.record_quick_command_use(&project_path, &command_id, used_at)
}

#[tauri::command]
pub fn load_quick_commands(
    database: State<'_, Arc<Database>>,
    project_path: Option<String>,
) -> Result<Vec<QuickCommand>, String> {
    let _guard = QUICK_COMMAND_LOCK.lock();
    load_commands(&database, project_path.as_deref())
}

#[tauri::command]
pub fn load_quick_command_catalog(
    database: State<'_, Arc<Database>>,
    project_paths: Vec<String>,
) -> Result<QuickCommandCatalog, String> {
    let _guard = QUICK_COMMAND_LOCK.lock();
    load_catalog(&database, &project_paths)
}

#[tauri::command]
pub fn save_quick_command(
    database: State<'_, Arc<Database>>,
    app: AppHandle,
    command: QuickCommand,
    previous_scope: Option<QuickCommandScope>,
) -> Result<(), String> {
    let _guard = QUICK_COMMAND_LOCK.lock();
    upsert(&database, command, previous_scope)?;
    let _ = app.emit(UPDATED_EVENT, ());
    Ok(())
}

#[tauri::command]
pub fn remove_quick_command(
    database: State<'_, Arc<Database>>,
    app: AppHandle,
    id: String,
    scope: QuickCommandScope,
) -> Result<(), String> {
    let _guard = QUICK_COMMAND_LOCK.lock();
    remove(&database, &id, &scope)?;
    let _ = app.emit(UPDATED_EVENT, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::PersistentSettingsRecord;
    use tempfile::TempDir;

    fn scope(root: &TempDir) -> QuickCommandScope {
        QuickCommandScope::Repository {
            repository_id: display_path(root.path()),
        }
    }

    fn command(id: &str, scope: QuickCommandScope) -> QuickCommand {
        QuickCommand {
            definition: CommandDefinition {
                id: id.into(),
                label: format!("命令 {id}"),
                action: "terminal-command".into(),
                command: "pnpm dev".into(),
                append_enter: true,
                agent_id: None,
            },
            scope,
        }
    }

    fn seed_project_commands(database: &Database, commands: &[QuickCommand]) {
        let records = commands
            .iter()
            .map(|command| serde_json::to_value(command).unwrap())
            .collect::<Vec<_>>();
        write_local(database, &records).unwrap();
    }

    fn legacy_global() -> serde_json::Value {
        serde_json::json!({
            "id": "global",
            "label": "Old global command",
            "action": "terminal-command",
            "command": "pwd",
            "appendEnter": true,
            "scope": { "type": "global" },
            "legacyMetadata": { "keep": true },
        })
    }

    #[test]
    fn ipc_definition_round_trips_with_scope() {
        let root = TempDir::new().unwrap();
        let original = command("preview", scope(&root));
        let value = serde_json::to_value(&original).unwrap();
        let parsed: QuickCommand = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.definition.id, "preview");
        assert_eq!(parsed.scope, scope(&root));
        assert!(serde_json::from_value::<QuickCommand>(legacy_global()).is_err());
        assert!(serde_json::from_value::<QuickCommandScope>(
            serde_json::json!({ "type": "global" })
        )
        .is_err());
    }

    #[test]
    fn no_project_loads_no_commands_and_old_global_records_remain_untouched() {
        let db = Database::open_in_memory();
        let original = vec![legacy_global()];
        write_local(&db, &original).unwrap();
        for project_path in [None, Some(""), Some("   ")] {
            assert!(load_commands(&db, project_path).unwrap().is_empty());
        }
        let catalog = load_catalog(&db, &[]).unwrap();
        assert!(catalog.commands.is_empty());
        assert!(catalog.errors.is_empty());
        assert_eq!(read_local(&db).unwrap(), original);
    }

    #[test]
    fn blank_project_scope_cannot_write_or_delete_commands() {
        let db = Database::open_in_memory();
        for path in ["", "   "] {
            let scope = QuickCommandScope::Repository {
                repository_id: path.into(),
            };
            assert!(upsert(&db, command("new", scope.clone()), None).is_err());
            assert!(remove(&db, "existing", &scope).is_err());
        }
    }

    #[test]
    fn migrates_only_current_project_after_writing_portable_file() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        write_local(
            &db,
            &[
                legacy_global(),
                serde_json::to_value(command("preview", scope(&root))).unwrap(),
                serde_json::to_value(command("other", scope(&other))).unwrap(),
            ],
        )
        .unwrap();
        let loaded = load_commands(&db, Some(root.path().to_str().unwrap())).unwrap();
        assert_eq!(loaded.len(), 1);
        let file = fs::read_to_string(root.path().join(".termflow").join(FILE_NAME)).unwrap();
        assert!(!file.contains("repositoryId"));
        assert!(!file.contains("scope"));
        assert!(!file.contains(root.path().to_str().unwrap()));
        assert_eq!(
            read_local(&db)
                .unwrap()
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["global", "other"]
        );
        assert_eq!(read_local(&db).unwrap()[0], legacy_global());
    }

    #[test]
    fn copied_file_rebinds_commands_to_new_project_location() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        let copied = TempDir::new().unwrap();
        upsert(&db, command("preview", scope(&root)), None).unwrap();
        fs::create_dir(copied.path().join(".termflow")).unwrap();
        fs::copy(
            root.path().join(".termflow").join(FILE_NAME),
            copied.path().join(".termflow").join(FILE_NAME),
        )
        .unwrap();
        let fresh_db = Database::open_in_memory();
        let loaded = load_commands(&fresh_db, Some(copied.path().to_str().unwrap())).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scope, scope(&copied));
        assert_eq!(loaded[0].definition.command, "pnpm dev");
    }

    #[test]
    fn empty_file_is_authoritative_and_deleted_commands_do_not_return() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        seed_project_commands(&db, &[command("legacy", scope(&root))]);
        let file = project_file(root.path().to_str().unwrap()).unwrap();
        write_file(&file, &[]).unwrap();
        assert!(load_scope(&db, &scope(&root)).unwrap().is_empty());
        assert!(read_local(&db).unwrap().is_empty());
        fs::remove_file(file).unwrap();
        assert!(load_scope(&db, &scope(&root)).unwrap().is_empty());
    }

    #[test]
    fn invalid_or_future_file_is_not_overwritten_and_legacy_data_survives() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        seed_project_commands(&db, &[command("legacy", scope(&root))]);
        let file = project_file(root.path().to_str().unwrap()).unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        for content in [
            "broken json",
            r#"{"version":2,"commands":[]}"#,
            r#"{"version":1,"commands":[],"future":true}"#,
        ] {
            fs::write(&file, content).unwrap();
            assert!(upsert(&db, command("new", scope(&root)), None).is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), content);
            assert_eq!(read_local(&db).unwrap().len(), 1);
        }
    }

    #[test]
    fn saves_merge_current_file_and_replace_it_without_losing_other_commands() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        upsert(&db, command("a", scope(&root)), None).unwrap();
        upsert(&db, command("b", scope(&root)), None).unwrap();
        let mut edited = command("a", scope(&root));
        edited.definition.command = "pnpm build".into();
        upsert(&db, edited, Some(scope(&root))).unwrap();
        let loaded = load_scope(&db, &scope(&root)).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].command, "pnpm build");
        remove(&db, "a", &scope(&root)).unwrap();
        remove(&db, "b", &scope(&root)).unwrap();
        assert!(load_scope(&db, &scope(&root)).unwrap().is_empty());
        assert!(root.path().join(".termflow").join(FILE_NAME).exists());
    }

    #[test]
    fn moves_commands_between_project_files_preserving_unrelated_commands() {
        let db = Database::open_in_memory();
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        upsert(&db, command("keep", scope(&first)), None).unwrap();
        upsert(&db, command("move", scope(&first)), None).unwrap();
        upsert(&db, command("move", scope(&second)), Some(scope(&first))).unwrap();
        assert_eq!(load_scope(&db, &scope(&first)).unwrap()[0].id, "keep");
        assert_eq!(load_scope(&db, &scope(&second)).unwrap()[0].id, "move");
        upsert(&db, command("move", scope(&first)), Some(scope(&second))).unwrap();
        assert_eq!(load_scope(&db, &scope(&first)).unwrap().len(), 2);
        assert!(load_scope(&db, &scope(&second)).unwrap().is_empty());
    }

    #[test]
    fn moving_to_a_project_with_the_same_id_does_not_overwrite_either_file() {
        let db = Database::open_in_memory();
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        upsert(&db, command("shared-id", scope(&first)), None).unwrap();
        let mut other = command("shared-id", scope(&second));
        other.definition.command = "pnpm build".into();
        upsert(&db, other, None).unwrap();
        assert!(upsert(
            &db,
            command("shared-id", scope(&second)),
            Some(scope(&first)),
        )
        .is_err());
        assert_eq!(
            load_scope(&db, &scope(&first)).unwrap()[0].command,
            "pnpm dev"
        );
        assert_eq!(
            load_scope(&db, &scope(&second)).unwrap()[0].command,
            "pnpm build"
        );
    }

    #[test]
    fn catalog_reads_every_known_project_and_keeps_copied_ids_separate() {
        let db = Database::open_in_memory();
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        write_local(&db, &[legacy_global()]).unwrap();
        upsert(&db, command("shared-id", scope(&first)), None).unwrap();
        upsert(&db, command("shared-id", scope(&second)), None).unwrap();
        let catalog = load_catalog(
            &db,
            &[
                display_path(first.path()),
                display_path(second.path()),
                display_path(first.path().join(".")),
            ],
        )
        .unwrap();
        assert!(catalog.errors.is_empty());
        assert_eq!(catalog.commands.len(), 2);
        assert_eq!(catalog.commands[0].scope, scope(&first));
        assert_eq!(catalog.commands[1].scope, scope(&second));
        // 标题栏的单项目查询只返回当前项目命令。
        assert_eq!(load_commands(&db, first.path().to_str()).unwrap().len(), 1);
        remove(&db, "shared-id", &scope(&first)).unwrap();
        assert!(load_scope(&db, &scope(&first)).unwrap().is_empty());
        assert_eq!(load_scope(&db, &scope(&second)).unwrap().len(), 1);
        assert_eq!(read_local(&db).unwrap(), vec![legacy_global()]);
    }

    #[test]
    fn catalog_includes_unmigrated_projects_without_writing_their_files() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        seed_project_commands(&db, &[command("legacy", scope(&root))]);
        let catalog = load_catalog(&db, &[]).unwrap();
        assert_eq!(catalog.commands.len(), 1);
        assert_eq!(catalog.commands[0].scope, scope(&root));
        assert!(!root.path().join(".termflow").exists());
        assert_eq!(read_local(&db).unwrap().len(), 1);
    }

    #[test]
    fn catalog_respects_empty_project_files_over_legacy_cache() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        seed_project_commands(&db, &[command("legacy", scope(&root))]);
        write_file(&project_file(root.path().to_str().unwrap()).unwrap(), &[]).unwrap();
        assert!(load_catalog(&db, &[]).unwrap().commands.is_empty());
        // 汇总查询不修改数据库，当前项目正常加载时才迁移。
        assert_eq!(read_local(&db).unwrap().len(), 1);
    }

    #[test]
    fn catalog_reports_bad_projects_without_hiding_valid_project_commands() {
        let db = Database::open_in_memory();
        let good = TempDir::new().unwrap();
        let bad = TempDir::new().unwrap();
        upsert(&db, command("preview", scope(&good)), None).unwrap();
        let file = project_file(bad.path().to_str().unwrap()).unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "invalid JSON").unwrap();
        let catalog =
            load_catalog(&db, &[display_path(good.path()), display_path(bad.path())]).unwrap();
        assert_eq!(catalog.commands.len(), 1);
        assert_eq!(catalog.errors.len(), 1);
        assert_eq!(catalog.errors[0].project_path, display_path(bad.path()));
        assert_eq!(fs::read_to_string(&file).unwrap(), "invalid JSON");
    }

    #[test]
    fn catalog_retains_legacy_commands_for_unavailable_project_paths() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        let missing = display_path(root.path().join("missing"));
        seed_project_commands(
            &db,
            &[command(
                "legacy",
                QuickCommandScope::Repository {
                    repository_id: missing.clone(),
                },
            )],
        );
        let catalog = load_catalog(&db, &[]).unwrap();
        assert_eq!(catalog.commands.len(), 1);
        assert_eq!(catalog.errors[0].project_path, missing);
        assert_eq!(read_local(&db).unwrap().len(), 1);
    }

    #[test]
    fn failed_migration_keeps_original_database_commands() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        seed_project_commands(&db, &[command("legacy", scope(&root))]);
        fs::write(
            root.path().join(".termflow"),
            "occupied by an existing file",
        )
        .unwrap();
        assert!(load_scope(&db, &scope(&root)).is_err());
        assert_eq!(read_local(&db).unwrap()[0]["id"], "legacy");
        assert_eq!(
            fs::read_to_string(root.path().join(".termflow")).unwrap(),
            "occupied by an existing file"
        );
    }

    #[test]
    fn stale_general_settings_cannot_overwrite_dedicated_command_storage() {
        let db = Database::open_in_memory();
        let root = TempDir::new().unwrap();
        write_local(
            &db,
            &[
                legacy_global(),
                serde_json::to_value(command("legacy", scope(&root))).unwrap(),
            ],
        )
        .unwrap();
        let original = db.load_stored_quick_commands().unwrap();
        db.save_general_persistent_settings(&PersistentSettingsRecord::default())
            .unwrap();
        assert_eq!(db.load_stored_quick_commands().unwrap(), original);
        db.save_general_persistent_settings_patch(
            &PersistentSettingsRecord::default(),
            &["terminalQuickCommands".into(), "language".into()],
        )
        .unwrap();
        assert_eq!(db.load_stored_quick_commands().unwrap(), original);
    }
}
