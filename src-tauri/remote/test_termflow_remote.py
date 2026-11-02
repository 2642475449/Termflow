"""Linux 黑箱验收：真实 HTTP、PTY 和模拟 CLI，不调用 AI 服务。"""

from __future__ import annotations

import base64
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


HELPER = Path(__file__).with_name("termflow_remote.py")

FAKE_AGENT = r'''import os, sys
agent = os.path.basename(sys.argv[0])
if "--help" in sys.argv:
    print("fixture-options --no-daemon")
    raise SystemExit(0)
if "--version" in sys.argv:
    print(agent + " test-1.0")
    raise SystemExit(0)
import json
if sys.argv[1:] == ["login", "status"]:
    print("Not logged in")
    raise SystemExit(1)
if sys.argv[1:] in (["auth", "status"], ["auth", "status", "--json"]):
    print(json.dumps({"loggedIn": False}))
    raise SystemExit(1)
import fcntl, select, signal, struct, termios, time, tty
tty.setraw(0)
def emit(data):
    os.write(1, data)
def resized(*unused):
    rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
    emit(("\r\nSIZE:%s:%s\r\n" % (rows, cols)).encode())
signal.signal(signal.SIGWINCH, resized)
emit(("\x1b[32mREADY:%s:%s:你好🌊\x1b[0m\r\n" % (agent, os.getpid())).encode())
emit(("ARGS:" + json.dumps(sys.argv[1:]) + "\r\n").encode())
resized()
tick = 0
while True:
    ready, _, _ = select.select([0], [], [], 0.06)
    if ready:
        data = os.read(0, 4096)
        if not data:
            break
        emit(b"\r\nINPUT:" + data + b"\r\n")
        if data.startswith(b"hook:") or data.startswith(b"bad-hook:"):
            import urllib.request, urllib.error
            bad = data.startswith(b"bad-hook:")
            event = data.split(b":", 1)[1].decode().strip()
            with open(os.path.join(os.environ["TERMFLOW_REMOTE_ROOT"], "server.json")) as stream:
                descriptor = json.load(stream)
            payload = {"sessionId": os.environ["TERMFLOW_REMOTE_SESSION"], "instanceId": os.environ["TERMFLOW_REMOTE_INSTANCE"],
                       "hookToken": "wrong" if bad else os.environ["TERMFLOW_REMOTE_HOOK_TOKEN"], "event": event}
            request = urllib.request.Request("http://127.0.0.1:%s/hook" % descriptor["port"],
                                             data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with opener.open(request, timeout=2) as response:
                    emit(("HOOK_RESULT:%s\r\n" % response.status).encode())
            except urllib.error.HTTPError as error:
                emit(("HOOK_RESULT:%s\r\n" % error.code).encode())
        if b"exit-test" in data:
            raise SystemExit(7)
        if b"flood-test" in data:
            for _ in range(600):
                emit(b"A" * 16384)
            emit(b"\r\nFLOOD-END\r\n")
        if b"foreground-test" in data or b"foreground-ignore-test" in data:
            child = os.fork()
            if child == 0:
                os.setpgid(0, 0)
                signal.signal(signal.SIGTTOU, signal.SIG_IGN)
                if b"foreground-ignore-test" in data:
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                    signal.signal(signal.SIGHUP, signal.SIG_IGN)
                os.tcsetpgrp(0, os.getpgrp())
                emit(("\r\nFG_PID:%s\r\n" % os.getpid()).encode())
                while True:
                    time.sleep(1)
            else:
                os.waitpid(child, 0)
    tick += 1
    emit(("TICK:%s:%s\r\n" % (agent, tick)).encode())
'''


class RpcFailure(Exception):
    pass


@unittest.skipUnless(sys.platform.startswith("linux"), "需要 Linux PTY")
class RemoteHelperBlackBoxTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="termflow-remote-qa-")
        self.directory = Path(self.sandbox.name)
        self.home = self.directory / "home"
        self.home.mkdir()
        self.root = self.directory / "managed"
        self.cwd = self.directory / "project 空格"
        self.cwd.mkdir()
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        for agent in ("codex", "claude"):
            executable = self.bin / agent
            executable.write_text("#!" + sys.executable + "\n" + FAKE_AGENT, encoding="utf-8")
            executable.chmod(0o700)
        self.environment = dict(os.environ)
        self.environment.update({
            "HOME": str(self.home),
            # 不继承 WSL 注入的 Windows/npm PATH，避免意外探测本机真实智能体。
            "PATH": str(self.bin) + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "CODEX_HOME": str(self.home / ".codex"),
            "SHELL": "/bin/sh",
        })
        self.descriptor = None
        self.created = []
        self.child_processes = []
        self.start_server()

    def start_server(self):
        result = subprocess.run(
            [sys.executable, str(HELPER), "start", "--root", str(self.root)],
            env=self.environment, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        self.assertTrue(lines, "start 应输出服务器描述信息")
        self.descriptor = json.loads(lines[-1])
        self.assertEqual(self.descriptor["protocol"], 1)
        self.assertEqual(self.descriptor["version"], 1)
        self.assertEqual(Path(self.descriptor["root"]), self.root)
        self.wait_for(lambda: self.rpc("hello"), timeout=5)

    def tearDown(self):
        if self.descriptor:
            try:
                for session in self.rpc("sessions.list"):
                    if session["processState"] == "running":
                        self.rpc("sessions.stop", self.session_params(session))
                self.rpc("server.stop")
            except (OSError, RpcFailure, KeyError, TypeError):
                # 所有 PID 都来自本测试独立 root 的服务器，不枚举或终止其他进程。
                for session in self.created:
                    try:
                        os.kill(session["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                try:
                    os.kill(self.descriptor["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for child_pid, start_time in self.child_processes:
            try:
                current = Path(f"/proc/{child_pid}/stat").read_text().rsplit(")", 1)[1].split()
                if current[19] == start_time:
                    os.kill(child_pid, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
        self.sandbox.cleanup()

    def raw_rpc(self, method, params=None, token=None, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.descriptor["port"], timeout=30)
        request_headers = {"Content-Type": "application/json"}
        if token is not False:
            request_headers["X-Termflow-Token"] = self.descriptor["token"] if token is None else token
        request_headers.update(headers or {})
        payload = json.dumps({"method": method, "params": params or {}}).encode() if body is None else body
        try:
            connection.request("POST", "/rpc", payload, request_headers)
            response = connection.getresponse()
            raw = response.read()
            try:
                document = json.loads(raw)
            except json.JSONDecodeError:
                document = {"error": raw.decode(errors="replace")}
            return response.status, document
        finally:
            connection.close()

    def rpc(self, method, params=None):
        status, document = self.raw_rpc(method, params)
        if status != 200 or "error" in document:
            raise RpcFailure(f"{method}: HTTP {status}: {document}")
        self.assertIn("result", document)
        return document["result"]

    def assert_rpc_fails(self, method, params=None):
        status, document = self.raw_rpc(method, params)
        self.assertTrue(status >= 400 or "error" in document, (status, document))

    def wait_for(self, condition, timeout=15):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                result = condition()
                if result:
                    return result
            except (ConnectionError, OSError):
                pass
            time.sleep(0.03)
        self.fail("等待远端状态超时")

    def create(self, agent="codex", request_id=None, **overrides):
        params = {
            "requestId": request_id or str(uuid.uuid4()),
            "agentId": agent,
            "cwd": str(self.cwd),
            "rows": 30,
            "cols": 90,
        }
        params.update(overrides)
        session = self.rpc("sessions.create", params)
        self.created.append(session)
        self.assertEqual(session["agentId"], agent)
        self.assertGreater(session["pid"], 0)
        return session

    @staticmethod
    def session_params(session, **extra):
        return {"sessionId": session["id"], "instanceId": session["instanceId"], **extra}

    def read(self, session, cursor=0):
        result = self.rpc("sessions.read", self.session_params(session, cursor=cursor, maxBytes=262144))
        self.assertEqual(result["sessionId"], session["id"])
        self.assertEqual(result["instanceId"], session["instanceId"])
        return result, base64.b64decode(result["data"], validate=True)

    def wait_output(self, session, needle):
        end = time.monotonic() + 15
        last = None
        while time.monotonic() < end:
            last = self.read(session)
            if needle in last[1]:
                return last
            time.sleep(0.03)
        self.fail(f"未收到模拟CLI输出 {needle!r}；最后快照：{last!r}")

    def test_real_pty_preserves_ansi_utf8_and_initial_size(self):
        session = self.create()
        result, output = self.wait_output(session, b"SIZE:30:90")
        self.assertIn(b"\x1b[32m", output)
        self.assertIn("你好🌊".encode(), output)
        self.assertIn(b"READY:codex:", output)
        self.assertGreater(result["nextOffset"], 0)
        self.assertEqual(result["session"]["rows"], 30)
        self.assertEqual(result["session"]["cols"], 90)

    def test_write_and_resize_use_the_same_live_process(self):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        self.rpc("sessions.write", self.session_params(session, data="测试输入"))
        self.wait_output(session, b"INPUT:" + "测试输入".encode())
        self.rpc("sessions.resize", self.session_params(session, rows=42, cols=113))
        result, _ = self.wait_output(session, b"SIZE:42:113")
        self.assertEqual(result["session"]["pid"], session["pid"])

    def test_two_agents_are_isolated_and_stopping_one_preserves_the_other(self):
        codex = self.create("codex")
        claude = self.create("claude")
        self.wait_output(codex, b"READY:codex:")
        self.wait_output(claude, b"READY:claude:")
        self.assertNotEqual(codex["pid"], claude["pid"])
        self.assertNotEqual(codex["id"], claude["id"])
        before = self.read(claude)[0]["nextOffset"]
        self.rpc("sessions.stop", self.session_params(codex))
        stopped = self.wait_for(lambda: next((s for s in self.rpc("sessions.list") if s["id"] == codex["id"] and s["processState"] == "exited"), None))
        self.assertEqual(stopped["taskState"], "stopped")
        self.wait_for(lambda: self.read(claude)[0]["nextOffset"] > before)
        self.assertEqual(self.read(claude)[0]["session"]["processState"], "running")

    def test_repeated_create_requests_produce_one_pid(self):
        request_id = str(uuid.uuid4())
        first = self.create(request_id=request_id)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            sessions = list(pool.map(lambda _: self.create(request_id=request_id), range(6)))
        self.assertTrue(all(s["id"] == first["id"] and s["pid"] == first["pid"] for s in sessions))
        self.assertEqual(sum(s["id"] == first["id"] for s in self.rpc("sessions.list")), 1)

    def test_reused_request_id_cannot_silently_change_launch_parameters(self):
        request_id = str(uuid.uuid4())
        self.create(request_id=request_id)
        self.assert_rpc_fails("sessions.create", {
            "requestId": request_id, "agentId": "claude", "cwd": str(self.cwd), "rows": 30, "cols": 90,
        })

    def test_disconnected_clients_reattach_original_pid_and_accumulated_output(self):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        initial = self.read(session)[0]
        # raw_rpc 每次关闭 HTTP 连接，此间没有客户端连接或轮询。
        time.sleep(0.3)
        result, output = self.read(session, cursor=initial["nextOffset"])
        self.assertEqual(result["session"]["pid"], session["pid"])
        self.assertGreater(result["nextOffset"], initial["nextOffset"])
        self.assertIn(b"TICK:codex:", output)
        self.assertNotIn(b"READY:codex:", output)
        descriptor = dict(self.descriptor)
        self.start_server()
        self.assertEqual(self.descriptor["pid"], descriptor["pid"], "重复连接不得替换服务")
        self.assertEqual(self.read(session)[0]["session"]["pid"], session["pid"])

    def test_process_exit_is_preserved_with_exit_code(self):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        self.rpc("sessions.write", self.session_params(session, data="exit-test"))
        result = self.wait_for(lambda: self.read(session)[0] if self.read(session)[0]["session"]["processState"] == "exited" else None)
        self.assertEqual(result["session"]["exitCode"], 7)
        self.assertNotEqual(result["session"]["taskState"], "completed")

    def test_missing_sessions_old_instances_and_future_cursors_are_rejected(self):
        session = self.create()
        self.assert_rpc_fails("sessions.read", {"sessionId": "missing", "cursor": 0, "maxBytes": 64})
        self.assert_rpc_fails("sessions.read", self.session_params(session, cursor=2**62, maxBytes=64))
        old = {**self.session_params(session), "instanceId": "old-instance"}
        self.assert_rpc_fails("sessions.write", {**old, "data": "bad"})
        self.assert_rpc_fails("sessions.resize", {**old, "rows": 40, "cols": 80})
        self.assert_rpc_fails("sessions.stop", old)
        for method, extra in (("sessions.write", {"data": "bad"}), ("sessions.resize", {"rows": 30, "cols": 90}), ("sessions.stop", {})):
            self.assert_rpc_fails(method, {"sessionId": session["id"], **extra})
        self.assertEqual(self.read(session)[0]["session"]["processState"], "running")

    def test_rpc_requires_token_and_rejects_oversized_or_invalid_payloads(self):
        for token in (False, "incorrect-token"):
            status, document = self.raw_rpc("hello", token=token)
            self.assertIn(status, (401, 403))
        status, document = self.raw_rpc("hello", body=b"{}", headers={"Content-Length": str(2 * 1024 * 1024)})
        self.assertTrue(status >= 400 or "error" in document)
        status, document = self.raw_rpc("hello", body=b"{")
        self.assertTrue(status >= 400 or "error" in document)
        self.assert_rpc_fails("unsupported.operation")
        for payload in ({}, {"method": None}, {"method": 3}, {"method": "hello", "params": []}):
            status, document = self.raw_rpc("hello", body=json.dumps(payload).encode())
            self.assertTrue(status >= 400 or "error" in document)
        self.assertTrue(self.rpc("hello"), "异常请求后服务仍可用")

    def test_invalid_directory_and_dimensions_do_not_create_processes(self):
        params = {"requestId": str(uuid.uuid4()), "agentId": "codex", "cwd": str(self.cwd / "missing"), "rows": 30, "cols": 90}
        self.assert_rpc_fails("sessions.create", params)
        self.assert_rpc_fails("sessions.create", {**params, "cwd": str(self.cwd), "rows": -1})
        self.assert_rpc_fails("sessions.create", {**params, "cwd": str(self.cwd), "cols": 2**30})
        self.assertEqual(self.rpc("sessions.list"), [])

    def test_busy_server_cannot_be_stopped_or_uninstalled(self):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        self.assert_rpc_fails("server.stop")
        self.assert_rpc_fails("server.uninstall")
        self.assertTrue(self.root.exists())
        self.assertEqual(self.read(session)[0]["session"]["processState"], "running")

    def test_inspection_does_not_confuse_installation_with_login(self):
        inspection = self.rpc("inspect")
        self.assertEqual({agent["id"] for agent in inspection["agents"]}, {"codex", "claude"})
        for agent in inspection["agents"]:
            self.assertTrue(agent["installed"])
            self.assertIn("test-1.0", agent["version"])
            self.assertEqual(agent["authStatus"], "unauthenticated", agent)
            self.assertEqual(agent["hookStatus"], "pending")

    def test_supported_codex_launch_isolates_its_background_daemon(self):
        session = self.create()
        _, output = self.wait_output(session, b"ARGS:")
        arguments = json.loads(re.search(rb"ARGS:([^\r\n]*)", output).group(1))
        self.assertIn("--no-daemon", arguments)

    def test_legacy_codex_without_daemon_flag_still_launches(self):
        executable = self.bin / "codex"
        executable.write_text("#!" + sys.executable + "\n" + FAKE_AGENT.replace("fixture-options --no-daemon", "fixture-options"), encoding="utf-8")
        executable.chmod(0o700)
        session = self.create()
        _, output = self.wait_output(session, b"ARGS:")
        arguments = json.loads(re.search(rb"ARGS:([^\r\n]*)", output).group(1))
        self.assertNotIn("--no-daemon", arguments)

    def test_output_retention_is_bounded_and_reports_truncated_cursors(self):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        self.rpc("sessions.write", self.session_params(session, data="flood-test"))
        result = self.wait_for(lambda: self.read(session)[0] if self.read(session)[0]["session"]["outputStart"] > 0 else None)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["offset"], result["session"]["outputStart"])
        self.assertLessEqual(len(base64.b64decode(result["data"])), 262144)
        self.assertLessEqual(result["session"]["outputEnd"] - result["session"]["outputStart"], 8 * 1024 * 1024)
        current = self.wait_for(lambda: next((item for item in self.rpc("sessions.list") if item["id"] == session["id"] and item["outputEnd"] > 600 * 16384), None))
        _, tail = self.read(session, max(current["outputStart"], current["outputEnd"] - 4096))
        self.assertIn(b"FLOOD-END", tail)

    def test_hooks_drive_real_task_states_and_invalid_hook_token_is_rejected(self):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        initial_revision = session["revision"]
        for event, expected in (("UserPromptSubmit", "running"), ("PermissionRequest", "waiting"), ("PostToolUse", "running"), ("Stop", "completed")):
            self.rpc("sessions.write", self.session_params(session, data="hook:" + event))
            current = self.wait_for(lambda: next((item for item in self.rpc("sessions.list") if item["id"] == session["id"] and item["taskState"] == expected), None))
            self.assertTrue(current["hookObserved"])
            self.assertGreater(current["revision"], initial_revision)
            initial_revision = current["revision"]
        self.rpc("sessions.write", self.session_params(session, data="bad-hook:UserPromptSubmit"))
        self.wait_output(session, b"HOOK_RESULT:400")
        self.assertEqual(self.read(session)[0]["session"]["taskState"], "completed")
        inspection = self.rpc("inspect")
        self.assertEqual(next(agent for agent in inspection["agents"] if agent["id"] == "codex")["hookStatus"], "configured")

    def test_codex_hook_merge_preserves_user_actions_and_config(self):
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        config_path = codex_home / "config.toml"
        original_toml = '# 用户配置\nmodel = "test-preserved"\n'
        config_path.write_text(original_toml, encoding="utf-8")
        hooks_path = codex_home / "hooks.json"
        original = {
            "custom": {"note": "保留"},
            "hooks": {"Stop": [{"matcher": "user-matcher", "hooks": [
                {"type": "command", "command": "echo user-hook"},
                {"type": "command", "command": "TERMFLOW_REMOTE_HOOK=1 obsolete-helper"},
            ]}]},
        }
        hooks_path.write_text(json.dumps(original), encoding="utf-8")
        self.create("codex")
        self.create("codex")
        merged = json.loads(hooks_path.read_text(encoding="utf-8"))
        self.assertEqual(merged["custom"], original["custom"])
        self.assertEqual(config_path.read_text(encoding="utf-8"), original_toml)
        mixed = next(definition for definition in merged["hooks"]["Stop"] if definition.get("matcher") == "user-matcher")
        self.assertEqual(mixed["hooks"], [{"type": "command", "command": "echo user-hook"}])
        for definitions in merged["hooks"].values():
            commands = [action.get("command", "") for definition in definitions for action in definition.get("hooks", [])]
            self.assertEqual(sum("TERMFLOW_REMOTE_HOOK=1" in command for command in commands), 1)
            self.assertFalse(any("obsolete-helper" in command for command in commands))
        self.assertEqual(hooks_path.stat().st_mode & 0o777, 0o600)

    def test_malformed_codex_configuration_is_preserved_without_launch(self):
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        hooks_path = codex_home / "hooks.json"
        original = b'{"hooks": invalid user configuration'
        hooks_path.write_bytes(original)
        self.assert_rpc_fails("sessions.create", {
            "requestId": str(uuid.uuid4()), "agentId": "codex", "cwd": str(self.cwd), "rows": 30, "cols": 90,
        })
        self.assertEqual(hooks_path.read_bytes(), original)
        self.assertEqual(self.rpc("sessions.list"), [])

    def test_codex_hook_symlink_is_preserved_without_launch(self):
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        original = b'{"hooks":{"Stop":[]},"user":"preserve-target"}'
        user_file = self.directory / "user-managed-hooks.json"
        user_file.write_bytes(original)
        hooks_path = codex_home / "hooks.json"
        hooks_path.symlink_to(user_file)
        self.assert_rpc_fails("sessions.create", {
            "requestId": str(uuid.uuid4()), "agentId": "codex", "cwd": str(self.cwd), "rows": 30, "cols": 90,
        })
        self.assertTrue(hooks_path.is_symlink())
        self.assertEqual(hooks_path.readlink(), user_file)
        self.assertEqual(user_file.read_bytes(), original)
        self.assertEqual(self.rpc("sessions.list"), [])

    def test_stop_terminates_the_foreground_job_group(self):
        self.assert_foreground_job_stops("foreground-test")

    def test_stop_kills_a_foreground_job_which_ignores_termination(self):
        self.assert_foreground_job_stops("foreground-ignore-test")

    def assert_foreground_job_stops(self, command):
        session = self.create()
        self.wait_output(session, b"READY:codex:")
        self.rpc("sessions.write", self.session_params(session, data=command))
        _, output = self.wait_output(session, b"FG_PID:")
        child_pid = int(re.search(rb"FG_PID:(\d+)", output).group(1))
        self.assertNotEqual(child_pid, session["pid"])
        start_time = Path(f"/proc/{child_pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        self.child_processes.append((child_pid, start_time))
        self.rpc("sessions.stop", self.session_params(session))

        def child_not_running():
            try:
                # 已退出、由 init 待回收的短暂 zombie 也没有可继续执行的作业。
                state = Path(f"/proc/{child_pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                return state == "Z"
            except FileNotFoundError:
                return True

        self.wait_for(child_not_running)
        stopped = self.read(session)[0]["session"]
        self.assertEqual(stopped["processState"], "exited")
        self.assertEqual(stopped["taskState"], "stopped")

    def test_nvm_symlink_launch_and_inspection_find_the_executable_runtime(self):
        # 模拟 login shell 找到 nvm/bin，daemon PATH 本身没有它；保留 npm 风格符号链接。
        (self.bin / "codex").unlink()
        nvm_bin = self.directory / "nvm" / "bin"
        nvm_bin.mkdir(parents=True)
        nvm_lib = self.directory / "nvm" / "lib"
        nvm_lib.mkdir()
        real_cli = nvm_lib / "fake-codex.py"
        real_cli.write_text("#!/usr/bin/env termflow-fixture-runtime\n" + FAKE_AGENT, encoding="utf-8")
        real_cli.chmod(0o700)
        executable = nvm_bin / "codex"
        executable.symlink_to(real_cli)
        runtime = nvm_bin / "termflow-fixture-runtime"
        runtime.write_text("#!" + sys.executable + "\nimport os,sys\nos.execv(sys.executable,[sys.executable]+sys.argv[1:])\n", encoding="utf-8")
        runtime.chmod(0o700)
        bash = self.bin / "bash"
        bash.write_text("#!" + sys.executable + "\nimport sys\nif sys.argv[1:]==['-ilc','command -v codex']:\n print(" + repr(str(executable)) + ")\nelse:\n sys.exit(1)\n", encoding="utf-8")
        bash.chmod(0o700)
        inspection = self.rpc("inspect")
        codex = next(agent for agent in inspection["agents"] if agent["id"] == "codex")
        self.assertEqual(codex["executable"], str(executable))
        self.assertIn("test-1.0", codex["version"])
        self.assertEqual(codex["authStatus"], "unauthenticated")
        session = self.create()
        self.wait_output(session, b"READY:codex:")

    def test_failed_uninstall_does_not_leave_the_server_stopping(self):
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        hooks_path = codex_home / "hooks.json"
        user_file = self.directory / "user-managed-hooks.json"
        user_file.write_text('{"hooks":{}}', encoding="utf-8")
        for variant in ("invalid-json", "symlink"):
            with self.subTest(variant=variant):
                if variant == "invalid-json":
                    hooks_path.write_bytes(b"{invalid configuration")
                else:
                    hooks_path.symlink_to(user_file)
                self.assert_rpc_fails("server.uninstall")
                self.assertTrue(self.rpc("hello"))
                session = self.create("shell")
                self.assertEqual(session["processState"], "running")
                self.rpc("sessions.stop", self.session_params(session))
                if variant == "symlink":
                    self.assertTrue(hooks_path.is_symlink())
                hooks_path.unlink()

    def test_claude_session_settings_preserve_global_user_configuration(self):
        claude_home = self.home / ".claude"
        claude_home.mkdir()
        settings = claude_home / "settings.json"
        original = b'{"permissions":{"allow":["Read"]},"hooks":{"Stop":[]}}'
        settings.write_bytes(original)
        session = self.create("claude")
        self.wait_output(session, b"READY:claude:")
        self.assertEqual(settings.read_bytes(), original)

    def test_uninstall_preserves_unknown_files_and_user_codex_hooks(self):
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        hooks_path = codex_home / "hooks.json"
        original = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo keep-user-hook"}]}]}}
        hooks_path.write_text(json.dumps(original), encoding="utf-8")
        session = self.create()
        self.rpc("sessions.stop", self.session_params(session))
        keep = self.root / "user-kept.txt"
        keep.write_text("must remain", encoding="utf-8")
        self.rpc("server.uninstall")
        self.wait_for(lambda: not (self.root / "server.json").exists())
        self.descriptor = None
        self.assertEqual(keep.read_text(encoding="utf-8"), "must remain")
        remaining = json.loads(hooks_path.read_text(encoding="utf-8"))
        commands = [action.get("command", "") for definitions in remaining["hooks"].values() for definition in definitions for action in definition.get("hooks", [])]
        self.assertIn("echo keep-user-hook", commands)
        self.assertFalse(any("TERMFLOW_REMOTE_HOOK=1" in command for command in commands))


if __name__ == "__main__":
    unittest.main(verbosity=2)
