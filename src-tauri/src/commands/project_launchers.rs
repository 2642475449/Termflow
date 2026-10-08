use crate::path_utils::display_path;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherTerminal {
    title: String,
    directory: String,
    command: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectLauncher {
    id: String,
    name: String,
    terminals: Vec<LauncherTerminal>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LauncherFile {
    version: u32,
    launchers: Vec<ProjectLauncher>,
}

#[derive(Serialize)]
pub struct PreparedTerminal {
    title: String,
    directory: String,
    command: String,
}

fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['/', '\\'])
        && !value.contains([':', '\0'])
        && !value.split(['/', '\\']).any(|part| part == "..")
}

fn validate(document: &LauncherFile) -> Result<(), String> {
    if document.version != 1 || document.launchers.len() > 40 {
        return Err("启动组合版本无效或数量超过 40".into());
    }
    let mut ids = HashSet::new();
    for launcher in &document.launchers {
        if launcher.id.trim().is_empty()
            || launcher.id.chars().count() > 80
            || !ids.insert(&launcher.id)
            || launcher.name.trim().is_empty()
            || launcher.name.chars().count() > 80
            || launcher.terminals.is_empty()
            || launcher.terminals.len() > 12
        {
            return Err("启动组合名称、ID 或终端数量无效（每组 1–12 个终端）".into());
        }
        for terminal in &launcher.terminals {
            if terminal.title.trim().is_empty()
                || terminal.title.chars().count() > 80
                || !valid_relative_path(&terminal.directory)
                || terminal.directory.len() > 1024
                || terminal.command.chars().count() > 4000
                || terminal.command.contains('\0')
            {
                return Err("终端名称、项目相对目录或命令无效".into());
            }
        }
    }
    Ok(())
}

fn root(project_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(project_path).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("项目路径不是目录".into());
    }
    Ok(root)
}

fn config_path(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(".termflow");
    let file = directory.join("launchers.json");
    for path in [&directory, &file] {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                let resolved = fs::canonicalize(path).map_err(|error| error.to_string())?;
                if !resolved.starts_with(root) {
                    return Err(".termflow 配置路径必须位于项目内".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(file)
}

#[tauri::command]
pub fn load_project_launchers(project_path: String) -> Result<LauncherFile, String> {
    let path = config_path(&root(&project_path)?)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LauncherFile {
                version: 1,
                launchers: Vec::new(),
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("启动组合配置超过 1 MiB".into());
    }
    let document: LauncherFile =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    validate(&document)?;
    Ok(document)
}

#[tauri::command]
pub fn save_project_launchers(project_path: String, document: LauncherFile) -> Result<(), String> {
    validate(&document)?;
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("启动组合配置超过 1 MiB".into());
    }
    let path = config_path(&root(&project_path)?)?;
    let directory = path.parent().ok_or("配置路径无效")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temporary = directory.join(format!(
        ".launchers-{}-{}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

// 一次校验全部目录，再允许前端创建终端，避免部分目录无效时已执行前几条命令。
#[tauri::command]
pub fn prepare_project_launcher(
    project_path: String,
    launcher: ProjectLauncher,
) -> Result<Vec<PreparedTerminal>, String> {
    validate(&LauncherFile {
        version: 1,
        launchers: vec![launcher.clone()],
    })?;
    let root = root(&project_path)?;
    launcher
        .terminals
        .into_iter()
        .map(|terminal| {
            let relative = terminal.directory.replace('\\', "/");
            let directory = fs::canonicalize(root.join(relative))
                .map_err(|error| format!("{}: {error}", terminal.title))?;
            if !directory.is_dir() || !directory.starts_with(&root) {
                return Err(format!("{}: 工作目录必须是项目内的目录", terminal.title));
            }
            Ok(PreparedTerminal {
                title: terminal.title,
                directory: display_path(directory),
                command: terminal.command,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> LauncherFile {
        serde_json::from_str(r#"{"version":1,"launchers":[{"id":"dev","name":"开发","terminals":[{"title":"前端","directory":".","command":"pnpm dev"}]}]}"#).expect("fixture")
    }

    #[test]
    fn round_trip_and_missing_file() {
        let directory = tempfile::tempdir().expect("directory");
        let project = directory.path().to_string_lossy().to_string();
        assert!(load_project_launchers(project.clone())
            .expect("load")
            .launchers
            .is_empty());
        assert!(!directory.path().join(".termflow").exists());
        save_project_launchers(project.clone(), document()).expect("save");
        save_project_launchers(project.clone(), document()).expect("replace");
        let loaded = load_project_launchers(project.clone()).expect("reload");
        assert_eq!(loaded.launchers[0].name, "开发");
        let prepared =
            prepare_project_launcher(project, loaded.launchers[0].clone()).expect("prepare");
        assert_eq!(prepared[0].command, "pnpm dev");
        assert!(Path::new(&prepared[0].directory).is_absolute());
    }

    #[test]
    fn rejects_paths_duplicates_and_versions() {
        for path in [
            "../other",
            "a/../../b",
            "C:\\temp",
            "/tmp",
            "\\\\server\\dir",
            "a\\..\\b",
        ] {
            let mut value = document();
            value.launchers[0].terminals[0].directory = path.into();
            assert!(validate(&value).is_err(), "{path}");
        }
        let mut value = document();
        value.launchers.push(value.launchers[0].clone());
        assert!(validate(&value).is_err());
        value = document();
        value.version = 2;
        assert!(validate(&value).is_err());
    }

    #[test]
    fn rejects_invalid_files_without_overwriting() {
        let directory = tempfile::tempdir().expect("directory");
        let project = directory.path().to_string_lossy().to_string();
        save_project_launchers(project.clone(), document()).expect("save");
        let path = directory.path().join(".termflow/launchers.json");
        fs::write(&path, "invalid").expect("write");
        assert!(load_project_launchers(project.clone()).is_err());
        let mut value = document();
        value.version = 2;
        assert!(save_project_launchers(project, value).is_err());
        assert_eq!(fs::read_to_string(path).expect("read"), "invalid");
    }

    #[test]
    fn validates_all_working_directories_before_launch() {
        let directory = tempfile::tempdir().expect("directory");
        let mut value = document().launchers.remove(0);
        value.terminals.push(LauncherTerminal {
            title: "missing".into(),
            directory: "missing".into(),
            command: "".into(),
        });
        assert!(
            prepare_project_launcher(directory.path().to_string_lossy().to_string(), value)
                .is_err()
        );
    }

    #[test]
    fn rejects_agent_settings_and_unknown_fields() {
        let value = serde_json::to_value(document()).expect("serialize");
        for key in ["defaultAgent", "startupArgs", "workspaces"] {
            let mut changed = value.clone();
            changed[key] = serde_json::json!("unsupported");
            assert!(serde_json::from_value::<LauncherFile>(changed).is_err());
        }
        let mut changed = value;
        changed["launchers"][0]["terminals"][0]["agentId"] = serde_json::json!("codex");
        assert!(serde_json::from_value::<LauncherFile>(changed).is_err());
    }

    #[test]
    fn rejects_oversized_files_and_too_many_terminals() {
        let directory = tempfile::tempdir().expect("directory");
        let project = directory.path().to_string_lossy().to_string();
        save_project_launchers(project.clone(), document()).expect("save");
        fs::write(
            directory.path().join(".termflow/launchers.json"),
            vec![b' '; MAX_BYTES as usize + 1],
        )
        .expect("write");
        assert!(load_project_launchers(project).is_err());
        let mut value = document();
        value.launchers[0].terminals = vec![value.launchers[0].terminals[0].clone(); 13];
        assert!(validate(&value).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_outside_the_project() {
        let directory = tempfile::tempdir().expect("directory");
        let outside = tempfile::tempdir().expect("outside");
        std::os::unix::fs::symlink(outside.path(), directory.path().join(".termflow"))
            .expect("link");
        let project = directory.path().to_string_lossy().to_string();
        assert!(load_project_launchers(project.clone()).is_err());
        assert!(save_project_launchers(project, document()).is_err());
        assert!(!outside.path().join("launchers.json").exists());
    }
}
