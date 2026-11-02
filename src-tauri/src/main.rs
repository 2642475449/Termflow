#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = termflow_lib::runtime_cli::try_run() {
        std::process::exit(code);
    }
    termflow_lib::run();
}
