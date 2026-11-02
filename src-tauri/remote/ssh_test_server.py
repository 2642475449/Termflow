#!/usr/bin/env python3
"""可选 Windows/WSL SSH 集成测试宿主，不属于应用运行依赖。

依赖宿主 Python 的 paramiko，Linux 端仅依赖测试目录中的 Python。
只监听 127.0.0.1；测试主机密钥、known_hosts、HOME 全部位于 state-file 旁。
将输出的 port/config 传给 Rust ignored 测试的环境变量；创建 .stop 文件退出。
"""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import threading
import time

import paramiko


def linux_path(path):
    path = Path(path).resolve()
    return "/mnt/host/" + path.drive[0].lower() + "/" + "/".join(path.parts[1:])


class TestServer(paramiko.ServerInterface):
    def __init__(self):
        self.destinations = {}
        self.commands = {}
        self.ready = threading.Event()

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, password):
        accepted = username == "tester" and password == "termflow-test-password"
        print("test password accepted" if accepted else "test password rejected", flush=True)
        return paramiko.AUTH_SUCCESSFUL if accepted else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        if destination[0] != "127.0.0.1":
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        self.destinations[chanid] = destination
        return paramiko.OPEN_SUCCEEDED

    def check_channel_exec_request(self, channel, command):
        self.commands[channel.get_id()] = command.decode()
        self.ready.set()
        return True


def copy_socket(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except (OSError, EOFError):
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except (OSError, AttributeError):
            pass


def run_exec(channel, server, args, home):
    deadline = time.monotonic() + 10
    while channel.get_id() not in server.commands and time.monotonic() < deadline:
        server.ready.wait(0.05)
    command = server.commands.get(channel.get_id(), "")
    match = re.search(r"exec python3 -c (.*); else printf ", command, re.S)
    if not match:
        channel.sendall_stderr(b"test server rejected an unexpected command\n")
        channel.send_exit_status(1)
        channel.close()
        return
    bootstrap = shlex.split(match.group(1))
    if len(bootstrap) != 1:
        raise ValueError("unexpected bootstrap argv")
    # 不在 Windows shell 或 WSL shell 中解释路径/变量；直接传绝对 argv。
    prefix = "import os;os.environ['HOME']=%r;os.environ['SHELL']='/bin/sh';" % home
    process = subprocess.Popen(
        ["wsl", "-d", args.distribution, "--exec", args.linux_python, "-c", prefix + bootstrap[0]],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    print("test Linux bootstrap started", flush=True)

    def upload():
        received = 0
        try:
            while True:
                data = channel.recv(65536)
                if not data:
                    break
                process.stdin.write(data)
                process.stdin.flush()
                received += len(data)
        except (OSError, EOFError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
            print("test upload channel closed after %d bytes" % received, flush=True)

    def download(stream, send):
        try:
            while True:
                data = os.read(stream.fileno(), 65536)
                if not data:
                    return
                send(data)
        except (OSError, EOFError):
            pass

    threading.Thread(target=upload, daemon=True).start()
    threading.Thread(target=download, args=(process.stderr, channel.sendall_stderr), daemon=True).start()
    download(process.stdout, channel.sendall)
    code = process.wait()
    try:
        channel.send_exit_status(code)
        channel.close()
    except (OSError, EOFError):
        pass


def run_forward(channel, destination):
    try:
        target = socket.create_connection(destination, timeout=8)
        target.settimeout(None)
        thread = threading.Thread(target=copy_socket, args=(channel, target), daemon=True)
        thread.start()
        copy_socket(target, channel)
    except OSError:
        pass
    finally:
        channel.close()


def handle_connection(client, host_key, args, home):
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    server = TestServer()
    try:
        transport.start_server(server=server)
        while transport.is_active():
            channel = transport.accept(0.2)
            if channel is None:
                continue
            destination = server.destinations.get(channel.get_id())
            if destination:
                threading.Thread(target=run_forward, args=(channel, destination), daemon=True).start()
            else:
                threading.Thread(target=run_exec, args=(channel, server, args, home), daemon=True).start()
    except (OSError, EOFError, paramiko.SSHException):
        pass
    finally:
        transport.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--linux-python", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--distribution", default="docker-desktop")
    args = parser.parse_args()
    state_file = Path(args.state_file).resolve()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    home = state_file.parent / "home"
    home.mkdir(exist_ok=True)
    config = state_file.parent / "ssh_config"
    known = state_file.parent / "known_hosts"
    config.write_text(
        'Host *\n  UserKnownHostsFile "%s"\n  GlobalKnownHostsFile NUL\n'
        '  PubkeyAuthentication no\n  PreferredAuthentications password\n'
        '  IdentityAgent none\n  CheckHostIP no\n  LogLevel ERROR\n' % known.as_posix(),
        encoding="utf-8",
    )
    host_key = paramiko.RSAKey.generate(2048)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(0.2)
    info = {"port": listener.getsockname()[1], "config": str(config), "home": linux_path(home)}
    state_file.write_text(json.dumps(info), encoding="utf-8")
    print(json.dumps(info), flush=True)
    expires = time.monotonic() + 900
    try:
        while time.monotonic() < expires and not state_file.with_suffix(".stop").exists():
            try:
                client, _ = listener.accept()
            except socket.timeout:
                continue
            threading.Thread(target=handle_connection, args=(client, host_key, args, info["home"]), daemon=True).start()
    finally:
        listener.close()


if __name__ == "__main__":
    main()
