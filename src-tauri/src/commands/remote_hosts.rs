use crate::database::Database;
use crate::remote_ssh::{RemoteHost, RemoteSshManager};
use crate::ssh_config::{discover_default_hosts, SshConfigHost};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn list_remote_hosts(
    database: State<'_, Arc<Database>>,
) -> Result<Vec<RemoteHost>, String> {
    let database = database.inner().clone();
    super::run_background_task("list_remote_hosts", move || {
        Ok(merge_config_hosts(
            database.list_remote_hosts()?,
            discover_default_hosts()?,
        ))
    })
    .await
}

fn merge_config_hosts(
    mut saved: Vec<RemoteHost>,
    discovered: Vec<SshConfigHost>,
) -> Vec<RemoteHost> {
    let mut targets: HashSet<String> = saved.iter().map(|host| host.target.clone()).collect();
    for entry in discovered {
        let host = RemoteHost {
            id: format!("ssh-config-{:x}", Sha256::digest(entry.alias.as_bytes())),
            name: entry.alias.clone(),
            target: entry.alias,
            port: None,
            identity_file: None,
            ssh_config_file: Some(entry.config_file),
        };
        if host.validate().is_ok() && targets.insert(host.target.clone()) {
            saved.push(host);
        }
    }
    saved
}

#[tauri::command]
pub fn save_remote_host(
    host: RemoteHost,
    database: State<'_, Arc<Database>>,
) -> Result<RemoteHost, String> {
    database.save_remote_host(host)
}

#[tauri::command]
pub async fn delete_remote_host(
    host_id: String,
    database: State<'_, Arc<Database>>,
    manager: State<'_, Arc<RemoteSshManager>>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let database = database.inner().clone();
    super::run_background_task("delete_remote_host", move || {
        if host_id.starts_with("ssh-config-")
            && !database
                .list_remote_hosts()?
                .iter()
                .any(|host| host.id == host_id)
        {
            return Err("remote_ssh_config_read_only".into());
        }
        // 移除主机仅断开本地传输，远端任务仍由助手持有。
        manager.disconnect(&host_id)?;
        database.delete_remote_host(&host_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_aliases_keep_native_settings_and_have_stable_ids() {
        let entries = vec![SshConfigHost {
            alias: "电信".into(),
            config_file: "user/config".into(),
        }];
        let first = merge_config_hosts(Vec::new(), entries.clone());
        let second = merge_config_hosts(Vec::new(), entries);
        assert_eq!(first, second);
        assert_eq!(first[0].target, "电信");
        assert!(first[0].validate().is_ok());
        assert!(first[0].port.is_none());
        assert!(first[0].identity_file.is_none());
    }

    #[test]
    fn saved_connections_take_precedence_without_duplicating_config_aliases() {
        let saved = RemoteHost {
            id: "manual".into(),
            name: "My server".into(),
            target: "dev".into(),
            port: Some(2222),
            identity_file: None,
            ssh_config_file: None,
        };
        let merged = merge_config_hosts(
            vec![saved.clone()],
            vec![
                SshConfigHost {
                    alias: "dev".into(),
                    config_file: "config".into(),
                },
                SshConfigHost {
                    alias: "other".into(),
                    config_file: "config".into(),
                },
            ],
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0], saved);
    }
}
