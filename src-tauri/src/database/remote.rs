//! 远程主机只保存连接元数据，口令和服务令牌从不持久化到这里。
use super::{read_setting, write_setting, Database};
use crate::remote_ssh::RemoteHost;

const HOSTS_KEY: &str = "remote.hosts.v1";

impl Database {
    pub fn list_remote_hosts(&self) -> Result<Vec<RemoteHost>, String> {
        Ok(read_setting(&self.conn.lock(), HOSTS_KEY)?.unwrap_or_default())
    }

    pub fn save_remote_host(&self, mut host: RemoteHost) -> Result<RemoteHost, String> {
        host.name = host.name.trim().to_owned();
        host.target = host.target.trim().to_owned();
        host.identity_file = host.identity_file.filter(|path| !path.trim().is_empty());
        // 配置来源仅由实时发现附加，手动连接记录不复制此标记。
        host.ssh_config_file = None;
        host.validate()?;
        let conn = self.conn.lock();
        let mut hosts: Vec<RemoteHost> = read_setting(&conn, HOSTS_KEY)?.unwrap_or_default();
        if let Some(existing) = hosts.iter_mut().find(|item| item.id == host.id) {
            *existing = host.clone();
        } else {
            if hosts.len() >= 128 {
                return Err("remote_host_limit".into());
            }
            hosts.push(host.clone());
        }
        write_setting(&conn, HOSTS_KEY, &hosts)?;
        Ok(host)
    }

    pub fn delete_remote_host(&self, host_id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        let mut hosts: Vec<RemoteHost> = read_setting(&conn, HOSTS_KEY)?.unwrap_or_default();
        hosts.retain(|host| host.id != host_id);
        write_setting(&conn, HOSTS_KEY, &hosts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, target: &str) -> RemoteHost {
        RemoteHost {
            id: id.into(),
            name: "Linux".into(),
            target: target.into(),
            port: None,
            identity_file: None,
            ssh_config_file: None,
        }
    }

    #[test]
    fn hosts_survive_general_settings_and_are_keyed_by_host_id() {
        let database = Database::open_in_memory();
        database
            .save_remote_host(host("one", "dev@linux-one"))
            .expect("save first host");
        database
            .save_remote_host(host("two", "dev@linux-two"))
            .expect("save second host");
        database
            .save_general_persistent_settings(&Default::default())
            .expect("save settings");
        database
            .save_remote_host(host("one", "dev@updated"))
            .expect("edit host");
        let hosts = database.list_remote_hosts().expect("list hosts");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].target, "dev@updated");
        database.delete_remote_host("one").expect("remove host");
        assert_eq!(
            database.list_remote_hosts().expect("list remaining"),
            vec![host("two", "dev@linux-two")]
        );
    }

    #[test]
    fn invalid_ssh_options_are_rejected_without_changing_saved_hosts() {
        let database = Database::open_in_memory();
        database
            .save_remote_host(host("one", "linux"))
            .expect("save host");
        assert!(database
            .save_remote_host(host("one", "-oProxyCommand=bad"))
            .is_err());
        assert_eq!(
            database.list_remote_hosts().expect("read unchanged")[0].target,
            "linux"
        );
    }
}
