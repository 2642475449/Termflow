//! 只读检查与远程主机列表相同的别名发现逻辑，不建立网络连接。
#[path = "../src/ssh_config.rs"]
mod ssh_config;

fn main() -> Result<(), String> {
    let hosts = ssh_config::discover_default_hosts()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&hosts).map_err(|error| error.to_string())?
    );
    Ok(())
}
