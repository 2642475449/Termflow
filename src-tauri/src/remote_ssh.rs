//! SSH 仅拥有传输；Linux 助手独立拥有远端 PTY，断开不会调用远端停止接口。
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, PtyPair, PtySize};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const HELPER_SOURCE: &str = include_str!("../remote/termflow_remote.py");
const AUTH_OUTPUT_LIMIT: usize = 32 * 1024;
const MAX_RPC_BYTES: usize = 2 * 1024 * 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(600);
const DEPLOY_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_config_file: Option<String>,
}

impl RemoteHost {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("remote_invalid_host_id".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 256 {
            return Err("remote_invalid_host_name".into());
        }
        // target 是单独的 ssh argv，只允许 SSH 别名或 user@host，不能插入选项/命令。
        if self.target.is_empty()
            || self.target.len() > 512
            || self.target.starts_with('-')
            || !self.target.chars().all(|c| {
                c.is_alphanumeric()
                    || matches!(c, '.' | '-' | '_' | '@' | ':' | '[' | ']' | '%' | '+')
            })
        {
            return Err("remote_invalid_ssh_target".into());
        }
        if self.port == Some(0) {
            return Err("remote_invalid_ssh_port".into());
        }
        if self.identity_file.as_ref().is_some_and(|path| {
            path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control)
        }) {
            return Err("remote_invalid_identity_file".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteConnectionState {
    Disconnected,
    Connecting,
    Authenticating,
    Deploying,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerInfo {
    pub port: u16,
    pub version: u32,
    pub pid: u32,
    pub root: String,
    pub protocol: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionInfo {
    pub host_id: String,
    pub state: RemoteConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub auth_output: String,
    pub auth_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<RemoteServerInfo>,
}

#[derive(Clone, Deserialize)]
struct ServerDescriptor {
    port: u16,
    token: String,
    version: u32,
    pid: u32,
    root: String,
    protocol: u32,
}

impl ServerDescriptor {
    fn validate(&self) -> Result<(), String> {
        if self.port == 0
            || self.pid == 0
            || self.version != 1
            || self.protocol != 1
            || self.token.len() < 16
            || self.token.len() > 512
            || !self
                .token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            || !self.root.starts_with('/')
            || self.root.len() > 4096
            || self.root.chars().any(char::is_control)
        {
            return Err("remote_invalid_server_descriptor".into());
        }
        Ok(())
    }

    fn public(&self) -> RemoteServerInfo {
        RemoteServerInfo {
            port: self.port,
            version: self.version,
            pid: self.pid,
            root: self.root.clone(),
            protocol: self.protocol,
        }
    }
}

struct SshProcess {
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn Write + Send>,
    _pty: PtyPair,
}

impl Drop for SshProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Connection {
    host: RemoteHost,
    info: Mutex<RemoteConnectionInfo>,
    process: Mutex<Option<SshProcess>>,
    server: Mutex<Option<ServerDescriptor>>,
    client: Mutex<Option<Client>>,
    cancelled: AtomicBool,
    auth_utf8_tail: Mutex<Vec<u8>>,
}

impl Connection {
    fn new(host: RemoteHost) -> Arc<Self> {
        Arc::new(Self {
            info: Mutex::new(RemoteConnectionInfo {
                host_id: host.id.clone(),
                state: RemoteConnectionState::Connecting,
                error: None,
                auth_output: String::new(),
                auth_revision: 0,
                server: None,
            }),
            host,
            process: Mutex::new(None),
            server: Mutex::new(None),
            client: Mutex::new(None),
            cancelled: AtomicBool::new(false),
            auth_utf8_tail: Mutex::new(Vec::new()),
        })
    }

    fn append_auth(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut tail = self.auth_utf8_tail.lock();
        tail.extend_from_slice(bytes);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&tail) {
                Ok(valid) => {
                    text.push_str(valid);
                    tail.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(&String::from_utf8_lossy(&tail[..valid]));
                    if let Some(invalid) = error.error_len() {
                        text.push('\u{fffd}');
                        tail.drain(..valid + invalid);
                    } else {
                        tail.drain(..valid);
                        break;
                    }
                }
            }
        }
        drop(tail);
        let mut info = self.info.lock();
        info.auth_output.push_str(&text);
        if info.auth_output.len() > AUTH_OUTPUT_LIMIT {
            let mut start = info.auth_output.len() - AUTH_OUTPUT_LIMIT;
            while !info.auth_output.is_char_boundary(start) {
                start += 1;
            }
            info.auth_output.drain(..start);
        }
        info.auth_revision += 1;
    }

    fn fail(&self, error: String) {
        if !self.cancelled.load(Ordering::Acquire) {
            let mut info = self.info.lock();
            info.state = RemoteConnectionState::Error;
            info.error = Some(error);
        }
    }

    fn disconnect(&self) {
        self.cancelled.store(true, Ordering::Release);
        // 只关闭本机 ssh，绝不发送 sessions.stop/server.stop。
        self.process.lock().take();
        self.client.lock().take();
        self.server.lock().take();
        let mut info = self.info.lock();
        info.state = RemoteConnectionState::Disconnected;
        info.error = None;
    }
}

pub struct RemoteSshManager {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
}

impl RemoteSshManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connections: Mutex::new(HashMap::new()),
        })
    }

    pub fn connect(self: &Arc<Self>, host: RemoteHost) -> Result<RemoteConnectionInfo, String> {
        host.validate()?;
        let connection = Connection::new(host.clone());
        let mut connections = self.connections.lock();
        if let Some(existing) = connections.get(&host.id) {
            let info = existing.info.lock().clone();
            if existing.host == host
                && matches!(
                    info.state,
                    RemoteConnectionState::Connecting
                        | RemoteConnectionState::Authenticating
                        | RemoteConnectionState::Deploying
                        | RemoteConnectionState::Connected
                )
            {
                return Ok(info);
            }
            existing.disconnect();
        }
        connections.insert(host.id, connection.clone());
        drop(connections);
        let snapshot = connection.info.lock().clone();
        thread::spawn(move || {
            if let Err(error) = start_ssh(connection.clone()) {
                connection.fail(error);
                connection.process.lock().take();
            }
        });
        Ok(snapshot)
    }

    fn get(&self, host_id: &str) -> Result<Arc<Connection>, String> {
        self.connections
            .lock()
            .get(host_id)
            .cloned()
            .ok_or_else(|| "remote_not_connected".into())
    }

    pub fn connection(&self, host_id: &str) -> Result<RemoteConnectionInfo, String> {
        Ok(self.get(host_id)?.info.lock().clone())
    }

    pub fn auth_input(&self, host_id: &str, data: &str) -> Result<(), String> {
        if data.len() > 16 * 1024 {
            return Err("remote_auth_input_too_large".into());
        }
        let connection = self.get(host_id)?;
        let info = connection.info.lock();
        if info.state != RemoteConnectionState::Authenticating {
            return Err("remote_auth_not_active".into());
        }
        let mut process = connection.process.lock();
        let process = process.as_mut().ok_or("remote_not_connected")?;
        process
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| process.writer.flush())
            .map_err(|_| "remote_auth_input_failed".into())
    }

    pub fn disconnect(&self, host_id: &str) -> Result<RemoteConnectionInfo, String> {
        let connection = match self.connections.lock().get(host_id).cloned() {
            Some(connection) => connection,
            None => {
                return Ok(RemoteConnectionInfo {
                    host_id: host_id.into(),
                    state: RemoteConnectionState::Disconnected,
                    error: None,
                    auth_output: String::new(),
                    auth_revision: 0,
                    server: None,
                })
            }
        };
        connection.disconnect();
        let snapshot = connection.info.lock().clone();
        Ok(snapshot)
    }

    pub fn disconnect_all(&self) {
        for connection in self.connections.lock().values() {
            connection.disconnect();
        }
    }

    pub fn request(&self, host_id: &str, method: &str, params: Value) -> Result<Value, String> {
        if method.is_empty()
            || method.len() > 80
            || method.chars().any(char::is_control)
            || !params.is_object()
        {
            return Err("remote_invalid_request".into());
        }
        let body = serde_json::to_vec(&json!({ "method": method, "params": params }))
            .map_err(|_| "remote_invalid_request")?;
        if body.len() > MAX_RPC_BYTES {
            return Err("remote_request_too_large".into());
        }
        let connection = self.get(host_id)?;
        if connection.info.lock().state != RemoteConnectionState::Connected {
            return Err("remote_not_connected".into());
        }
        let server = connection
            .server
            .lock()
            .clone()
            .ok_or("remote_not_connected")?;
        let client = connection
            .client
            .lock()
            .clone()
            .ok_or("remote_not_connected")?;
        let timeout = match method {
            "inspect" => 35,
            // 首次启动可能探测登录 shell 和 CLI 帮助；避免把短暂锁等待误报为 SSH 断线。
            "sessions.create" => 30,
            "sessions.read" | "sessions.list" => 20,
            _ => 12,
        };
        let response = client
            .post(format!("http://127.0.0.1:{}/rpc", server.port))
            .header("X-Termflow-Token", &server.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(Duration::from_secs(timeout))
            .body(body)
            .send()
            .map_err(|_| {
                connection.fail("remote_transport_failed".into());
                "remote_transport_failed".to_string()
            })?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RPC_BYTES as u64)
        {
            return Err("remote_response_too_large".into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_RPC_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "remote_response_failed")?;
        if bytes.len() > MAX_RPC_BYTES {
            return Err("remote_response_too_large".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "remote_invalid_response")?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(error.chars().take(2048).collect());
        }
        if !status.is_success() {
            return Err(format!("remote_http_error:{}", status.as_u16()));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| "remote_invalid_response".into())
    }
}

impl Drop for RemoteSshManager {
    fn drop(&mut self) {
        self.disconnect_all();
    }
}

fn ssh_program() -> PathBuf {
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        let path = PathBuf::from(root)
            .join("System32")
            .join("OpenSSH")
            .join("ssh.exe");
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from("ssh")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn ssh_args(host: &RemoteHost, local_port: u16, bootstrap: &str) -> Vec<String> {
    let mut args = vec![
        "-T".into(),
        "-D".into(),
        format!("127.0.0.1:{local_port}"),
        "-o".into(),
        "BatchMode=no".into(),
        "-o".into(),
        "StrictHostKeyChecking=ask".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ConnectTimeout=20".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ];
    // 集成测试使用隔离 config/known_hosts，生产构建不会读取这个覆盖项。
    #[cfg(test)]
    if let Some(config) = std::env::var_os("TERMFLOW_SSH_TEST_CONFIG") {
        args.extend(["-F".into(), config.to_string_lossy().into_owned()]);
    }
    if let Some(port) = host.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity) = &host.identity_file {
        args.extend(["-i".into(), identity.clone()]);
    }
    args.extend([
        "--".into(),
        host.target.clone(),
        format!("if command -v python3 >/dev/null 2>&1; then exec python3 -c {}; else printf '%s\\n' remote_python_required; exit 127; fi", shell_quote(bootstrap)),
    ]);
    args
}

fn bootstrap_source(nonce: &str, source: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(source.as_bytes()));
    // 代码在 SSH command 中，助手源码在认证完成后分帧上传，避开 Windows argv 长度限制。
    format!(
        r#"import os,sys,base64,hashlib,subprocess,json
N='{nonce}'
E='__TF_REMOTE_END__'
def emit(kind,data=''):
 print('\r\n__TF_REMOTE_'+N+'_'+kind+'__'+data+E,flush=True)
try:
 if sys.platform!='linux': raise RuntimeError('remote_linux_required')
 if sys.version_info<(3,8): raise RuntimeError('remote_python_version')
 root=os.path.join(os.path.expanduser('~'),'.local','share','termflow','remote')
 os.makedirs(root,mode=0o700,exist_ok=True)
 if os.path.islink(root) or os.stat(root).st_uid!=os.getuid(): raise RuntimeError('remote_unsafe_install_directory')
 os.chmod(root,0o700)
 emit('UPLOAD')
 chunks=[]
 size=0
 while True:
  line=sys.stdin.buffer.readline(4096).strip()
  if line==b'.': break
  if not line: raise RuntimeError('remote_upload_interrupted')
  size+=len(line)
  if size>2097152: raise RuntimeError('remote_upload_too_large')
  chunks.append(line)
 data=base64.b64decode(b''.join(chunks),validate=True)
 if hashlib.sha256(data).hexdigest()!='{digest}': raise RuntimeError('remote_upload_checksum')
 script=os.path.join(root,'helper-{digest}.py')
 temp=os.path.join(root,'.upload-'+N)
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 try:
  with os.fdopen(fd,'wb') as f: f.write(data)
  os.replace(temp,script)
 finally:
  if os.path.exists(temp): os.unlink(temp)
 started=subprocess.run([sys.executable,script,'start','--root',root],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=40)
 if started.returncode: raise RuntimeError('remote_helper_start_failed')
 descriptor=json.loads(started.stdout.decode().strip().splitlines()[-1])
 emit('READY',base64.b64encode(json.dumps(descriptor).encode()).decode())
 sys.stdin.buffer.read()
except Exception as e:
 emit('ERROR',base64.b64encode(str(e).encode()).decode())
 sys.exit(1)
"#
    )
}

enum GateAction {
    Auth(Vec<u8>),
    Upload,
    Ready(ServerDescriptor),
    Error(String),
}

struct OutputGate {
    upload: Vec<u8>,
    ready: Vec<u8>,
    error: Vec<u8>,
    pending: Vec<u8>,
    uploaded: bool,
    done: bool,
    formatting: FrameFormatting,
}

#[derive(Default)]
struct FrameFormatting {
    state: u8,
}

impl FrameFormatting {
    // ConPTY 的回显与重绘可能在长控制帧中插入换行或 VT 光标指令。
    fn normalize(&mut self, input: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(input.len());
        for &byte in input {
            match self.state {
                0 => match byte {
                    27 => self.state = 1,
                    b'\r' | b'\n' => {}
                    _ => output.push(byte),
                },
                1 => {
                    self.state = match byte {
                        b'[' => 2,
                        b']' => 3,
                        _ => 0,
                    }
                }
                2 => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.state = 0;
                    }
                }
                3 => match byte {
                    7 => self.state = 0,
                    27 => self.state = 4,
                    _ => {}
                },
                _ => self.state = if byte == b'\\' { 0 } else { 3 },
            }
        }
        output
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

impl OutputGate {
    fn new(nonce: &str) -> Self {
        Self {
            upload: format!("__TF_REMOTE_{nonce}_UPLOAD____TF_REMOTE_END__").into_bytes(),
            ready: format!("__TF_REMOTE_{nonce}_READY__").into_bytes(),
            error: format!("__TF_REMOTE_{nonce}_ERROR__").into_bytes(),
            pending: Vec::new(),
            uploaded: false,
            done: false,
            formatting: FrameFormatting::default(),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<GateAction> {
        if self.done {
            return Vec::new();
        }
        if self.uploaded {
            self.pending.extend(self.formatting.normalize(bytes));
        } else {
            self.pending.extend_from_slice(bytes);
        }
        let mut actions = Vec::new();
        if self.uploaded && self.pending.len() > 128 * 1024 {
            self.pending.clear();
            self.done = true;
            return vec![GateAction::Error("remote_control_frame_too_large".into())];
        }
        if !self.uploaded {
            if let Some(at) = find_bytes(&self.pending, &self.error) {
                if at > 0 {
                    actions.push(GateAction::Auth(self.pending[..at].to_vec()));
                }
                self.pending.drain(..at);
                // 版本/平台检测会先于上传失败，同样通过受控 ERROR 帧回传。
                self.uploaded = true;
                self.pending = self.formatting.normalize(&self.pending);
            } else if let Some(at) = find_bytes(&self.pending, &self.upload) {
                if at > 0 {
                    actions.push(GateAction::Auth(self.pending[..at].to_vec()));
                }
                self.pending.drain(..at + self.upload.len());
                self.uploaded = true;
                self.pending = self.formatting.normalize(&self.pending);
                actions.push(GateAction::Upload);
            } else {
                // 保留可能被分块的标记前缀；普通无换行密码提示立即显示。
                let keep = [&self.upload, &self.error]
                    .into_iter()
                    .map(|marker| {
                        (1..marker.len().min(self.pending.len()) + 1)
                            .rev()
                            .find(|&n| self.pending.ends_with(&marker[..n]))
                            .unwrap_or(0)
                    })
                    .max()
                    .unwrap_or(0);
                let end = self.pending.len() - keep;
                if end > 0 {
                    actions.push(GateAction::Auth(self.pending.drain(..end).collect()));
                }
                return actions;
            }
        }
        let end_marker = b"__TF_REMOTE_END__";
        let ready_at = find_bytes(&self.pending, &self.ready).map(|at| (at, false));
        let error_at = find_bytes(&self.pending, &self.error).map(|at| (at, true));
        if let Some((at, is_error)) = ready_at.or(error_at) {
            let start = at
                + if is_error {
                    self.error.len()
                } else {
                    self.ready.len()
                };
            if let Some(end) = find_bytes(&self.pending[start..], end_marker) {
                let encoded = &self.pending[start..start + end];
                let decoded = STANDARD.decode(encoded);
                let action = if is_error {
                    GateAction::Error(
                        decoded
                            .ok()
                            .and_then(|s| String::from_utf8(s).ok())
                            .filter(|s| s.len() < 256 && !s.contains('\n'))
                            .unwrap_or_else(|| "remote_deployment_failed".into()),
                    )
                } else {
                    match decoded
                        .ok()
                        .and_then(|s| serde_json::from_slice::<ServerDescriptor>(&s).ok())
                    {
                        Some(server) if server.validate().is_ok() => GateAction::Ready(server),
                        _ => GateAction::Error("remote_invalid_server_descriptor".into()),
                    }
                };
                self.done = true;
                self.pending.clear();
                actions.push(action);
            }
        } else if self.pending.len() > 16 * 1024 {
            self.pending.drain(..self.pending.len() - 512);
        }
        actions
    }
}

fn client_for_proxy(local_port: u16) -> Result<Client, String> {
    let proxy = reqwest::Proxy::all(format!("socks5h://127.0.0.1:{local_port}"))
        .map_err(|_| "remote_proxy_failed")?;
    Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "remote_proxy_failed".into())
}

fn verify_forwarding(client: &Client, server: &ServerDescriptor) -> Result<(), String> {
    // SSH 登录成功不代表 sshd 允许 TCP 转发；收到 hello 后才能显示 connected。
    let response = client
        .post(format!("http://127.0.0.1:{}/rpc", server.port))
        .header("X-Termflow-Token", &server.token)
        .json(&json!({"method":"hello", "params":{}}))
        .timeout(Duration::from_secs(10))
        .send()
        .map_err(|_| "remote_ssh_forwarding_failed")?;
    if !response.status().is_success() {
        return Err("remote_helper_handshake_failed".into());
    }
    let mut bytes = Vec::new();
    response
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "remote_helper_handshake_failed")?;
    if bytes.len() > 32 * 1024 {
        return Err("remote_helper_handshake_failed".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "remote_helper_handshake_failed")?;
    if value
        .get("result")
        .and_then(|result| result.get("protocol"))
        .and_then(Value::as_u64)
        != Some(1)
    {
        return Err("remote_helper_handshake_failed".into());
    }
    Ok(())
}

fn start_ssh(connection: Arc<Connection>) -> Result<(), String> {
    let reservation = TcpListener::bind("127.0.0.1:0").map_err(|_| "remote_local_port_failed")?;
    let local_port = reservation
        .local_addr()
        .map_err(|_| "remote_local_port_failed")?
        .port();
    let nonce = format!("{:032x}", rand::random::<u128>());
    let bootstrap = bootstrap_source(&nonce, HELPER_SOURCE);
    let pty = portable_pty::native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 4096,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "remote_auth_terminal_failed")?;
    let mut command = CommandBuilder::new(ssh_program());
    for arg in ssh_args(&connection.host, local_port, &bootstrap) {
        command.arg(arg);
    }
    command.env("TERM", "xterm-256color");
    // 不启动真实窗口；认证提示通过这个本机 PTY 转发给受控认证终端。
    drop(reservation);
    let writer = pty
        .master
        .take_writer()
        .map_err(|_| "remote_auth_terminal_failed")?;
    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|_| "remote_auth_terminal_failed")?;
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|error| format!("remote_ssh_start_failed: {error}"))?;
    if connection.cancelled.load(Ordering::Acquire) {
        drop(SshProcess {
            child,
            writer,
            _pty: pty,
        });
        return Ok(());
    }
    {
        let mut info = connection.info.lock();
        if connection.cancelled.load(Ordering::Acquire) {
            drop(SshProcess {
                child,
                writer,
                _pty: pty,
            });
            return Ok(());
        }
        *connection.process.lock() = Some(SshProcess {
            child,
            writer,
            _pty: pty,
        });
        info.state = RemoteConnectionState::Authenticating;
    }
    let watchdog = connection.clone();
    thread::spawn(move || monitor_connection(watchdog));
    let mut gate = OutputGate::new(&nonce);
    let mut bytes = [0; 8192];
    loop {
        let read = match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if connection.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        for action in gate.push(&bytes[..read]) {
            match action {
                GateAction::Auth(data) => connection.append_auth(&data),
                GateAction::Upload => {
                    {
                        let mut info = connection.info.lock();
                        if connection.cancelled.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        info.state = RemoteConnectionState::Deploying;
                    }
                    // ConPTY 会回显上传数据；写线程与读线程分离，避免回显填满管道后互相等待。
                    let uploading = connection.clone();
                    thread::spawn(move || {
                        if let Err(error) = upload_helper(&uploading) {
                            uploading.fail(error);
                            uploading.process.lock().take();
                        }
                    });
                }
                GateAction::Ready(server) => {
                    let client = client_for_proxy(local_port)?;
                    verify_forwarding(&client, &server)?;
                    let mut info = connection.info.lock();
                    if connection.cancelled.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    *connection.client.lock() = Some(client);
                    let public = server.public();
                    *connection.server.lock() = Some(server);
                    info.server = Some(public);
                    info.state = RemoteConnectionState::Connected;
                    info.error = None;
                }
                GateAction::Error(error) => return Err(error),
            }
        }
    }
    if !connection.cancelled.load(Ordering::Acquire) {
        let mut info = connection.info.lock();
        if info.state == RemoteConnectionState::Connected {
            info.state = RemoteConnectionState::Disconnected;
            info.error = Some("remote_ssh_disconnected".into());
        } else if info.state != RemoteConnectionState::Error {
            info.state = RemoteConnectionState::Error;
            info.error = Some(if info.auth_output.contains("remote_python_required") {
                "remote_python_required".into()
            } else {
                "remote_ssh_closed_before_ready".into()
            });
        }
    }
    connection.process.lock().take();
    Ok(())
}

fn upload_helper(connection: &Connection) -> Result<(), String> {
    let encoded = STANDARD.encode(HELPER_SOURCE.as_bytes());
    // ConPTY 模拟键盘 Enter 使用 CR；单发 LF 不会提交 Windows cooked 输入行。
    let line_ending: &[u8] = if cfg!(windows) { b"\r" } else { b"\n" };
    let mut process = connection.process.lock();
    let process = process.as_mut().ok_or("remote_not_connected")?;
    for chunk in encoded.as_bytes().chunks(768) {
        if connection.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        process
            .writer
            .write_all(chunk)
            .and_then(|_| process.writer.write_all(line_ending))
            .map_err(|_| "remote_upload_failed")?;
    }
    process
        .writer
        .write_all(b".")
        .and_then(|_| process.writer.write_all(line_ending))
        .and_then(|_| process.writer.flush())
        .map_err(|_| "remote_upload_failed".into())
}

fn monitor_connection(connection: Arc<Connection>) {
    let started = Instant::now();
    let mut deploying_at = None;
    loop {
        thread::sleep(Duration::from_millis(250));
        if connection.cancelled.load(Ordering::Acquire) {
            return;
        }
        let state = connection.info.lock().state;
        if matches!(
            state,
            RemoteConnectionState::Disconnected | RemoteConnectionState::Error
        ) {
            return;
        }
        let timed_out = match state {
            RemoteConnectionState::Connecting | RemoteConnectionState::Authenticating => {
                started.elapsed() > AUTH_TIMEOUT
            }
            RemoteConnectionState::Deploying => {
                deploying_at.get_or_insert_with(Instant::now).elapsed() > DEPLOY_TIMEOUT
            }
            _ => false,
        };
        if timed_out {
            connection.fail("remote_connect_timeout".into());
            connection.process.lock().take();
            return;
        }
        let exited = connection
            .process
            .lock()
            .as_mut()
            .is_none_or(|process| process.child.try_wait().ok().flatten().is_some());
        if exited {
            let mut info = connection.info.lock();
            if info.state == RemoteConnectionState::Connected {
                info.state = RemoteConnectionState::Disconnected;
                info.error = Some("remote_ssh_disconnected".into());
            } else if info.state != RemoteConnectionState::Error {
                info.state = RemoteConnectionState::Error;
                info.error = Some("remote_ssh_closed_before_ready".into());
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> RemoteHost {
        RemoteHost {
            id: "host-1".into(),
            name: "Linux".into(),
            target: "developer@dev-box".into(),
            port: None,
            identity_file: None,
            ssh_config_file: None,
        }
    }

    #[test]
    fn ssh_target_and_options_cannot_inject_shell_or_ssh_arguments() {
        for target in [
            "-oProxyCommand=calc",
            "dev;touch /tmp/x",
            "dev\ncommand",
            "dev host",
            "$(command)",
        ] {
            let mut candidate = host();
            candidate.target = target.into();
            assert!(candidate.validate().is_err());
        }
        let mut candidate = host();
        candidate.target = "user@[fe80::1%eth0]".into();
        candidate.identity_file = Some("C:\\Users\\A B\\id_ed25519".into());
        assert!(candidate.validate().is_ok());
        let args = ssh_args(&candidate, 12345, "print('hello')");
        assert!(args.contains(&"127.0.0.1:12345".to_string()));
        assert!(args.contains(&candidate.identity_file.clone().expect("identity")));
        assert_eq!(args[args.len() - 2], candidate.target);
        assert_eq!(args[args.len() - 3], "--");
        assert!(args.last().expect("command").contains("'\"'\"'"));
    }

    #[test]
    fn discovered_unicode_alias_is_passed_unchanged_without_copying_ssh_settings() {
        let mut candidate = host();
        candidate.target = "电信".into();
        candidate.ssh_config_file = Some("included-ssh-config".into());
        assert!(candidate.validate().is_ok());
        let args = ssh_args(&candidate, 12345, "pass");
        assert_eq!(args[args.len() - 2], "电信");
        assert!(!args
            .iter()
            .any(|arg| arg == "-p" || arg == "-i" || arg == "included-ssh-config"));
    }

    #[test]
    fn authentication_prompts_are_live_and_secret_descriptor_never_reaches_auth_output() {
        let mut gate = OutputGate::new("nonce");
        let prompt = gate.push(b"Password: ");
        assert!(matches!(&prompt[..], [GateAction::Auth(data)] if data == b"Password: "));
        let upload = b"__TF_REMOTE_nonce_UPLOAD____TF_REMOTE_END__";
        for byte in &upload[..upload.len() - 1] {
            assert!(gate.push(&[*byte]).is_empty());
        }
        assert!(matches!(
            &gate.push(&upload[upload.len() - 1..])[..],
            [GateAction::Upload]
        ));
        let secret = json!({"port":40123,"token":"secret-token-1234567890","version":1,"pid":123,"root":"/home/user/.local/share/termflow/remote","protocol":1});
        let ready = format!(
            "echoed upload contents\r\n__TF_REMOTE_nonce_READY__{}__TF_REMOTE_END__",
            STANDARD.encode(secret.to_string())
        );
        let mut actions = Vec::new();
        for chunk in ready.as_bytes().chunks(3) {
            actions.extend(gate.push(chunk));
        }
        assert_eq!(actions.len(), 1);
        let GateAction::Ready(server) = &actions[0] else {
            panic!("ready descriptor expected")
        };
        let public = serde_json::to_string(&server.public()).expect("public descriptor");
        assert!(!public.contains("token"));
        assert!(!public.contains("secret"));
    }

    #[test]
    fn descriptor_rejects_nonlocal_protocol_credentials_and_missing_fields() {
        let mut descriptor: ServerDescriptor = serde_json::from_value(json!({"port":40123,"token":"secret-token-1234567890","version":1,"pid":123,"root":"/home/user","protocol":1})).expect("fixture");
        assert!(descriptor.validate().is_ok());
        descriptor.token = "unsafe\r\nheader".into();
        assert!(descriptor.validate().is_err());
        descriptor.token = "secret-token-1234567890".into();
        descriptor.protocol = 99;
        assert!(descriptor.validate().is_err());
    }

    #[test]
    fn disconnect_preserves_server_metadata_without_requesting_remote_shutdown() {
        let manager = RemoteSshManager::new();
        let connection = Connection::new(host());
        connection.info.lock().state = RemoteConnectionState::Connected;
        connection.info.lock().server = Some(RemoteServerInfo {
            port: 41234,
            version: 1,
            pid: 345,
            root: "/home/user".into(),
            protocol: 1,
        });
        manager
            .connections
            .lock()
            .insert("host-1".into(), connection);
        let info = manager.disconnect("host-1").expect("disconnect");
        assert_eq!(info.state, RemoteConnectionState::Disconnected);
        assert_eq!(info.server.expect("last server metadata").pid, 345);
        assert_eq!(
            manager
                .request("host-1", "sessions.list", json!({}))
                .unwrap_err(),
            "remote_not_connected"
        );
        assert!(manager.auth_input("host-1", "password\r").is_err());
    }

    #[test]
    fn version_errors_before_upload_are_decoded_without_exposing_control_frames() {
        let mut gate = OutputGate::new("nonce");
        let error = format!(
            "__TF_REMOTE_nonce_ERROR__{}__TF_REMOTE_END__",
            STANDARD.encode("remote_python_version")
        );
        let mut actions = Vec::new();
        for chunk in error.as_bytes().chunks(2) {
            actions.extend(gate.push(chunk));
        }
        assert!(
            matches!(&actions[..], [GateAction::Error(error)] if error == "remote_python_version")
        );
    }

    #[test]
    fn long_control_frames_survive_conpty_wrapping_and_vt_redraws() {
        let mut gate = OutputGate::new("nonce");
        let upload = gate.push(b"__TF_REMOTE_nonce_UPLOAD____TF_REMOTE_END__");
        assert!(matches!(&upload[..], [GateAction::Upload]));
        let descriptor = json!({"port":40123,"token":"secret-token-1234567890","version":1,"pid":123,"root":format!("/home/user/{}", "x".repeat(500)),"protocol":1});
        let frame = format!(
            "__TF_REMOTE_nonce_READY__{}__TF_REMOTE_END__",
            STANDARD.encode(descriptor.to_string())
        );
        let wrapped = frame
            .as_bytes()
            .chunks(35)
            .map(|chunk| {
                let mut wrapped = chunk.to_vec();
                wrapped.extend_from_slice(b"\r\n\x1b[12;1H");
                wrapped
            })
            .flatten()
            .collect::<Vec<_>>();
        let mut actions = Vec::new();
        for chunk in wrapped.chunks(7) {
            actions.extend(gate.push(chunk));
        }
        assert!(matches!(&actions[..], [GateAction::Ready(server)] if server.pid == 123));
    }

    #[test]
    fn never_connected_hosts_disconnect_idempotently_and_unicode_prompts_are_preserved() {
        let manager = RemoteSshManager::new();
        assert_eq!(
            manager
                .disconnect("saved-but-never-connected")
                .expect("idempotent disconnect")
                .state,
            RemoteConnectionState::Disconnected
        );
        let connection = Connection::new(host());
        for byte in "请输入密码：".as_bytes() {
            connection.append_auth(&[*byte]);
        }
        assert_eq!(connection.info.lock().auth_output, "请输入密码：");
    }

    #[test]
    fn rpc_uses_the_authenticated_ssh_socks_tunnel_for_remote_loopback() {
        use std::net::TcpStream;
        let listener = TcpListener::bind("127.0.0.1:0").expect("SOCKS test listener");
        let port = listener.local_addr().expect("listener address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("SOCKS client");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting).expect("SOCKS greeting");
            assert_eq!(greeting, [5, 1, 0]);
            stream.write_all(&[5, 0]).expect("SOCKS no auth");
            let mut request = [0; 4];
            stream.read_exact(&mut request).expect("SOCKS request");
            assert_eq!(&request[..3], &[5, 1, 0]);
            let address = match request[3] {
                1 => {
                    let mut address = [0; 4];
                    stream.read_exact(&mut address).expect("IPv4 address");
                    format!(
                        "{}.{}.{}.{}",
                        address[0], address[1], address[2], address[3]
                    )
                }
                3 => {
                    let mut len = [0];
                    stream.read_exact(&mut len).expect("domain length");
                    let mut address = vec![0; len[0] as usize];
                    stream.read_exact(&mut address).expect("domain address");
                    String::from_utf8(address).expect("domain UTF8")
                }
                other => panic!("unexpected SOCKS address type {other}"),
            };
            assert_eq!(address, "127.0.0.1");
            let mut remote_port = [0; 2];
            stream.read_exact(&mut remote_port).expect("remote port");
            assert_eq!(u16::from_be_bytes(remote_port), 40123);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 1])
                .expect("SOCKS connected");
            fn receive_http(stream: &mut TcpStream) -> (String, Value) {
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).expect("HTTP headers");
                    bytes.push(byte[0]);
                    assert!(bytes.len() < 8192);
                }
                let headers = String::from_utf8(bytes).expect("HTTP header UTF8");
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().expect("content length"))
                    })
                    .expect("body length");
                let mut body = vec![0; length];
                stream.read_exact(&mut body).expect("HTTP body");
                (headers, serde_json::from_slice(&body).expect("RPC JSON"))
            }
            let (headers, body) = receive_http(&mut stream);
            assert!(headers.starts_with("POST /rpc HTTP/1.1\r\n"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("x-termflow-token: secret-token-1234567890\r\n"));
            assert_eq!(body, json!({"method":"sessions.list","params":{}}));
            let body = r#"{"result":{"sessions":[]}}"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            stream.write_all(response.as_bytes()).expect("RPC response");
        });
        let manager = RemoteSshManager::new();
        let connection = Connection::new(host());
        connection.info.lock().state = RemoteConnectionState::Connected;
        *connection.server.lock() = Some(ServerDescriptor {
            port: 40123,
            token: "secret-token-1234567890".into(),
            version: 1,
            pid: 123,
            root: "/home/user".into(),
            protocol: 1,
        });
        *connection.client.lock() = Some(client_for_proxy(port).expect("SOCKS HTTP client"));
        manager
            .connections
            .lock()
            .insert("host-1".into(), connection);
        assert_eq!(
            manager
                .request("host-1", "sessions.list", json!({}))
                .expect("RPC result"),
            json!({"sessions":[]})
        );
        server.join().expect("SOCKS server assertions");
    }

    #[test]
    #[ignore = "requires the isolated Windows/WSL Paramiko SSH fixture and opt-in environment"]
    fn system_ssh_password_deployment_reconnects_the_same_remote_pty() {
        fn authenticate(
            manager: &Arc<RemoteSshManager>,
            host: &RemoteHost,
        ) -> RemoteConnectionInfo {
            manager.connect(host.clone()).expect("start system SSH");
            let deadline = Instant::now() + Duration::from_secs(120);
            let mut accepted_host = false;
            let mut sent_password = false;
            loop {
                let info = manager.connection(&host.id).expect("connection snapshot");
                if info.state == RemoteConnectionState::Connected {
                    return info;
                }
                assert!(
                    info.state != RemoteConnectionState::Error,
                    "SSH failed: {info:?}"
                );
                let output = info.auth_output.to_ascii_lowercase();
                if !accepted_host && output.contains("continue connecting") {
                    manager
                        .auth_input(&host.id, "yes\r")
                        .expect("confirm isolated host key");
                    accepted_host = true;
                }
                if !sent_password && output.contains("password:") {
                    manager
                        .auth_input(&host.id, "termflow-test-password\r")
                        .expect("test password");
                    sent_password = true;
                }
                assert!(Instant::now() < deadline, "SSH timed out: {info:?}");
                thread::sleep(Duration::from_millis(40));
            }
        }
        let port = std::env::var("TERMFLOW_SSH_TEST_PORT")
            .expect("test SSH port")
            .parse::<u16>()
            .expect("port");
        assert!(
            std::env::var_os("TERMFLOW_SSH_TEST_CONFIG").is_some(),
            "isolated SSH config required"
        );
        let host = RemoteHost {
            id: "ssh-integration".into(),
            name: "Isolated SSH fixture".into(),
            target: "tester@127.0.0.1".into(),
            port: Some(port),
            identity_file: None,
            ssh_config_file: None,
        };
        let manager = RemoteSshManager::new();
        let first = authenticate(&manager, &host);
        assert!(
            !first.auth_output.contains("termflow-test-password"),
            "password must not be echoed"
        );
        assert_eq!(
            manager
                .request(&host.id, "hello", json!({}))
                .expect("SOCKS hello")["protocol"],
            1
        );
        let request_id = format!("ssh-test-{}", rand::random::<u64>());
        let launch =
            json!({"requestId":request_id,"agentId":"shell","cwd":"~","rows":24,"cols":80});
        let session = manager
            .request(&host.id, "sessions.create", launch.clone())
            .expect("remote PTY");
        let instance = session["instanceId"]
            .as_str()
            .expect("instance ID")
            .to_string();
        let pid = session["pid"].as_u64().expect("remote PID");
        let input = json!({"sessionId":request_id,"instanceId":instance,"data":"i=0; while [ \"$i\" -lt 1000 ]; do printf 'TF_TICK_%s\\n' \"$i\"; i=$((i+1)); sleep 0.1; done\r"});
        manager
            .request(&host.id, "sessions.write", input)
            .expect("interactive input");
        manager
            .request(
                &host.id,
                "sessions.resize",
                json!({"sessionId":request_id,"instanceId":instance,"rows":40,"cols":100}),
            )
            .expect("remote resize");
        thread::sleep(Duration::from_millis(500));
        let before = manager
            .request(
                &host.id,
                "sessions.read",
                json!({"sessionId":request_id,"instanceId":instance,"cursor":0}),
            )
            .expect("first terminal output");
        drop(manager); // 等价于本机应用退出：只关闭本机 SSH。
        thread::sleep(Duration::from_secs(1));
        let manager = RemoteSshManager::new();
        let second = authenticate(&manager, &host);
        assert_eq!(
            first.server.expect("first server").pid,
            second.server.expect("same daemon").pid
        );
        let again = manager
            .request(&host.id, "sessions.create", launch)
            .expect("idempotent reconnect launch");
        assert_eq!(again["pid"].as_u64(), Some(pid));
        assert_eq!(again["instanceId"], instance);
        let output = manager
            .request(
                &host.id,
                "sessions.read",
                json!({"sessionId":request_id,"instanceId":instance,"cursor":0}),
            )
            .expect("replayed terminal output");
        assert!(
            output["nextOffset"].as_u64().expect("new offset")
                > before["nextOffset"].as_u64().expect("old offset")
        );
        let bytes = STANDARD
            .decode(output["data"].as_str().expect("base64 output"))
            .expect("raw terminal bytes");
        assert!(String::from_utf8_lossy(&bytes).contains("TF_TICK_"));
        manager
            .request(
                &host.id,
                "sessions.stop",
                json!({"sessionId":request_id,"instanceId":instance}),
            )
            .expect("explicit stop");
        manager
            .request(&host.id, "server.stop", json!({}))
            .expect("stop isolated helper");
        manager.disconnect(&host.id).expect("disconnect fixture");
    }
}
