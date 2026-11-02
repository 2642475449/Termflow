// 独立验证 Windows GUI 子系统中的 CLI，不覆盖正在运行的桌面程序。
// cargo run --example runtime_cli_check -- cli --help --json
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    std::process::exit(termflow_lib::runtime_cli::try_run().unwrap_or(2));
}
