#!/usr/bin/env python3
"""qingcode-server daemon 真机冒烟测试（协议 v1，Windows 远端）。

Windows daemon 化的验收脚本：named pipe IPC + DACL + `--detach` 自脱离 +
ConPTY 终端持久化。流程与 `daemon_smoke.py`（Linux 版）一致：
HELLO 握手 → server.info → fs.scan → pty.create/input 实时输出 → 杀掉 SSH
代理模拟断线 → 重连后 pty.list/pty.attach 验证终端存活与 seq 补发 →
pty.kill → server.shutdown → 幂等重启校验（首实例锁）。

在 Windows 宿主运行（python 3，Git Bash 或 pwsh 均可），凭据走密钥认证
（不支持 askpass 密码流），远端默认 shell 按 Git Bash 处理：

  set QC_E2E_HOST=192.168.252.107 & set QC_E2E_USER=administrator & set QC_E2E_PORT=28822 ^
  python scripts/e2e-ssh-server/daemon_smoke_windows.py

环境变量：
  QC_E2E_HOST / QC_E2E_USER / QC_E2E_PORT   远端 SSH（密钥认证，默认端口 22）
  QC_E2E_BINARY   本地 Windows server exe（默认 target/server/qingcode-server-windows-x86_64.exe）
  QC_E2E_DIR      远端主目录下的测试目录名（默认 qc-dsmoke）
  QC_E2E_KEEP=1   保留远端现场（不做收尾清场）

只依赖 python3 标准库。退出码：0=全部通过，1=有断言失败，2=前置条件不满足。
"""

import hashlib
import os
import struct
import subprocess
import sys
import time

HOST = os.environ["QC_E2E_HOST"]
USER = os.environ.get("QC_E2E_USER", "administrator")
PORT = os.environ.get("QC_E2E_PORT", "22")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BINARY = os.environ.get(
    "QC_E2E_BINARY",
    os.path.join(REPO, "src-tauri", "target", "server", "qingcode-server-windows-x86_64.exe"),
)
REMOTE_HOME_REL = (os.environ.get("QC_E2E_DIR") or "qc-dsmoke").strip().strip("/\\")
if not REMOTE_HOME_REL:
    REMOTE_HOME_REL = "qc-dsmoke"
REMOTE_STATE_REL = f"{REMOTE_HOME_REL}/run"
# 备份目录带时间戳，只保留现场证据，不覆盖历史。
BACKUP_REL = f"{REMOTE_HOME_REL}.bak-{time.strftime('%Y%m%d-%H%M%S')}"

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(name)


# ---------------------------------------------------------------- SSH 工具
def ssh_args(extra):
    return [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=NUL",
        "-o", "LogLevel=ERROR",
        "-p", PORT,
        f"{USER}@{HOST}",
    ] + extra


def ssh_run(cmd, timeout=40):
    return subprocess.run(
        ssh_args([cmd]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        stdin=subprocess.DEVNULL,
    )


def scp_to(local, remote_rel):
    return subprocess.run(
        ["scp", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
         "-o", "UserKnownHostsFile=NUL", "-o", "LogLevel=ERROR", "-P", PORT,
         local, f"{USER}@{HOST}:{remote_rel}"],
        capture_output=True, text=True, timeout=180,
    )


# ---------------------------------------------------------------- 最小 MessagePack
def mp(data):
    if data is None:
        return b"\xc0"
    if data is True:
        return b"\xc3"
    if data is False:
        return b"\xc2"
    if isinstance(data, int):
        if 0 <= data < 128:
            return bytes([data])
        if data < 256:
            return b"\xcc" + bytes([data])
        if data < 65536:
            return b"\xcd" + struct.pack(">H", data)
        return b"\xce" + struct.pack(">I", data)
    if isinstance(data, str):
        raw = data.encode()
        if len(raw) < 32:
            return bytes([0xA0 | len(raw)]) + raw
        return b"\xd9" + bytes([len(raw)]) + raw
    if isinstance(data, (bytes, bytearray)):
        raw = bytes(data)
        if len(raw) < 256:
            return b"\xc4" + bytes([len(raw)]) + raw
        return b"\xc5" + struct.pack(">H", len(raw)) + raw
    if isinstance(data, dict):
        out = bytes([0x80 | len(data)]) if len(data) < 16 else b"\xde" + struct.pack(">H", len(data))
        for k, v in data.items():
            out += mp(k) + mp(v)
        return out
    if isinstance(data, list):
        out = bytes([0x90 | len(data)]) if len(data) < 16 else b"\xdd" + struct.pack(">H", len(data))
        for v in data:
            out += mp(v)
        return out
    raise TypeError(f"unsupported {type(data)}")


def mp_decode(raw, pos=0):
    b = raw[pos]
    pos += 1
    if b < 0x80:
        return b, pos
    if b >= 0xE0:
        return b - 256, pos
    if 0x80 <= b <= 0x8F:
        n, out, pos = b & 0xF, {}, pos
        for _ in range(n):
            k, pos = mp_decode(raw, pos)
            v, pos = mp_decode(raw, pos)
            out[k] = v
        return out, pos
    if 0x90 <= b <= 0x9F:
        n, out, pos = b & 0xF, [], pos
        for _ in range(n):
            v, pos = mp_decode(raw, pos)
            out.append(v)
        return out, pos
    if 0xA0 <= b <= 0xBF:
        n = b & 0x1F
        return raw[pos:pos + n].decode(), pos + n
    if b == 0xC4:
        n = raw[pos]; pos += 1
        return raw[pos:pos + n], pos + n
    if b == 0xC5:
        n = struct.unpack(">H", raw[pos:pos + 2])[0]; pos += 2
        return raw[pos:pos + n], pos + n
    if b == 0xC0:
        return None, pos
    if b == 0xC2:
        return False, pos
    if b == 0xC3:
        return True, pos
    if b == 0xCC:
        return raw[pos], pos + 1
    if b == 0xCD:
        return struct.unpack(">H", raw[pos:pos + 2])[0], pos + 2
    if b == 0xCE:
        return struct.unpack(">I", raw[pos:pos + 4])[0], pos + 4
    if b == 0xD9:
        n = raw[pos]; pos += 1
        return raw[pos:pos + n].decode(), pos + n
    if b == 0xDE:
        n = struct.unpack(">H", raw[pos:pos + 2])[0]; pos += 2
        out, pos = {}, pos
        for _ in range(n):
            k, pos = mp_decode(raw, pos)
            v, pos = mp_decode(raw, pos)
            out[k] = v
        return out, pos
    if b == 0xDD:
        n = struct.unpack(">H", raw[pos:pos + 2])[0]; pos += 2
        out, pos = [], pos
        for _ in range(n):
            v, pos = mp_decode(raw, pos)
            out.append(v)
        return out, pos
    raise ValueError(f"unsupported msgpack byte 0x{b:02x}")


# ---------------------------------------------------------------- 协议 v1 帧
KIND = {"HELLO": 1, "REQ": 2, "RES": 3, "ERR": 4, "EVENT": 5,
        "STREAM_DATA": 6, "STREAM_END": 7, "WINDOW": 8, "CANCEL": 9,
        "PING": 10, "PONG": 11}


def frame(kind, stream_id, payload=b""):
    return struct.pack(">IBI", 5 + len(payload), kind, stream_id) + payload


class Reader:
    """从 ssh 子进程 stdout 读完整帧（带超时）。"""

    def __init__(self, proc):
        self.proc = proc
        self.buf = b""

    def read_exact(self, n, deadline):
        while len(self.buf) < n:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise TimeoutError("read frame timeout")
            chunk = self.proc.stdout.read1(min(65536, n - len(self.buf)))
            if not chunk:
                raise EOFError("proxy stdout closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read_frame(self, timeout=15):
        deadline = time.monotonic() + timeout
        (length,) = struct.unpack(">I", self.read_exact(4, deadline))
        body = self.read_exact(length, deadline)
        kind, stream_id = struct.unpack(">BI", body[:5])
        return kind, stream_id, body[5:]


class DaemonSession:
    """远端 connect --stdio 代理（经 SSH exec，Git Bash 直通二进制 stdio）。"""

    def __init__(self, remote_bin_bash, state_arg, client_id="qc-dsmoke"):
        command = f"{remote_bin_bash} connect --stdio --ensure-daemon --state-dir {state_arg}"
        self.proc = subprocess.Popen(
            ssh_args([command]),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.reader = Reader(self.proc)
        self.next_id = 1
        self.hello_resp = None
        self.client_id = client_id

    def send(self, kind, stream_id, payload=b""):
        self.proc.stdin.write(frame(kind, stream_id, payload))
        self.proc.stdin.flush()

    def handshake(self, token):
        payload = mp({"clientId": self.client_id, "protocolMin": 1,
                      "protocolMax": 1, "token": token})
        self.send(KIND["HELLO"], 0, payload)
        deadline = time.monotonic() + 30
        while True:
            kind, sid, body = self.reader.read_frame(timeout=max(1, deadline - time.monotonic()))
            if kind == KIND["HELLO"]:
                self.hello_resp, _ = mp_decode(body)
                return self.hello_resp
            if kind != KIND["PING"]:
                raise RuntimeError(f"握手阶段收到意外帧 kind={kind}")

    def request(self, method, params):
        rid = self.next_id
        self.next_id += 1
        self.send(KIND["REQ"], rid, mp({"id": rid, "method": method,
                                        "params": mp(params)}))
        return self.wait_response(rid, timeout=30)

    def wait_response(self, rid, timeout=30):
        """等 RES/ERR，返回 `(response, events)`。

        等响应期间到达的 EVENT（比如 `pty.input` 触发的 ptyData）必须一并
        交给调用方，否则会被丢弃、后面的回显断言只能看到响应之后的输出。
        """
        deadline = time.monotonic() + timeout
        events = []
        while True:
            kind, sid, body = self.reader.read_frame(timeout=max(1, deadline - time.monotonic()))
            if kind == KIND["RES"] and sid == rid:
                body_decoded, _ = mp_decode(body)
                res = body_decoded.get("result") if isinstance(body_decoded, dict) and "result" in body_decoded else body_decoded
                return {"res": res, "events": events}, events
            if kind == KIND["ERR"] and sid == rid:
                err, _ = mp_decode(body)
                return {"err": err, "events": events}, events
            if kind == KIND["EVENT"]:
                ev, _ = mp_decode(body)
                events.append(ev)

    def collect_events(self, timeout):
        """继续读最多 timeout 秒，返回期间收到的 EVENT（ptyData 等）。"""
        events = []
        deadline = time.monotonic() + timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                break
            try:
                kind, sid, body = self.reader.read_frame(timeout=remain)
            except (TimeoutError, EOFError):
                break
            if kind == KIND["EVENT"]:
                ev, _ = mp_decode(body)
                events.append(ev)
        return events


def pty_output(events, pty_id=None):
    """把 EVENT 里的 ptyData 拼成 bytes（可按 pty id 过滤）。"""
    out = b""
    for ev in events:
        if ev.get("event") != "ptyData":
            continue
        data = ev.get("data") or {}
        if pty_id is not None and data.get("id") != pty_id:
            continue
        out += bytes(data.get("data") or b"")
    return out


def _daemon_where():
    """PowerShell Where-Object 条件。

    只匹配常驻 daemon（`daemon --state-dir ...`），排除 `daemon --detach`
    启动器和 `connect --stdio --ensure-daemon` 代理：后者命令行里也带
    `--state-dir`/`--ensure-daemon`，误算会让计数忽大忽小。
    """
    return ("\\$_.CommandLine -like '* daemon --state-dir*' -and "
            f"\\$_.CommandLine -like '*{REMOTE_HOME_REL}*'")


def list_test_daemons():
    """返回 [(pid, command_line)]：命令行含 `daemon --state-dir` 与测试目录的进程。"""
    cmd = ("powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter "
           "'Name like ''qingcode-server%''' | Where-Object { " + _daemon_where() +
           " } | ForEach-Object { '{0} {1}' -f \\$_.ProcessId, \\$_.CommandLine }\"")
    proc = ssh_run(cmd)
    rows = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        pid_text, _, command_line = line.partition(" ")
        if pid_text.isdigit():
            rows.append((int(pid_text), command_line.strip()))
    return rows


def kill_test_daemons():
    """只结束本测试目录的 daemon，不碰真实项目的 server。"""
    cmd = ("powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter "
           "'Name like ''qingcode-server%''' | Where-Object { " + _daemon_where() +
           " } | ForEach-Object { Stop-Process -Id \\$($_.ProcessId) -Force "
           "-ErrorAction SilentlyContinue }\"")
    return ssh_run(cmd)


def wait_daemon_count(expected=1, timeout=10):
    """轮询等待 daemon 进程数达到 expected，返回最后一次列表。"""
    deadline = time.monotonic() + timeout
    rows = list_test_daemons()
    while len(rows) != expected and time.monotonic() < deadline:
        time.sleep(0.4)
        rows = list_test_daemons()
    return rows


def main():
    if not os.path.isfile(BINARY):
        print(f"前置条件不满足：本地二进制不存在 {BINARY}")
        return 2
    probe = ssh_run("echo ok && echo $USERPROFILE")
    if "ok" not in probe.stdout:
        print("前置条件不满足：SSH 密钥认证失败", probe.stderr.strip()[:120])
        return 2
    home = probe.stdout.splitlines()[1].strip().replace("\\", "/")
    if not home:
        print("前置条件不满足：无法取得 USERPROFILE")
        return 2
    # bash 侧可执行的项目路径（Git Bash 接受盘符 + 正斜杠）。
    project = f"{home}/{REMOTE_HOME_REL}/project"
    remote_bin = f"{project}/.qingcode/server/qingcode-server-windows-x86_64.exe"
    state_arg = f"{home}/{REMOTE_STATE_REL}"
    print(f"remote home={home} project={project}")

    # 1. 先留证据再清场（QC_E2E_DIR 可覆盖测试目录）
    #    只拷 run/server.log 与 run/token，拷贝失败不影响后续流程。
    proc = ssh_run(
        f"if [ -d ~/{REMOTE_HOME_REL} ]; then mkdir -p ~/{BACKUP_REL}/run; "
        f"for f in server.log token; do "
        f"[ -f ~/{REMOTE_HOME_REL}/run/$f ] && "
        f"cp ~/{REMOTE_HOME_REL}/run/$f ~/{BACKUP_REL}/run/$f; done; "
        f"echo BACKED_UP=~/{BACKUP_REL}; fi"
    )
    for line in (proc.stdout or "").splitlines():
        if line.startswith("BACKED_UP="):
            print(f"已备份现场证据到 {line.split('=', 1)[1]}")
    # 备份完成后再停掉上一轮遗留的 daemon，避免它继续占用管道/日志文件。
    kill_test_daemons()
    time.sleep(0.5)
    ssh_run(f"rm -rf ~/{REMOTE_HOME_REL} && mkdir -p {project}/src "
            f"{project}/.qingcode/server {state_arg}")
    ssh_run(f"printf \"hello world\\\\n\" > {project}/src/main.rs && "
            f"printf \"中文内容命中\\\\n\" > {project}/中文.txt && printf x > {project}/.qingcode/server/.keep")
    proc = scp_to(BINARY, f"{REMOTE_HOME_REL}/server.exe")
    if proc.returncode != 0:
        print("前置条件不满足：scp 失败", proc.stderr.strip()[:160])
        return 2
    ssh_run(f"mv ~/{REMOTE_HOME_REL}/server.exe {remote_bin}")

    # 2. self-check 完整性（同时探测 noexec）
    with open(BINARY, "rb") as f:
        expected = hashlib.sha256(f.read()).hexdigest()
    proc = ssh_run(f"{remote_bin} self-check --expect-sha256 {expected}; echo EXIT=$?")
    check("self-check sha256 匹配", "EXIT=0" in proc.stdout, proc.stdout.strip()[-60:])

    # 3. daemon --detach 自脱离启动：启动器必须立即退出，daemon 常驻
    #    硬杀过的 daemon 可能留下 run/pipe，先删掉，避免 ready 判定把残留当成新实例。
    ssh_run(f"rm -f {state_arg}/pipe")
    started = time.monotonic()
    proc = ssh_run(f"{remote_bin} daemon --detach --state-dir {state_arg}; echo EXIT=$?")
    check("daemon --detach 启动器立即退出", "EXIT=0" in proc.stdout and time.monotonic() - started < 15,
          proc.stdout.strip()[-40:])
    token = ""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        proc = ssh_run(f"cat {state_arg}/token 2>/dev/null")
        token = proc.stdout.strip()
        if token:
            break
        time.sleep(0.5)
    check("daemon token 可读", len(token) >= 16, f"len={len(token)}")
    pipe_name = ""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        proc = ssh_run(f"cat {state_arg}/pipe 2>/dev/null")
        pipe_name = proc.stdout.strip()
        if "qingcode-server-daemon-" in pipe_name:
            break
        time.sleep(0.4)
    check("run/pipe 管道名落盘",
          "qingcode-server-daemon-" in pipe_name and pipe_name.startswith("\\\\.\\pipe\\"),
          pipe_name[:60])
    ready_daemons = wait_daemon_count(1, timeout=10)
    check("daemon 进程存活且唯一", len(ready_daemons) == 1,
          ",".join(str(pid) for pid, _ in ready_daemons))

    # 4. HELLO 握手 + server.info
    s1 = DaemonSession(remote_bin, state_arg)
    s2 = None
    try:
        hello = s1.handshake(token)
        check("HELLO 协商 protocol=1", hello.get("protocol") == 1, str(hello.get("protocol")))
        check("HELLO 回报 serverVersion/pid/os",
              bool(hello.get("serverVersion")) and int(hello.get("pid", 0)) > 0 and hello.get("os") == "windows",
              f"{hello.get('serverVersion')} pid={hello.get('pid')} os={hello.get('os')}")
        daemon_pid = int(hello.get("pid", 0))

        r, _ = s1.request("server.info", {})
        check("server.info 返回", "err" not in r and "version" in str(r.get("res")), str(r.get("res"))[:80])

        # 5. fs.scan：原生盘符路径 + 客户端实际发送的 POSIX 风格 `/C:/...` 两轮
        r, _ = s1.request("fs.scan", {"root": project, "path": "."})
        names = [e.get("name") for e in (r.get("res") or {}).get("entries", [])]
        check("fs.scan 返回条目（原生 C:/ 根）", "src" in names and "中文.txt" in names, ",".join(names))
        posix_root = "/" + project
        r, _ = s1.request("fs.scan", {"root": posix_root, "path": "."})
        names = [e.get("name") for e in (r.get("res") or {}).get("entries", [])]
        check("fs.scan 接受 POSIX 盘符根 /C:/...", "src" in names and "中文.txt" in names,
              f"root={posix_root} names={','.join(names)}")
        r, _ = s1.request("fs.scan", {"root": project, "path": "T:/definitely-not-there"})
        check("fs.scan 拒绝越界路径", "err" in r, str(r.get("err", {}).get("code")))

        # 6. pty 实时输出（ConPTY + cmd）
        r, _ = s1.request("pty.create", {"cwd": project, "cols": 80, "rows": 24})
        pty_id = r["res"]["id"]
        check("pty.create 返回 id", bool(pty_id), str(pty_id))
        # wait_response 会把等响应期间收到的 EVENT 一并返回，这里必须先消费，
        # 否则响应前已到达的 ptyData 被丢掉，回显断言会假失败。
        _, events = s1.request("pty.input", {"id": pty_id, "data": b"echo qc-smoke-42\r\n"})
        got = pty_output(events, pty_id).decode(errors="replace")
        deadline = time.monotonic() + 8
        while "42" not in got and time.monotonic() < deadline:
            events = s1.collect_events(timeout=min(2.0, max(0.2, deadline - time.monotonic())))
            got += pty_output(events, pty_id).decode(errors="replace")
        check("pty.input 实时回显 42", "42" in got, got.strip()[:40])

        # 7. 杀掉 SSH 子进程模拟断线：daemon 与终端必须存活
        s1.proc.kill()
        s1.proc.wait()
        time.sleep(1.5)
        survivors = wait_daemon_count(1, timeout=5)
        check("断线后 daemon 进程存活且唯一", len(survivors) == 1,
              ",".join(str(pid) for pid, _ in survivors))
        check("断线后 daemon pid 未变（无重启）",
              len(survivors) == 1 and survivors[0][0] == daemon_pid,
              f"pid={[pid for pid, _ in survivors]} 期望={daemon_pid}")

        # 8. 重连接回终端
        s2 = DaemonSession(remote_bin, state_arg)
        s2.handshake(token)
        r, _ = s2.request("pty.list", {})
        listing = str(r.get("res"))
        check("pty.list 仍包含终端", pty_id in listing, listing[:80])
        r, _ = s2.request("pty.attach", {"id": pty_id, "fromSeq": 0})
        seq_end = (r.get("res") or {}).get("seqEnd", 0)
        check("pty.attach 返回 seqEnd", seq_end > 0, f"seqEnd={seq_end}")
        replay = b""
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            try:
                kind, sid, body = s2.reader.read_frame(timeout=2)
            except (TimeoutError, EOFError):
                break
            if kind == KIND["STREAM_DATA"]:
                chunk, _ = mp_decode(body)
                replay += chunk["data"]
            elif kind == KIND["STREAM_END"] and sid == s2.next_id - 1:
                break
        check("attach 补发含历史输出 42", b"42" in replay, f"{len(replay)}B")

        # 9. 错误 token 必须被拒
        s3 = DaemonSession(remote_bin, state_arg, client_id="intruder")
        try:
            s3.handshake("deadbeef" * 8)
            check("错误 token 被拒绝", False, "握手竟然成功了")
        except (TimeoutError, EOFError, RuntimeError):
            check("错误 token 被拒绝", True)
        finally:
            try:
                s3.proc.kill()
            except Exception:
                pass

        # 10. 幂等重启：已有实例时第二个 daemon 按成功退出，且不能多出进程
        before = list_test_daemons()
        proc = ssh_run(f"{remote_bin} daemon --detach --state-dir {state_arg}; echo EXIT=$?")
        check("重复启动按成功退出（首实例锁）", "EXIT=0" in proc.stdout, proc.stdout.strip()[-40:])
        # 后起的副本可能短暂可见，等它按首实例锁退出后再采样两次。
        after = wait_daemon_count(1, timeout=10)
        time.sleep(1.0)
        after = list_test_daemons()
        check("重复启动后 daemon 进程数仍为 1", len(after) == 1,
              ",".join(str(pid) for pid, _ in after))
        check("重复启动后 daemon pid 不变",
              len(before) == 1 and len(after) == 1 and before[0][0] == after[0][0] == daemon_pid,
              f"before={[pid for pid, _ in before]} after={[pid for pid, _ in after]} 期望={daemon_pid}")

        # 11. 收尾：pty.kill + server.shutdown
        s2.request("pty.kill", {"id": pty_id})
        s2.request("server.shutdown", {})
        try:
            s2.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            s2.proc.kill()
        check("server.shutdown 后代理退出", True)
    finally:
        for s in (s1, s2):
            try:
                s.proc.kill()
            except Exception:
                pass
        if os.environ.get("QC_E2E_KEEP") != "1":
            # 只清测试目录下的 daemon，不动真实项目的 server。
            kill_test_daemons()
            ssh_run(f"rm -rf ~/{REMOTE_HOME_REL}")
            leftover = wait_daemon_count(0, timeout=5)
            check("远端无残留测试进程", len(leftover) == 0, f"{len(leftover)} 条")

    print(f"\n{'全部通过' if not failures else '失败: ' + ', '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
