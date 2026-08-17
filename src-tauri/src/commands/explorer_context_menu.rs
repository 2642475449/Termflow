//! Windows Explorer context-menu integration.
//!
//! The installer registers these verbs for the current user. This module owns
//! runtime changes made from Settings, including safely removing only entries
//! that are explicitly marked as belonging to Termflow or legacy entries that
//! still point at the currently running executable.

use std::path::Path;

const FOLDER_MENU_KEY: &str = r"Software\Classes\Directory\shell\Termflow.OpenFolder";
const BACKGROUND_MENU_KEY: &str =
    r"Software\Classes\Directory\Background\shell\Termflow.OpenFolder";
const INSTALLER_PREFERENCES_KEY: &str = r"Software\Termflow";
const INSTALLER_CONTEXT_MENU_ENABLED_VALUE: &str = "ExplorerContextMenuEnabled";
const OWNER_VALUE_NAME: &str = "TermflowOwner";
const OWNER_MARKER: &str = "com.termflow.desktop";
const MENU_LABEL: &str = "Open with Termflow";

#[derive(Clone, Copy)]
enum ExplorerVerbTarget {
    Folder,
    FolderBackground,
}

impl ExplorerVerbTarget {
    fn menu_key(self) -> &'static str {
        match self {
            Self::Folder => FOLDER_MENU_KEY,
            Self::FolderBackground => BACKGROUND_MENU_KEY,
        }
    }

    fn placeholder(self) -> &'static str {
        match self {
            Self::Folder => "%1",
            Self::FolderBackground => "%V",
        }
    }
}

fn command_key(target: ExplorerVerbTarget) -> String {
    format!(r"{}\command", target.menu_key())
}

fn command_for_executable(executable: &Path, target: ExplorerVerbTarget) -> String {
    format!("\"{}\" \"{}\"", executable.display(), target.placeholder())
}

fn icon_for_executable(executable: &Path) -> String {
    format!("\"{}\",0", executable.display())
}

fn is_owned_command(actual: &str, executable: &Path, target: ExplorerVerbTarget) -> bool {
    actual == command_for_executable(executable, target)
}

fn should_remove_menu(
    owner_marker: Option<&str>,
    command: Option<&str>,
    executable: &Path,
    target: ExplorerVerbTarget,
) -> bool {
    match owner_marker {
        // A stable marker survives an upgrade that changes the executable
        // location, so it is the authoritative ownership signal.
        Some(marker) => marker == OWNER_MARKER,
        // Older releases did not write a marker. Keep the exact command check
        // as a conservative compatibility path for those entries only.
        None => command.is_some_and(|actual| is_owned_command(actual, executable, target)),
    }
}

fn installer_preference_value(enabled: bool) -> &'static str {
    if enabled {
        "1"
    } else {
        "0"
    }
}

fn parse_installer_preference(value: &str) -> Result<bool, String> {
    match value {
        "1" => Ok(true),
        "0" => Ok(false),
        _ => Err(format!(
            "资源管理器右键菜单安装偏好值无效: {value:?}，应为 \"0\" 或 \"1\""
        )),
    }
}

/// Updates the current user's Explorer context-menu integration.
///
/// This intentionally does not run during ordinary startup when the setting
/// is enabled: the installer owns initial registration, and development runs
/// must not mutate a user's registry. Startup only invokes the `false` branch
/// to preserve an existing opt-out after an installer update.
#[cfg(target_os = "windows")]
pub fn set_explorer_context_menu_enabled(enabled: bool) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法确定 Termflow 可执行文件路径: {error}"))?;
    let previous_preference = read_installer_preference()?;

    // Write this first. If an update/reinstall begins before this process has
    // finished removing the verbs, NSIS will still honour the user's opt-out.
    write_installer_preference(enabled)?;

    let registry_change = if enabled {
        register_context_menu(&executable)
    } else {
        unregister_owned_context_menu(&executable)
    };
    if let Err(error) = registry_change {
        // Both verbs are updated separately. If one operation fails partway
        // through, restore the previously explicit preference as far as the
        // registry allows before restoring its installer sentinel.
        let verbs_rollback = restore_context_menu_for_preference(previous_preference, &executable);
        let preference_rollback = restore_installer_preference(previous_preference);
        // A failed operation may still have changed one verb. Notify Explorer
        // after the best-effort rollback so it does not retain a stale cache.
        refresh_explorer_associations();
        match (verbs_rollback, preference_rollback) {
            (Ok(()), Ok(())) => return Err(error),
            (Err(verbs_rollback), Ok(())) => {
                return Err(format!(
                    "更新资源管理器右键菜单失败: {error}; 回滚右键菜单也失败: {verbs_rollback}"
                ));
            }
            (Ok(()), Err(preference_rollback)) => {
                return Err(format!(
                    "更新资源管理器右键菜单失败: {error}; 回滚安装偏好也失败: {preference_rollback}"
                ));
            }
            (Err(verbs_rollback), Err(preference_rollback)) => {
                return Err(format!(
                    "更新资源管理器右键菜单失败: {error}; 回滚右键菜单失败: {verbs_rollback}; 回滚安装偏好失败: {preference_rollback}"
                ));
            }
        }
    }

    refresh_explorer_associations();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_explorer_context_menu_enabled(_enabled: bool) -> Result<(), String> {
    Err("资源管理器右键菜单仅在 Windows 上可用".to_string())
}

#[cfg(target_os = "windows")]
fn register_context_menu(executable: &Path) -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    let icon = icon_for_executable(executable);
    for target in [
        ExplorerVerbTarget::Folder,
        ExplorerVerbTarget::FolderBackground,
    ] {
        let menu_key = CURRENT_USER
            .create(target.menu_key())
            .map_err(|error| format!("创建资源管理器右键菜单注册项失败: {error}"))?;
        // Mark ownership before writing the remaining values. If a later
        // write fails, a rollback can still identify and clean this partial
        // Termflow entry without depending on the executable path.
        menu_key
            .set_string(OWNER_VALUE_NAME, OWNER_MARKER)
            .map_err(|error| format!("写入资源管理器右键菜单所有者标记失败: {error}"))?;
        menu_key
            .set_string("", MENU_LABEL)
            .map_err(|error| format!("写入资源管理器右键菜单名称失败: {error}"))?;
        menu_key
            .set_string("Icon", &icon)
            .map_err(|error| format!("写入资源管理器右键菜单图标失败: {error}"))?;

        let command_key = CURRENT_USER
            .create(command_key(target))
            .map_err(|error| format!("创建资源管理器右键菜单命令失败: {error}"))?;
        command_key
            .set_string("", command_for_executable(executable, target))
            .map_err(|error| format!("写入资源管理器右键菜单命令失败: {error}"))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_owned_context_menu(executable: &Path) -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    for target in [
        ExplorerVerbTarget::Folder,
        ExplorerVerbTarget::FolderBackground,
    ] {
        let Some(menu_key) = open_optional_current_user_key(target.menu_key())? else {
            continue;
        };
        let owner_marker = read_optional_registry_string(
            &menu_key,
            OWNER_VALUE_NAME,
            "资源管理器右键菜单所有者标记",
        )?;

        let command = if owner_marker.is_none() {
            match open_optional_current_user_key(&command_key(target))? {
                Some(command_key) => {
                    read_optional_registry_string(&command_key, "", "资源管理器右键菜单命令")?
                }
                None => None,
            }
        } else {
            None
        };

        if should_remove_menu(
            owner_marker.as_deref(),
            command.as_deref(),
            executable,
            target,
        ) {
            match CURRENT_USER.remove_tree(target.menu_key()) {
                Ok(()) => {}
                Err(error) if is_not_found_hresult(error.code().0) => {}
                Err(error) => {
                    return Err(format!("移除资源管理器右键菜单注册项失败: {error}"));
                }
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn read_installer_preference() -> Result<Option<bool>, String> {
    let Some(key) = open_optional_current_user_key(INSTALLER_PREFERENCES_KEY)? else {
        return Ok(None);
    };
    let Some(value) = read_optional_registry_string(
        &key,
        INSTALLER_CONTEXT_MENU_ENABLED_VALUE,
        "资源管理器右键菜单安装偏好",
    )?
    else {
        return Ok(None);
    };

    parse_installer_preference(&value).map(Some)
}

#[cfg(target_os = "windows")]
fn write_installer_preference(enabled: bool) -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    let preferences = CURRENT_USER
        .create(INSTALLER_PREFERENCES_KEY)
        .map_err(|error| format!("创建 Termflow 安装偏好注册项失败: {error}"))?;
    preferences
        .set_string(
            INSTALLER_CONTEXT_MENU_ENABLED_VALUE,
            installer_preference_value(enabled),
        )
        .map_err(|error| format!("写入资源管理器右键菜单安装偏好失败: {error}"))
}

#[cfg(target_os = "windows")]
fn restore_installer_preference(previous_preference: Option<bool>) -> Result<(), String> {
    if let Some(enabled) = previous_preference {
        return write_installer_preference(enabled);
    }

    let Some(preferences) = open_optional_current_user_key(INSTALLER_PREFERENCES_KEY)? else {
        return Ok(());
    };
    match preferences.remove_value(INSTALLER_CONTEXT_MENU_ENABLED_VALUE) {
        Ok(()) => Ok(()),
        Err(error) if is_not_found_hresult(error.code().0) => Ok(()),
        Err(error) => Err(format!("回滚资源管理器右键菜单安装偏好失败: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn restore_context_menu_for_preference(
    previous_preference: Option<bool>,
    executable: &Path,
) -> Result<(), String> {
    match previous_preference {
        Some(true) => register_context_menu(executable),
        Some(false) => unregister_owned_context_menu(executable),
        // The installer defaults to enabled when no sentinel exists, so use
        // that same default to repair a partial first-time disable attempt.
        None => register_context_menu(executable),
    }
}

#[cfg(target_os = "windows")]
fn open_optional_current_user_key(path: &str) -> Result<Option<windows_registry::Key>, String> {
    use windows_registry::CURRENT_USER;

    match CURRENT_USER.open(path) {
        Ok(key) => Ok(Some(key)),
        Err(error) if is_not_found_hresult(error.code().0) => Ok(None),
        Err(error) => Err(format!("读取注册表项 {path} 失败: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn read_optional_registry_string(
    key: &windows_registry::Key,
    value_name: &str,
    label: &str,
) -> Result<Option<String>, String> {
    match key.get_string(value_name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_not_found_hresult(error.code().0) => Ok(None),
        Err(error) => Err(format!("读取{label}失败: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn is_not_found_hresult(hresult: i32) -> bool {
    matches!(hresult as u32, 0x8007_0002 | 0x8007_0003)
}

#[cfg(target_os = "windows")]
fn refresh_explorer_associations() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

    // SHChangeNotify has no failure return. This is the documented way to
    // invalidate Explorer's class-association cache after registry changes.
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        command_for_executable, icon_for_executable, installer_preference_value, is_owned_command,
        parse_installer_preference, should_remove_menu, ExplorerVerbTarget, OWNER_MARKER,
    };
    use std::path::Path;

    #[test]
    fn builds_quoted_commands_for_both_explorer_targets() {
        let executable = Path::new(r"C:\Program Files\Termflow\Termflow.exe");

        assert_eq!(
            command_for_executable(executable, ExplorerVerbTarget::Folder),
            r#""C:\Program Files\Termflow\Termflow.exe" "%1""#
        );
        assert_eq!(
            command_for_executable(executable, ExplorerVerbTarget::FolderBackground),
            r#""C:\Program Files\Termflow\Termflow.exe" "%V""#
        );
        assert_eq!(
            icon_for_executable(executable),
            r#""C:\Program Files\Termflow\Termflow.exe",0"#
        );
    }

    #[test]
    fn ownership_requires_the_exact_expected_legacy_command() {
        let executable = Path::new(r"C:\Program Files\Termflow\Termflow.exe");
        let expected = command_for_executable(executable, ExplorerVerbTarget::Folder);

        assert!(is_owned_command(
            &expected,
            executable,
            ExplorerVerbTarget::Folder
        ));
        assert!(!is_owned_command(
            r#""C:\Other App\other.exe" "%1""#,
            executable,
            ExplorerVerbTarget::Folder
        ));
        assert!(!is_owned_command(
            r#""C:\Program Files\Termflow\Termflow.exe" "%V""#,
            executable,
            ExplorerVerbTarget::Folder
        ));
    }

    #[test]
    fn stable_owner_marker_handles_stale_paths_but_never_claims_other_owners() {
        let executable = Path::new(r"C:\Program Files\Termflow\Termflow.exe");
        let stale_command = r#""D:\Old Termflow\Termflow.exe" "%1""#;
        let legacy_command = command_for_executable(executable, ExplorerVerbTarget::Folder);

        assert!(should_remove_menu(
            Some(OWNER_MARKER),
            Some(stale_command),
            executable,
            ExplorerVerbTarget::Folder
        ));
        assert!(should_remove_menu(
            None,
            Some(&legacy_command),
            executable,
            ExplorerVerbTarget::Folder
        ));
        assert!(!should_remove_menu(
            None,
            Some(stale_command),
            executable,
            ExplorerVerbTarget::Folder
        ));
        assert!(!should_remove_menu(
            Some("com.example.other"),
            Some(&legacy_command),
            executable,
            ExplorerVerbTarget::Folder
        ));
    }

    #[test]
    fn installer_preference_is_strictly_encoded() {
        assert_eq!(installer_preference_value(true), "1");
        assert_eq!(installer_preference_value(false), "0");
        assert_eq!(parse_installer_preference("1"), Ok(true));
        assert_eq!(parse_installer_preference("0"), Ok(false));
        assert!(parse_installer_preference("enabled").is_err());
    }
}
