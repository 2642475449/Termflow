#!/usr/bin/env python3
"""Termflow Linux 会话服务。仅使用 Python 3.8+ 标准库，由 SSH 部署。

SSH 传输与 PTY 生命周期相互独立。服务仅监听回环，认证令牌不会传给智能体。
协议为 POST /rpc {method, params}，输出用原始字节偏移和 base64 重放。
"""

import argparse
import base64
import contextlib
import fcntl
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.request
import uuid

VERSION = 1
PROTOCOL = 1
MAX_BODY = 1024 * 1024
MAX_OUTPUT = 8 * 1024 * 1024
MAX_READ = 256 * 1024
MAX_SESSIONS = 64
HOOK_MARKER = "TERMFLOW_REMOTE_HOOK=1"
HOOK_EVENTS = ("UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop")


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
    try:
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(path))
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def read_json(path):
    with open(str(path), encoding="utf-8") as stream:
        return json.load(stream)


def rpc_descriptor(descriptor, method, params=None, timeout=5):
    request = urllib.request.Request(
        "http://127.0.0.1:%d/rpc" % descriptor["port"],
        data=json.dumps({"method": method, "params": params or {}}).encode(),
        headers={"Content-Type": "application/json", "X-Termflow-Token": descriptor["token"]},
    )
    # 本机回调不继承远端 HTTP_PROXY，亦不向网络代理泄露令牌。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        envelope = json.load(response)
    if "error" in envelope:
        raise ValueError(envelope["error"])
    return envelope["result"]


def bounded_integer(value, minimum, maximum, label):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError("invalid " + label)
    return value


def now_ms():
    return int(time.time() * 1000)


class RemoteSession:
    def __init__(self, service, request):
        self.service = service
        self.id = request["requestId"]
        self.instance_id = str(uuid.uuid4())
        self.agent_id = request["agentId"]
        self.cwd = str(Path(request.get("cwd") or "~").expanduser().resolve(strict=True))
        if not Path(self.cwd).is_dir():
            raise ValueError("working directory is not a directory")
        self.title = str(request.get("title") or self.agent_id)[:120]
        self.rows = bounded_integer(request.get("rows", 30), 2, 500, "rows")
        self.cols = bounded_integer(request.get("cols", 100), 2, 1000, "cols")
        self.created_at = now_ms()
        self.lock = threading.RLock()
        self.buffer = bytearray()
        self.offset = 0
        self.revision = 1
        self.task_state = "waiting" if self.agent_id == "shell" else "unknown"
        self.hook_observed = False
        self.exit_code = None
        self.explicit_stop = False
        self.hook_token = secrets.token_urlsafe(32)
        environment = service.environment.copy()
        environment.update({
            "TERM": "xterm-256color", "COLORTERM": "truecolor",
            "TERMFLOW_REMOTE_SESSION": self.id,
            "TERMFLOW_REMOTE_INSTANCE": self.instance_id,
            "TERMFLOW_REMOTE_HOOK_TOKEN": self.hook_token,
            "TERMFLOW_REMOTE_ROOT": str(service.root),
        })
        if self.agent_id == "shell":
            arguments = [shutil.which("bash", path=environment.get("PATH")) or "/bin/sh", "-il"]
        else:
            executable = service.executable(self.agent_id)
            if not executable:
                raise ValueError(self.agent_id + " is not installed; open a preparation terminal")
            environment = service.cli_environment(executable, environment)
            arguments = [executable]
            if self.agent_id == "claude":
                hooks = service.hook_configuration()
                arguments += ["--settings", json.dumps(hooks, separators=(",", ":"))]
            else:
                service.configure_codex_hooks()
                if service.codex_supports_no_daemon(executable):
                    arguments.append("--no-daemon")
        master, slave = pty.openpty()
        self.master = master
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
        try:
            # 在独立的 Python 子进程内设置 controlling tty；HTTP 线程不执行 preexec_fn。
            self.process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "exec", "--cwd", self.cwd, "--"] + arguments,
                stdin=slave, stdout=slave, stderr=slave, env=environment,
                start_new_session=True, close_fds=True,
            )
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        threading.Thread(target=self._read_output, daemon=True).start()

    def snapshot(self):
        with self.lock:
            return {
                "id": self.id, "instanceId": self.instance_id, "agentId": self.agent_id,
                "cwd": self.cwd, "title": self.title, "pid": self.process.pid,
                "processState": "running" if self.process.poll() is None else "exited",
                "taskState": self.task_state, "revision": self.revision,
                "createdAt": self.created_at, "exitCode": self.exit_code,
                "hookObserved": self.hook_observed, "outputStart": self.offset,
                "outputEnd": self.offset + len(self.buffer), "rows": self.rows, "cols": self.cols,
            }

    def _read_output(self):
        try:
            while True:
                readable, _, _ = select.select([self.master], [], [], 0.2)
                if not readable:
                    if self.process.poll() is not None:
                        break
                    continue
                try:
                    chunk = os.read(self.master, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                with self.lock:
                    self.buffer.extend(chunk)
                    overflow = len(self.buffer) - MAX_OUTPUT
                    if overflow > 0:
                        del self.buffer[:overflow]
                        self.offset += overflow
        finally:
            self.process.wait()
            with self.lock:
                self.exit_code = self.process.returncode
                self.task_state = "stopped" if self.explicit_stop or self.exit_code == 0 else "error"
                self.revision += 1
                with contextlib.suppress(OSError):
                    os.close(self.master)

    def require_instance(self, request):
        if request.get("instanceId") != self.instance_id:
            raise ValueError("session instance changed; refresh before sending input")

    def write(self, request):
        self.require_instance(request)
        data = request.get("data")
        if not isinstance(data, str) or len(data.encode("utf-8")) > MAX_READ:
            raise ValueError("invalid terminal input")
        content = memoryview(data.encode("utf-8"))
        deadline = time.monotonic() + 3
        with self.lock:
            if self.process.poll() is not None:
                raise ValueError("session has exited")
            while content:
                if time.monotonic() > deadline:
                    raise ValueError("terminal input timed out; input may be partially delivered")
                _, writable, _ = select.select([], [self.master], [], 0.1)
                if writable:
                    try:
                        written = os.write(self.master, content)
                        content = content[written:]
                    except BlockingIOError:
                        continue
        return self.snapshot()

    def resize(self, request):
        self.require_instance(request)
        rows = bounded_integer(request.get("rows"), 2, 500, "rows")
        cols = bounded_integer(request.get("cols"), 2, 1000, "cols")
        with self.lock:
            if self.process.poll() is not None:
                return self.snapshot()
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            self.rows, self.cols = rows, cols
        return self.snapshot()

    def read(self, request):
        if request.get("instanceId") is not None:
            self.require_instance(request)
        cursor = bounded_integer(request.get("cursor", 0), 0, 2 ** 53 - 1, "cursor")
        limit = bounded_integer(request.get("maxBytes", 65536), 1, MAX_READ, "maxBytes")
        with self.lock:
            end = self.offset + len(self.buffer)
            if cursor > end:
                raise ValueError("output cursor exceeds session output")
            start = max(cursor, self.offset)
            chunk = bytes(self.buffer[start - self.offset:start - self.offset + limit])
            return {
                "sessionId": self.id, "instanceId": self.instance_id,
                "offset": start, "nextOffset": start + len(chunk),
                "data": base64.b64encode(chunk).decode("ascii"),
                "truncated": cursor < self.offset, "session": self.snapshot(),
            }

    def stop(self, request):
        self.require_instance(request)
        with self.lock:
            self.explicit_stop = True
        # shell 前台/后台作业可以各有进程组。只选择仍属于本 PTY session 的进程，
        # 防止只杀 shell 后把忽略 TERM/HUP 的实际任务遗留在服务器上。
        def live_groups():
            groups = set()
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    pid = int(entry.name)
                    if os.getsid(pid) != self.process.pid:
                        continue
                    # 僵尸已经结束，只等待其原父进程回收，不视为仍执行的工作。
                    state = (entry / "stat").read_text().rsplit(")", 1)[1].split()[0]
                    if state != "Z":
                        groups.add(os.getpgid(pid))
                except (OSError, ValueError, IndexError):
                    continue
            return groups

        for group in live_groups():
            with contextlib.suppress(ProcessLookupError):
                os.killpg(group, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and live_groups():
            time.sleep(0.05)
        for group in live_groups():
            with contextlib.suppress(ProcessLookupError):
                os.killpg(group, signal.SIGKILL)
        self.process.wait(timeout=2)
        with self.lock:
            self.exit_code = self.process.returncode
            self.task_state = "stopped"
            self.revision += 1
        return self.snapshot()


class RemoteService:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(str(self.root), 0o700)
        self.id = hashlib.sha256(str(self.root).encode()).hexdigest()[:24]
        self.token = secrets.token_urlsafe(48)
        self.lock = threading.RLock()
        self.sessions = {}
        self.shutdown_pending = False
        self.uninstall = False
        self.environment = os.environ.copy()
        home = Path.home()
        self.environment["PATH"] = os.pathsep.join([
            str(home / ".local/bin"), str(home / ".cargo/bin"),
            str(home / ".npm-global/bin"), self.environment.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        ])
        self.http = None
        self.hook_error = None
        self.codex_capability_cache = {}

    def descriptor(self):
        return {"port": self.http.server_port, "token": self.token, "version": VERSION,
                "pid": os.getpid(), "root": str(self.root), "protocol": PROTOCOL}

    def hello(self):
        return {"id": self.id, "version": VERSION, "protocol": PROTOCOL,
                "root": str(self.root), "pid": os.getpid(), "pythonVersion": sys.version.split()[0]}

    def executable(self, agent):
        path = shutil.which(agent, path=self.environment["PATH"])
        if path:
            return path
        # nvm/自定义 shell PATH 只在缺少可执行文件时读取，不在每次状态轮询时启动 shell。
        shell = shutil.which("bash", path=self.environment["PATH"])
        if shell and agent in ("codex", "claude"):
            try:
                result = subprocess.run([shell, "-ilc", "command -v " + agent],
                                        env=self.environment, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, timeout=5)
                for line in reversed(result.stdout.decode("utf-8", "replace").splitlines()):
                    if line.startswith("/") and os.path.isfile(line) and os.access(line, os.X_OK):
                        return line
            except (OSError, subprocess.TimeoutExpired):
                pass
        return None

    def hook_command(self):
        return HOOK_MARKER + " " + shlex.quote(sys.executable) + " " + shlex.quote(str(Path(__file__).resolve())) + " hook"

    def cli_environment(self, executable, base=None):
        environment = dict(self.environment if base is None else base)
        # nvm 等 shell 环境找到的 CLI 可能使用 /usr/bin/env node。
        # 保留 bin 符号链接所在目录，不能 resolve 到 node_modules 内部后丢失同目录运行时。
        directory = str(Path(executable).absolute().parent)
        environment["PATH"] = directory + os.pathsep + environment.get("PATH", "")
        return environment

    def codex_supports_no_daemon(self, executable):
        try:
            metadata = os.stat(executable)
            key = (executable, metadata.st_mtime_ns, metadata.st_size)
        except OSError:
            return False
        with self.lock:
            if key in self.codex_capability_cache:
                return self.codex_capability_cache[key]
        # 共享 daemon 会继承先启动终端的 Hook 环境；每个受管理 PTY 单独运行。
        # 旧版拒绝此参数，因此仅做无任务的帮助探测；失败时保留原有启动方式。
        supported = False
        try:
            result = subprocess.run(
                [executable, "--help"], env=self.cli_environment(executable),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
            )
            supported = result.returncode == 0 and b"--no-daemon" in result.stdout
        except (OSError, subprocess.SubprocessError):
            pass
        with self.lock:
            if len(self.codex_capability_cache) >= 128:
                self.codex_capability_cache.clear()
            self.codex_capability_cache[key] = supported
        return supported

    def hook_configuration(self):
        return {"hooks": {event: [{"matcher": "", "hooks": [
            {"type": "command", "command": self.hook_command(), "timeout": 5}
        ]}] for event in HOOK_EVENTS}}

    def configure_codex_hooks(self, remove=False):
        root = Path(self.environment.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
        path = root / "hooks.json"
        if path.is_symlink():
            raise ValueError("Codex hooks.json is a symbolic link; configure the Termflow hook in its managed source")
        lock_path = self.root / "hooks.lock"
        with open(str(lock_path), "a+") as lock:
            os.chmod(str(lock_path), 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            config = read_json(path) if path.exists() else {}
            if not isinstance(config, dict) or not isinstance(config.get("hooks", {}), dict):
                raise ValueError("Codex hooks.json must contain an object; existing configuration was preserved")
            hooks = config.setdefault("hooks", {})
            # 仅替换 Termflow 拥有的 action；不删除混合定义中的用户 action。
            for event, definitions in list(hooks.items()):
                if not isinstance(definitions, list):
                    raise ValueError("Codex hook event must be an array; configuration was preserved")
                kept = []
                for definition in definitions:
                    if not isinstance(definition, dict) or not isinstance(definition.get("hooks"), list):
                        kept.append(definition)
                        continue
                    definition = dict(definition)
                    definition["hooks"] = [action for action in definition["hooks"] if not (
                        isinstance(action, dict) and HOOK_MARKER in str(action.get("command", "")))]
                    if definition["hooks"]:
                        kept.append(definition)
                hooks[event] = kept
            if not remove:
                for event, definitions in self.hook_configuration()["hooks"].items():
                    hooks.setdefault(event, []).extend(definitions)
            if not path.exists() and remove:
                return
            encoded = json.dumps(config, ensure_ascii=False, sort_keys=True)
            old = json.dumps(read_json(path), ensure_ascii=False, sort_keys=True) if path.exists() else None
            if old != encoded:
                atomic_json(path, config)

    def inspect(self):
        agents = []
        for agent in ("codex", "claude"):
            executable = self.executable(agent)
            info = {"id": agent, "installed": bool(executable), "executable": executable,
                    "version": None, "authStatus": "unknown", "hookStatus": "pending"}
            if executable:
                try:
                    environment = self.cli_environment(executable)
                    version = subprocess.run([executable, "--version"], env=environment,
                                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=6)
                    if version.returncode == 0:
                        info["version"] = version.stdout.decode("utf-8", "replace").strip()[:160]
                    arguments = ["login", "status"] if agent == "codex" else ["auth", "status"]
                    auth = subprocess.run([executable] + arguments, env=environment,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=6)
                    if agent == "codex":
                        if auth.returncode == 0:
                            info["authStatus"] = "authenticated"
                        elif auth.returncode == 1:
                            info["authStatus"] = "unauthenticated"
                    else:
                        try:
                            status = json.loads(auth.stdout)
                            if status.get("loggedIn") is True:
                                info["authStatus"] = "authenticated"
                            elif status.get("loggedIn") is False:
                                info["authStatus"] = "unauthenticated"
                        except (ValueError, AttributeError):
                            pass
                except (OSError, subprocess.TimeoutExpired):
                    pass
            with self.lock:
                if any(session.agent_id == agent and session.hook_observed for session in self.sessions.values()):
                    info["hookStatus"] = "configured"
            agents.append(info)
        return {"agents": agents, "pythonVersion": sys.version.split()[0], "helperVersion": VERSION}

    def dispatch(self, method, params):
        if not isinstance(method, str):
            raise ValueError("method must be a string")
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        if method == "hello":
            return self.hello()
        if method == "inspect":
            return self.inspect()
        if method == "sessions.list":
            with self.lock:
                return [session.snapshot() for session in self.sessions.values()]
        if method == "sessions.create":
            request_id = params.get("requestId")
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128 or any(ord(c) < 32 for c in request_id):
                raise ValueError("invalid requestId")
            if params.get("agentId") not in ("codex", "claude", "shell"):
                raise ValueError("unsupported agent")
            with self.lock:
                if self.shutdown_pending:
                    raise ValueError("server is stopping")
                existing = self.sessions.get(request_id)
                if existing:
                    expected_cwd = str(Path(params.get("cwd") or "~").expanduser().resolve())
                    if existing.agent_id != params["agentId"] or existing.cwd != expected_cwd:
                        raise ValueError("requestId already belongs to another launch")
                    return existing.snapshot()
                if len(self.sessions) >= MAX_SESSIONS:
                    raise ValueError("session limit reached; remove exited sessions first")
                session = RemoteSession(self, params)
                self.sessions[request_id] = session
                return session.snapshot()
        if method.startswith("sessions."):
            with self.lock:
                session = self.sessions.get(params.get("sessionId"))
            if session is None:
                raise ValueError("session not found; refresh the server session list")
            action = method.split(".", 1)[1]
            if action in ("read", "write", "resize", "stop"):
                return getattr(session, action)(params)
            if action == "forget":
                session.require_instance(params)
                with self.lock:
                    if session.process.poll() is None:
                        raise ValueError("stop the session before removing it")
                    del self.sessions[session.id]
                return True
        if method in ("server.stop", "server.uninstall"):
            with self.lock:
                if any(session.process.poll() is None for session in self.sessions.values()):
                    raise ValueError("server has running sessions; stop them explicitly first")
                uninstall = method == "server.uninstall"
                # 配置清理可能拒绝损坏 JSON/用户符号链接；失败时服务仍须可正常接收会话。
                if uninstall:
                    self.configure_codex_hooks(remove=True)
                self.shutdown_pending = True
                self.uninstall = uninstall
                threading.Thread(target=self._shutdown_later, daemon=True).start()
            return True
        raise ValueError("unsupported remote method")

    def _shutdown_later(self):
        time.sleep(0.2)  # 先返回管理请求的结果，再关闭监听。
        self.http.shutdown()

    def hook(self, payload):
        with self.lock:
            session = self.sessions.get(payload.get("sessionId"))
            if session is None or payload.get("instanceId") != session.instance_id:
                raise ValueError("unknown hook session")
            if not hmac.compare_digest(str(payload.get("hookToken", "")), session.hook_token):
                raise ValueError("invalid hook token")
        event = payload.get("event")
        states = {"UserPromptSubmit": "running", "PreToolUse": "running", "PostToolUse": "running",
                  "PermissionRequest": "waiting", "Stop": "completed"}
        if event not in states:
            raise ValueError("unsupported hook event")
        with session.lock:
            if session.process.poll() is None:
                session.hook_observed = True
                session.task_state = states[event]
                session.revision += 1
        return True


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass  # 不将请求、认证、目录或提示词写入日志。

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def answer(self, status, payload):
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        service = self.server.service
        if self.path not in ("/rpc", "/hook"):
            self.answer(404, {"error": "not found"})
            return
        if self.path == "/rpc" and not hmac.compare_digest(self.headers.get("X-Termflow-Token", ""), service.token):
            self.answer(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                self.answer(413, {"error": "request body too large or empty"})
                return
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("request must be an object")
            if self.path == "/hook":
                result = service.hook(payload)
            else:
                result = service.dispatch(payload.get("method"), payload.get("params", {}))
            self.answer(200, {"result": result})
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
            self.answer(400, {"error": str(error)[:500]})


def serve(root):
    service = RemoteService(root)
    # 同一用户同时从多个客户端连接只启动一个服务。
    lock = open(str(service.root / "server.lock"), "a+")
    os.chmod(str(service.root / "server.lock"), 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.service = service
    service.http = server
    atomic_json(service.root / "server.json", service.descriptor())
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        descriptor = service.root / "server.json"
        with contextlib.suppress(OSError, ValueError, KeyError):
            if read_json(descriptor).get("pid") == os.getpid():
                descriptor.unlink()
        if service.uninstall:
            # 仅删除本服务拥有的文件；不递归删除目录和未知用户数据。
            for name in ("helper.py", "server.lock", "hooks.lock", "server.log"):
                with contextlib.suppress(FileNotFoundError):
                    (service.root / name).unlink()
            for path in service.root.iterdir():
                if re.fullmatch(r"helper-[a-f0-9]{64}\.py", path.name) and path.is_file():
                    path.unlink()
            with contextlib.suppress(OSError):
                service.root.rmdir()


def start(root):
    root = Path(root).expanduser().resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(str(root), 0o700)
    descriptor_path = root / "server.json"
    try:
        descriptor = read_json(descriptor_path)
        hello = rpc_descriptor(descriptor, "hello")
        if hello.get("protocol") != PROTOCOL or hello.get("version") != VERSION:
            raise RuntimeError("incompatible remote helper; stop its sessions before upgrading")
        print(json.dumps(descriptor), flush=True)
        return
    except (OSError, ValueError, KeyError):
        pass
    log_path = root / "server.log"
    log_fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(log_fd, "ab", buffering=0) as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "daemon", "--root", str(root)],
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True, close_fds=True)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            descriptor = read_json(descriptor_path)
            hello = rpc_descriptor(descriptor, "hello", timeout=1)
            if hello.get("protocol") != PROTOCOL:
                raise RuntimeError("incompatible remote helper protocol")
            print(json.dumps(descriptor), flush=True)
            return
        except (OSError, ValueError, KeyError):
            time.sleep(0.1)
    raise RuntimeError("remote helper did not start; check its Python version and server.log")


def report_hook():
    # 全局 Codex hook 在非 Termflow 会话中为空操作，且不更改 CLI 的信任记录。
    if not os.environ.get("TERMFLOW_REMOTE_SESSION"):
        print("{}")
        return
    try:
        payload = json.loads(sys.stdin.buffer.read(65536) or b"{}")
        if payload.get("agent_id") or payload.get("agent_type"):
            return  # 子智能体事件不能覆盖父会话的任务状态。
        descriptor = read_json(Path(os.environ["TERMFLOW_REMOTE_ROOT"]) / "server.json")
        request = urllib.request.Request(
            "http://127.0.0.1:%d/hook" % descriptor["port"],
            data=json.dumps({
                "sessionId": os.environ["TERMFLOW_REMOTE_SESSION"],
                "instanceId": os.environ["TERMFLOW_REMOTE_INSTANCE"],
                "hookToken": os.environ["TERMFLOW_REMOTE_HOOK_TOKEN"],
                "event": payload.get("hook_event_name"),
            }).encode(), headers={"Content-Type": "application/json"},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=2):
            pass
    except (OSError, ValueError, KeyError):
        pass  # 状态回调失败不阻止智能体执行。
    finally:
        print("{}")


def main():
    if sys.platform != "linux" or sys.version_info < (3, 8):
        raise RuntimeError("Termflow remote helper requires Linux and Python 3.8+")
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("start", "daemon", "exec", "hook"))
    parser.add_argument("--root", default=str(Path.home() / ".local/share/termflow/remote"))
    parser.add_argument("--cwd")
    # REMAINDER 放在 mode 后会吞掉 start/daemon 的 --root 和 exec 的 --cwd。
    # 仅 exec 允许在显式 -- 后携带子进程参数，其他模式拒绝未知参数。
    args, remaining = parser.parse_known_args()
    if args.mode == "exec":
        if not args.cwd:
            parser.error("exec requires --cwd")
        arguments = remaining[1:] if remaining[:1] == ["--"] else remaining
        if not arguments:
            parser.error("exec requires a command after --")
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.chdir(args.cwd)
        os.execvpe(arguments[0], arguments, os.environ)
    elif remaining:
        parser.error("unrecognized arguments: " + " ".join(remaining))
    elif args.mode == "hook":
        report_hook()
    elif args.mode == "daemon":
        serve(args.root)
    else:
        start(args.root)


if __name__ == "__main__":
    main()
