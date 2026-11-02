//! 同一可执行文件的无界面入口，以及复用 Hook 接收服务的版本化本机 API。
use crate::hook_ingest::HookIngestConfig;
use crate::pty::PtyManager;
use crate::runtime_output::{
    OutputReadError, MAX_READ_BYTES, MAX_RETAINED_TERMINALS, MAX_TERMINAL_OUTPUT_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

pub const API_PATH: &str = "/api/v1/runtime";
const DESCRIPTOR_NAME: &str = "runtime-v1.json";
const MAX_REQUEST_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDescriptor {
    protocol_version: u8,
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeRequest {
    method: String,
    #[serde(default = "empty_params")]
    params: Value,
}

fn empty_params() -> Value {
    json!({})
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {
    project: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadParams {
    terminal: String,
    cursor: Option<String>,
    #[serde(default = "default_tail")]
    tail: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextParams {
    project: String,
    session_id: Option<String>,
    #[serde(default)]
    include_output: bool,
}

fn default_tail() -> usize {
    200
}
fn default_limit() -> usize {
    MAX_READ_BYTES
}

fn success(data: Value) -> Value {
    json!({ "protocolVersion": 1, "ok": true, "data": data })
}
fn failure(code: &str) -> Value {
    json!({ "protocolVersion": 1, "ok": false, "error": { "code": code } })
}

pub(crate) fn data_dir() -> Result<PathBuf, String> {
    dirs_next::data_local_dir()
        .map(|path| path.join("com.termflow.desktop"))
        .ok_or_else(|| "data_dir_unavailable".into())
}

pub(crate) fn descriptor_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(DESCRIPTOR_NAME))
}

pub(crate) fn shim_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("cli").join(if cfg!(windows) {
        "termflow.cmd"
    } else {
        "termflow"
    }))
}

pub(crate) fn write_atomic(path: &Path, data: &[u8], private: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid_path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = private;
    file.write_all(data).map_err(|error| error.to_string())?;
    file.persist(path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

pub(crate) fn publish_descriptor(config: &HookIngestConfig) -> Result<(), String> {
    let descriptor = RuntimeDescriptor {
        protocol_version: 1,
        port: config.port,
        token: config.token.clone(),
        pid: std::process::id(),
    };
    write_atomic(
        &descriptor_path()?,
        &serde_json::to_vec(&descriptor).map_err(|error| error.to_string())?,
        true,
    )
}

pub(crate) fn install_shim() -> Result<PathBuf, String> {
    let path = shim_path()?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    install_shim_at(&path, &crate::path_utils::display_path(executable))?;
    write_atomic(
        &data_dir()?.join("cli").join("README.md"),
        include_bytes!("runtime_cli_guide.md"),
        false,
    )?;
    crate::runtime_skill::install_bundled(&data_dir()?.join("cli"))?;
    write_atomic(
        &data_dir()?.join("cli").join("runtime-context.cjs"),
        include_bytes!("runtime_hooks/context.cjs"),
        false,
    )?;
    Ok(path)
}

fn install_shim_at(path: &Path, executable: &str) -> Result<(), String> {
    let script = if cfg!(windows) {
        // 批处理会等待 GUI 子进程；关闭延迟展开以保留安装目录中的 !。
        format!("@echo off\r\nrem Termflow CLI shim v1\r\nsetlocal DisableDelayedExpansion\r\n\"{}\" cli %*\r\nexit /b %errorlevel%\r\n", executable.replace('%', "%%"))
    } else {
        format!(
            "#!/bin/sh\n# Termflow CLI shim v1\nexec '{}' cli \"$@\"\n",
            executable.replace('\'', "'\\''")
        )
    };
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == script {
            return Ok(());
        }
        if !existing
            .lines()
            .take(2)
            .any(|line| line.contains("Termflow CLI shim v1"))
        {
            return Err("shim_path_occupied".into());
        }
    }
    write_atomic(path, script.as_bytes(), false)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn configure_pty_command(command: &mut portable_pty::CommandBuilder) {
    if let Ok(descriptor) = descriptor_path() {
        command.env("TERMFLOW_RUNTIME_FILE", descriptor);
    }
    if let Ok(shim) = shim_path() {
        if !shim.is_file() {
            return;
        }
        command.env("TERMFLOW_CLI", &shim);
        command.env(
            "TERMFLOW_RUNTIME_HELPER",
            data_dir()
                .unwrap_or_default()
                .join("cli")
                .join("runtime-context.cjs"),
        );
        if let Ok(skill) = crate::runtime_skill::bundled_path() {
            command.env("TERMFLOW_CLI_SKILL", skill);
        }
        command.env(
            "TERMFLOW_CLI_GUIDE",
            data_dir().unwrap_or_default().join("cli").join("README.md"),
        );
        command.env("TERM_PROGRAM", "termflow");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        if let Some(directory) = shim.parent() {
            let inherited = std::env::var_os("PATH").unwrap_or_default();
            let paths =
                std::iter::once(directory.to_path_buf()).chain(std::env::split_paths(&inherited));
            if let Ok(path) = std::env::join_paths(paths) {
                command.env("PATH", path);
            }
        }
    }
}

fn dispatch(
    request: RuntimeRequest,
    manager: &PtyManager,
    projects: impl FnOnce() -> Value,
) -> Value {
    match request.method.as_str() {
        "status" if request.params == json!({}) => success(json!({
            "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id(),
            "runtimeId": manager.runtime_output.runtime_id,
            "cliPath": shim_path().ok().map(crate::path_utils::display_path),
            "agentSkills": crate::runtime_skill::installation_status(),
            "capabilities": ["status", "project.list", "terminal.list", "terminal.read", "context.read"],
            "limits": { "retainedTerminals": MAX_RETAINED_TERMINALS, "outputBytesPerTerminal": MAX_TERMINAL_OUTPUT_BYTES, "readBytes": MAX_READ_BYTES }
        })),
        "project.list" if request.params == json!({}) => success(json!({ "projects": projects() })),
        "context.read" => match serde_json::from_value::<ContextParams>(request.params) {
            Ok(params) if !params.project.is_empty() => {
                match serde_json::to_value(manager.runtime_context.snapshot(
                    &manager.runtime_output,
                    &params.project,
                    params.session_id.as_deref(),
                    params.include_output,
                )) {
                    Ok(data) => success(data),
                    Err(_) => failure("internal_error"),
                }
            }
            _ => failure("invalid_params"),
        },
        "terminal.list" => match serde_json::from_value::<ListParams>(request.params) {
            Ok(params) => success(
                json!({ "terminals": manager.runtime_output.list(params.project.as_deref()) }),
            ),
            Err(_) => failure("invalid_params"),
        },
        "terminal.read" => match serde_json::from_value::<ReadParams>(request.params) {
            Ok(params) => match manager.runtime_output.read(
                &params.terminal,
                params.cursor.as_deref(),
                params.tail,
                params.limit,
            ) {
                Ok(read) => match serde_json::to_value(read) {
                    Ok(data) => success(data),
                    Err(_) => failure("internal_error"),
                },
                Err(OutputReadError::NotFound) => failure("terminal_not_found"),
                Err(OutputReadError::InvalidCursor) => failure("invalid_cursor"),
                Err(OutputReadError::InvalidLimit) => failure("invalid_params"),
            },
            Err(_) => failure("invalid_params"),
        },
        "status" | "project.list" => failure("invalid_params"),
        _ => failure("method_not_found"),
    }
}

// 仅在回环监听器上接收；每次请求均校验令牌，绝不在响应中返回令牌。
fn parse_http_request(
    request: &mut tiny_http::Request,
    token: &str,
) -> Result<RuntimeRequest, (u16, &'static str)> {
    let authorized = request
        .headers()
        .iter()
        .any(|header| header.field.equiv("x-termflow-token") && header.value.as_str() == token);
    if !authorized {
        return Err((401, "unauthorized"));
    }
    if request.method() != &tiny_http::Method::Post {
        return Err((405, "method_not_allowed"));
    }
    if request
        .headers()
        .iter()
        .any(|header| header.field.equiv("origin"))
    {
        return Err((403, "origin_not_allowed"));
    }
    if request
        .body_length()
        .is_some_and(|length| length > MAX_REQUEST_BYTES)
    {
        return Err((413, "request_too_large"));
    }
    let mut body = Vec::new();
    request
        .as_reader()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| (400, "invalid_request"))?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err((413, "request_too_large"));
    }
    serde_json::from_slice(&body).map_err(|_| (400, "invalid_request"))
}

pub(crate) fn handle_request(
    mut request: tiny_http::Request,
    app: &tauri::AppHandle,
    config: &HookIngestConfig,
    manager: &PtyManager,
) {
    let (status, response) = match parse_http_request(&mut request, &config.token) {
        Ok(parsed) => (
            200,
            dispatch(parsed, manager, || {
                let registry =
                    app.state::<std::sync::Arc<crate::commands::window::WindowRegistry>>();
                json!(registry.project_contexts())
            }),
        ),
        Err((status, code)) => (status, failure(code)),
    };
    let mut response =
        tiny_http::Response::from_string(response.to_string()).with_status_code(status);
    if let Ok(header) =
        tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8")
    {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

#[derive(Debug, Default)]
struct CliOptions {
    command: Vec<String>,
    json: bool,
    help: bool,
    language: Option<String>,
    runtime_file: Option<PathBuf>,
    project: Option<String>,
    terminal: Option<String>,
    cursor: Option<String>,
    tail: Option<usize>,
    limit: Option<usize>,
}

fn parse(args: &[String]) -> Result<CliOptions, &'static str> {
    let mut options = CliOptions::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => options.json = true,
            "--help" | "-h" => options.help = true,
            "--runtime-file" | "--lang" | "--project" | "--terminal" | "--cursor" | "--tail"
            | "--limit" => {
                let value = iter
                    .next()
                    .filter(|value| !value.starts_with("--"))
                    .ok_or("invalid_arguments")?;
                match arg.as_str() {
                    "--runtime-file" => options.runtime_file = Some(value.into()),
                    "--lang" if matches!(value.as_str(), "zh-CN" | "en-US") => {
                        options.language = Some(value.clone())
                    }
                    "--project" => options.project = Some(value.clone()),
                    "--terminal" => options.terminal = Some(value.clone()),
                    "--cursor" => options.cursor = Some(value.clone()),
                    "--tail" => {
                        options.tail = Some(value.parse().map_err(|_| "invalid_arguments")?)
                    }
                    "--limit" => {
                        options.limit = Some(value.parse().map_err(|_| "invalid_arguments")?)
                    }
                    _ => return Err("invalid_arguments"),
                }
            }
            arg if arg.starts_with('-') => return Err("invalid_arguments"),
            _ => options.command.push(arg.clone()),
        }
    }
    Ok(options)
}

fn build_request(options: &CliOptions) -> Result<RuntimeRequest, &'static str> {
    let commands: Vec<_> = options.command.iter().map(String::as_str).collect();
    let read_flags = options.terminal.is_some()
        || options.cursor.is_some()
        || options.tail.is_some()
        || options.limit.is_some();
    match commands.as_slice() {
        ["status"] | ["project", "list"] if !read_flags && options.project.is_none() => {
            Ok(RuntimeRequest {
                method: if commands[0] == "status" {
                    "status"
                } else {
                    "project.list"
                }
                .into(),
                params: json!({}),
            })
        }
        ["terminal", "list"] if !read_flags => Ok(RuntimeRequest {
            method: "terminal.list".into(),
            params: json!({ "project": options.project }),
        }),
        ["terminal", "read"]
            if options.project.is_none()
                && !(options.cursor.is_some() && options.tail.is_some()) =>
        {
            let terminal = options
                .terminal
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or("invalid_arguments")?;
            let tail = options.tail.unwrap_or_else(default_tail);
            let limit = options.limit.unwrap_or_else(default_limit);
            if !(1..=10_000).contains(&tail) || !(4..=MAX_READ_BYTES).contains(&limit) {
                return Err("invalid_arguments");
            }
            Ok(RuntimeRequest {
                method: "terminal.read".into(),
                params: json!({ "terminal": terminal, "cursor": options.cursor, "tail": tail, "limit": limit }),
            })
        }
        _ => Err("invalid_arguments"),
    }
}

fn request_runtime(request: &RuntimeRequest, path: &Path) -> Result<Value, String> {
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|_| "runtime_unavailable")?
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "invalid_runtime_descriptor")?;
    if data.len() > MAX_REQUEST_BYTES {
        return Err("invalid_runtime_descriptor".into());
    }
    let descriptor: RuntimeDescriptor =
        serde_json::from_slice(&data).map_err(|_| "invalid_runtime_descriptor")?;
    if descriptor.protocol_version != 1 || descriptor.port == 0 || descriptor.token.len() < 16 {
        return Err("invalid_runtime_descriptor".into());
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "runtime_unavailable")?;
    let response = client
        .post(format!("http://127.0.0.1:{}{API_PATH}", descriptor.port))
        .header("x-termflow-token", descriptor.token)
        .json(request)
        .send()
        .map_err(|_| "runtime_unavailable")?;
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "invalid_runtime_response")?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("invalid_runtime_response".into());
    }
    let response: Value = serde_json::from_slice(&body).map_err(|_| "invalid_runtime_response")?;
    if response["protocolVersion"] != 1 || !response["ok"].is_boolean() {
        return Err("invalid_runtime_response".into());
    }
    Ok(response)
}

fn messages(language: Option<&str>) -> Value {
    let language = language
        .map(String::from)
        .or_else(|| std::env::var("TERMFLOW_CLI_LANGUAGE").ok())
        .or_else(|| std::env::var("LANG").ok())
        .unwrap_or_else(|| "en-US".into());
    let source = if language.starts_with("zh") {
        include_str!("../../src/locales/zh-CN.json")
    } else {
        include_str!("../../src/locales/en-US.json")
    };
    serde_json::from_str::<Value>(source)
        .ok()
        .and_then(|mut value| value.get_mut("runtimeCli").map(Value::take))
        .unwrap_or_default()
}

fn help(messages: &Value) -> String {
    let text = |key: &str| messages[key].as_str().unwrap_or(key).to_string();
    format!("Termflow CLI {}\n{}\n\n{}\n  termflow status [--json]\n  termflow project list [--json]\n  termflow terminal list [--project PATH] [--json]\n  termflow terminal read --terminal ID [--tail 200 | --cursor CURSOR] [--limit 65536] [--json]\n  termflow path [--json]\n  termflow install [--json]\n\n{}\n  --runtime-file PATH\n  --lang zh-CN|en-US\n  --help\n\n{}\n", env!("CARGO_PKG_VERSION"), text("description"), text("usage"), text("options"), text("retention"))
}

fn print_output(value: &Value, json_mode: bool, read: bool) -> Result<(), std::io::Error> {
    let mut stdout = std::io::stdout().lock();
    if !json_mode && read && value["ok"] == true {
        stdout.write_all(
            value["data"]["text"]
                .as_str()
                .unwrap_or_default()
                .as_bytes(),
        )?;
    } else if json_mode {
        writeln!(stdout, "{value}")?;
    } else {
        writeln!(
            stdout,
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_default()
        )?;
    }
    Ok(())
}

/// CLI 必须在 Tauri Builder/单实例插件之前退出，避免拉起窗口或误当作项目路径。
pub fn try_run() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("cli") {
        return None;
    }
    prepare_console();
    let parsed = parse(&args[1..]);
    let json_mode = args.iter().any(|arg| arg == "--json");
    let options = match parsed {
        Ok(options) => options,
        Err(code) => {
            let mut error = failure(code);
            error["error"]["message"] = messages(None)["errors"][code].clone();
            let _ = print_output(&error, json_mode, false);
            return Some(2);
        }
    };
    let translations = messages(options.language.as_deref());
    if options.help || options.command.is_empty() || options.command == ["help"] {
        if options.json {
            let _ = print_output(
                &success(json!({ "help": help(&translations) })),
                true,
                false,
            );
        } else {
            let _ = std::io::stdout().write_all(help(&translations).as_bytes());
        }
        return Some(0);
    }
    let result = if options.command == ["path"] || options.command == ["install"] {
        if options.project.is_some()
            || options.terminal.is_some()
            || options.cursor.is_some()
            || options.tail.is_some()
            || options.limit.is_some()
        {
            Err("invalid_arguments".into())
        } else if options.command == ["install"] {
            install_shim()
                .map(|path| success(json!({ "cliPath": crate::path_utils::display_path(path) })))
        } else {
            shim_path().and_then(|path| Ok(success(json!({ "cliPath": crate::path_utils::display_path(path), "runtimeFile": crate::path_utils::display_path(descriptor_path()?) }))))
        }
    } else {
        build_request(&options)
            .map_err(String::from)
            .and_then(|request| {
                let path = options
                    .runtime_file
                    .clone()
                    .or_else(|| std::env::var_os("TERMFLOW_RUNTIME_FILE").map(PathBuf::from))
                    .map(Ok)
                    .unwrap_or_else(descriptor_path)?;
                request_runtime(&request, &path)
            })
    };
    let value = result.unwrap_or_else(|code| failure(&code));
    let mut value = value;
    if value["ok"] == false {
        if let Some(code) = value["error"]["code"].as_str().map(String::from) {
            value["error"]["message"] = Value::String(
                translations["errors"][&code]
                    .as_str()
                    .unwrap_or_else(|| {
                        translations["errors"]["unknown"]
                            .as_str()
                            .unwrap_or("unknown")
                    })
                    .to_string(),
            );
        }
    }
    let exit = if value["ok"] == true {
        0
    } else if value["error"]["code"] == "invalid_arguments" {
        2
    } else {
        1
    };
    if let Err(error) = print_output(
        &value,
        options.json,
        options.command == ["terminal", "read"],
    ) {
        return Some(if error.kind() == std::io::ErrorKind::BrokenPipe {
            0
        } else {
            1
        });
    }
    Some(exit)
}

#[cfg(windows)]
fn prepare_console() {
    // 保留脚本/AI 已经重定向的 stdout；仅在 GUI 子系统未获得句柄时附加父控制台。
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(kind: u32) -> *mut std::ffi::c_void;
        fn AttachConsole(pid: u32) -> i32;
    }
    unsafe {
        let handle = GetStdHandle((-11i32) as u32);
        if handle.is_null() || handle as isize == -1 {
            AttachConsole(u32::MAX);
        }
    }
}

#[cfg(not(windows))]
fn prepare_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_commands_without_needing_the_desktop_runtime() {
        let parsed = parse(&args(&[
            "terminal",
            "read",
            "--terminal",
            "run-1",
            "--cursor",
            "run-1:42",
            "--json",
        ]))
        .unwrap();
        let request = build_request(&parsed).unwrap();
        assert_eq!(request.method, "terminal.read");
        assert_eq!(request.params["cursor"], "run-1:42");
        assert!(parsed.json);
    }

    #[test]
    fn rejects_missing_values_unknown_flags_and_ambiguous_read_options() {
        assert!(parse(&args(&["terminal", "read", "--terminal", "--json"])).is_err());
        assert!(parse(&args(&["--anything"])).is_err());
        for values in [
            vec!["terminal", "read"],
            vec!["status", "--terminal", "x"],
            vec![
                "terminal",
                "read",
                "--terminal",
                "x",
                "--tail",
                "1",
                "--cursor",
                "x:0",
            ],
            vec!["terminal", "read", "--terminal", "x", "--limit", "99999999"],
        ] {
            assert!(build_request(&parse(&args(&values)).unwrap()).is_err());
        }
    }

    #[test]
    fn shims_quote_install_paths_and_do_not_overwrite_foreign_scripts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(if cfg!(windows) {
            "termflow.cmd"
        } else {
            "termflow"
        });
        install_shim_at(&path, "C:/a b/100%/termflow.exe").unwrap();
        let script = fs::read_to_string(&path).unwrap();
        assert!(script.contains("Termflow CLI shim v1"));
        assert!(script.contains(" cli "));
        install_shim_at(&path, "C:/updated/termflow.exe").unwrap();
        fs::write(&path, "my own script").unwrap();
        assert_eq!(
            install_shim_at(&path, "other"),
            Err("shim_path_occupied".into())
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "my own script");
    }

    #[test]
    fn localized_help_and_errors_are_present_in_both_languages() {
        for language in ["zh-CN", "en-US"] {
            let messages = messages(Some(language));
            assert!(help(&messages).contains("terminal read"));
            assert!(messages["description"].as_str().unwrap().len() > 10);
            assert!(messages["errors"]["runtime_unavailable"].is_string());
        }
    }

    #[test]
    fn discovery_rejects_corrupt_descriptors_without_leaking_contents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime.json");
        fs::write(&path, "private-token-not-json").unwrap();
        let request = RuntimeRequest {
            method: "status".into(),
            params: json!({}),
        };
        assert_eq!(
            request_runtime(&request, &path),
            Err("invalid_runtime_descriptor".into())
        );
        assert_eq!(
            request_runtime(&request, &directory.path().join("missing")),
            Err("runtime_unavailable".into())
        );
    }

    #[test]
    fn client_sends_authenticated_versioned_requests_and_preserves_json_results() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime.json");
        fs::write(
            &path,
            serde_json::to_vec(&RuntimeDescriptor {
                protocol_version: 1,
                port,
                token: "fixture-token-long-enough".into(),
                pid: 1,
            })
            .unwrap(),
        )
        .unwrap();
        let worker = std::thread::spawn(move || {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.url(), API_PATH);
            assert!(request
                .headers()
                .iter()
                .any(|header| header.field.equiv("x-termflow-token")
                    && header.value.as_str() == "fixture-token-long-enough"));
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap()["method"],
                "terminal.list"
            );
            request
                .respond(tiny_http::Response::from_string(
                    success(json!({ "terminals": [] })).to_string(),
                ))
                .unwrap();
        });
        let response = request_runtime(
            &RuntimeRequest {
                method: "terminal.list".into(),
                params: json!({}),
            },
            &path,
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(response["data"]["terminals"], json!([]));
    }

    #[test]
    fn api_dispatch_filters_projects_preserves_exit_status_and_rejects_unknown_methods() {
        let manager = PtyManager::new(std::sync::Arc::new(HookIngestConfig {
            port: 0,
            token: "secret".into(),
        }));
        let output = manager
            .runtime_output
            .start("s", 1, "project", "cmd", 1, None);
        output.lock().append("error 中文");
        output.lock().finish(Some(7), false);
        let call = |method: &str, params: Value| {
            dispatch(
                RuntimeRequest {
                    method: method.into(),
                    params,
                },
                &manager,
                || json!([{ "projectPath": "project" }]),
            )
        };
        let status = call("status", json!({}));
        assert_eq!(status["ok"], true);
        assert!(!status.to_string().contains("secret"));
        assert_eq!(
            call("project.list", json!({}))["data"]["projects"][0]["projectPath"],
            "project"
        );
        assert_eq!(
            call("terminal.list", json!({ "project": "other" }))["data"]["terminals"],
            json!([])
        );
        let list = call("terminal.list", json!({}));
        let id = list["data"]["terminals"][0]["id"].as_str().unwrap();
        let read = call("terminal.read", json!({ "terminal": id }));
        assert_eq!(read["data"]["text"], "error 中文");
        assert_eq!(read["data"]["terminal"]["exitCode"], 7);
        let context = call(
            "context.read",
            json!({ "project": "project", "sessionId": "agent", "includeOutput": true }),
        );
        assert_eq!(context["data"]["selectedRun"]["id"], id);
        assert_eq!(context["data"]["output"]["text"], "error 中文");
        assert_eq!(
            call("context.read", json!({ "project": "project" }))["data"]["output"],
            Value::Null
        );
        assert_eq!(
            call("context.read", json!({ "project": "" }))["error"]["code"],
            "invalid_params"
        );
        assert_eq!(
            call(
                "context.read",
                json!({ "project": "project", "prompt": "do not forward user text" })
            )["error"]["code"],
            "invalid_params"
        );
        assert_eq!(
            call("terminal.send", json!({}))["error"]["code"],
            "method_not_found"
        );
        assert_eq!(
            call("terminal.read", json!({ "terminal": id, "limit": 9999999 }))["error"]["code"],
            "invalid_params"
        );
        assert_eq!(
            call("terminal.list", json!({ "unexpected": true }))["error"]["code"],
            "invalid_params"
        );
    }

    #[test]
    fn http_gate_requires_authentication_and_rejects_origins_large_bodies_and_invalid_json() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = format!("http://{}{}", server.server_addr(), API_PATH);
        let worker = std::thread::spawn(move || {
            for expected in [
                "unauthorized",
                "origin_not_allowed",
                "request_too_large",
                "invalid_request",
                "status",
            ] {
                let mut request = server
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .unwrap();
                let code = match parse_http_request(&mut request, "fixture") {
                    Ok(parsed) => parsed.method,
                    Err((_, code)) => code.to_string(),
                };
                assert_eq!(code, expected);
                request
                    .respond(tiny_http::Response::from_string(code))
                    .unwrap();
            }
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert_eq!(
            client
                .post(&address)
                .body("{}")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "unauthorized"
        );
        assert_eq!(
            client
                .post(&address)
                .header("x-termflow-token", "fixture")
                .header("Origin", "http://example.invalid")
                .body("{}")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "origin_not_allowed"
        );
        assert_eq!(
            client
                .post(&address)
                .header("x-termflow-token", "fixture")
                .body("x".repeat(MAX_REQUEST_BYTES + 1))
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "request_too_large"
        );
        assert_eq!(
            client
                .post(&address)
                .header("x-termflow-token", "fixture")
                .body("invalid")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "invalid_request"
        );
        assert_eq!(
            client
                .post(&address)
                .header("x-termflow-token", "fixture")
                .json(&json!({ "method": "status" }))
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "status"
        );
        worker.join().unwrap();
    }
}
