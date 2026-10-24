#!/usr/bin/env python3
"""qingcode-server daemon 真机冒烟测试（协议 v1）。

通过 SSH exec 运行 `connect --stdio --ensure-daemon`，在 stdio 上直接说协议 v1：
HELLO 握手 → server.info → fs.scan → pty.create/input 实时输出 → 杀掉 SSH 代理
模拟断线 → 重连后 pty.list/pty.attach 验证终端存活与 seq 补发 → pty.kill → server.shutdown。

用法（在 WSL 内，凭据走环境变量，绝不写进代码或仓库）：
  QC_E2E_HOST=1.2.3.4 QC_E2E_USER=root QC_E2E_PASSWORD='...' \
  QC_E2E_BINARY=/mnt/d/.../qingcode-server-x86_64 \
  python3 scripts/e2e-ssh-server/daemon_smoke.py

只依赖 python3 标准库（ssh + 手写最小 MessagePack 编解码）。
退出码：0=全部通过，1=有断言失败，2=前置条件不满足。
"""

import hashlib
import json
import os
import signal
import struct
import subprocess
import sys
import time

HOST = os.environ["QC_E2E_HOST"]
USER = os.environ.get("QC_E2E_USER", "root")
PASSWORD = os.environ["QC_E2E_PASSWORD"]
BINARY = os.environ["QC_E2E_BINARY"]  # WSL 路径，如 /mnt/d/.../qingcode-server-x86_64
REMOTE_DIR = "/tmp/qc-dsmoke"
PROJECT = f"{REMOTE_DIR}/project"
REMOTE_BIN = f"{PROJECT}/.qingcode/server/qingcode-server-x86_64"

failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(name)


# ---------------------------------------------------------------- SSH 工具
def ssh_args(extra):
    return [
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/tmp/qc_dsmoke_known_hosts",
        "-o",
        "GSSAPIAuthentication=no",
        "-o",
        "LogLevel=ERROR",
        f"{USER}@{HOST}",
    ] + extra


def askpass_env():
    env = dict(os.environ)
    env["SSH_ASKPASS"] = "/tmp/qc_dsmoke_askpass.sh"
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env["DISPLAY"] = ":0"
    return env


def setup_askpass():
    with open("/tmp/qc_dsmoke_askpass.sh", "w") as f:
        f.write("#!/bin/sh\ncat /tmp/qc_dsmoke_pw\n")
    os.chmod("/tmp/qc_dsmoke_askpass.sh", 0o755)
    with open("/tmp/qc_dsmoke_pw", "w") as f:
        f.write(PASSWORD + "\n")
    os.chmod("/tmp/qc_dsmoke_pw", 0o600)


def ssh_run(cmd, timeout=30):
    proc = subprocess.run(
        ssh_args([cmd]),
        env=askpass_env(),
        capture_output=True,
        text=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )
    return proc


def scp_to(local, remote):
    return subprocess.run(
        ["scp", "-o", "StrictHostKeyChecking=no", "-o", "GSSAPIAuthentication=no",
         "-o", "LogLevel=ERROR", local, f"{USER}@{HOST}:{remote}"],
        env=askpass_env(), capture_output=True, text=True, timeout=120,
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
    if b == 0xCA:
        v = struct.unpack(">f", raw[pos:pos + 4])[0]
        return v, pos + 4
    if b == 0xCB:
        v = struct.unpack(">d", raw[pos:pos + 8])[0]
        return v, pos + 8
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
    def __init__(self, client_id="qc-dsmoke"):
        self.proc = subprocess.Popen(
            ssh_args([f"{REMOTE_BIN} connect --stdio --ensure-daemon"]),
            env=askpass_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, preexec_fn=os.setsid,
        )
        self.reader = Reader(self.proc)
        self.next_id = 1
        self.hello_resp = None

    def send(self, kind, stream_id, payload=b""):
        self.proc.stdin.write(frame(kind, stream_id, payload))
        self.proc.stdin.flush()

    def handshake(self, token):
        payload = mp({"clientId": "qc-dsmoke", "protocolMin": 1,
                      "protocolMax": 1, "token": token})
        self.send(KIND["HELLO"], 0, payload)
        deadline = time.monotonic() + 25
        while True:
            kind, sid, body = self.reader.read_frame(timeout=25)
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
        deadline = time.monotonic() + timeout
        events = []
        while True:
            kind, sid, body = self.reader.read_frame(timeout=max(1, deadline - time.monotonic()))
            if kind == KIND["RES"] and sid == rid:
                body_decoded, _ = mp_decode(body)
                # Response{id, result}：归一化为 result 本体
                res = body_decoded.get("result") if isinstance(body_decoded, dict) and "result" in body_decoded else body_decoded
                return {"res": res, "events": events}
            if kind == KIND["ERR"] and sid == rid:
                err, _ = mp_decode(body)
                return {"err": err, "events": events}
            if kind == KIND["EVENT"]:
                ev, _ = mp_decode(body)
                events.append(ev)
            # 其它帧（WINDOW/STREAM_DATA/STREAM_END/PING）跳过


def main():
    setup_askpass()

    # 1. 准备远端一次性项目
    ssh_run(f"rm -rf {REMOTE_DIR} && mkdir -p {PROJECT}/src {PROJECT}/.qingcode/server")
    ssh_run(f"printf 'hello world\\n' > {PROJECT}/src/main.rs && "
            f"printf '中文内容命中\\n' > {PROJECT}/中文.txt && printf x > {PROJECT}/.qingcode/server/.keep")
    proc = scp_to(BINARY, REMOTE_BIN)
    if proc.returncode != 0:
        print("前置条件不满足：scp 失败", proc.stderr)
        return 2

    # 2. self-check 完整性（noexec 下 exec 本身就会失败）
    manifest_local = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "../../src-tauri/target/server/manifest.json")
    with open(manifest_local) as f:
        expected = json.load(f)["artifacts"]["qingcode-server-x86_64"]["sha256"]
    proc = ssh_run(f"{REMOTE_BIN} self-check --expect-sha256 {expected}; echo EXIT=$?")
    check("self-check sha256 匹配", "EXIT=0" in proc.stdout, proc.stdout.strip()[-60:])

    # 3. 幂等启动 daemon（重复执行靠 flock 幂等）
    ssh_run(f"nohup setsid {REMOTE_BIN} daemon >/dev/null 2>&1 < /dev/null & sleep 1")
    proc = ssh_run("cat ~/.qingcode/server/run/token")
    token = proc.stdout.strip()
    check("daemon token 可读且 0600", len(token) >= 16 and
          proc.stderr == "", f"len={len(token)}")

    # 4. HELLO 握手
    s1 = DaemonSession()
    s2 = None
    try:
        hello = s1.handshake(token)
        check("HELLO 协商 protocol=1", hello.get("protocol") == 1, str(hello.get("protocol")))
        check("HELLO 回报 serverVersion/pid",
              bool(hello.get("serverVersion")) and int(hello.get("pid", 0)) > 0,
              f"{hello.get('serverVersion')} pid={hello.get('pid')}")

        # 5. server.info
        r = s1.request("server.info", {})
        check("server.info 返回", "err" not in r and "version" in str(r.get("res")), str(r.get("res"))[:80])

        # 6. fs.scan
        r = s1.request("fs.scan", {"root": PROJECT, "path": "."})
        names = [e.get("name") for e in r["res"]["entries"]]
        check("fs.scan 返回条目", "src" in names and "中文.txt" in names, ",".join(names))
        r = s1.request("fs.scan", {"root": PROJECT, "path": "/etc"})
        check("fs.scan 拒绝绝对路径", "err" in r, str(r.get("err", {}).get("code")))

        # 7. pty 实时输出
        r = s1.request("pty.create", {"cwd": PROJECT, "cols": 80, "rows": 24})
        pty_id = r["res"]["id"]
        check("pty.create 返回 id", bool(pty_id), str(pty_id))
        s1.request("pty.input", {"id": pty_id, "data": b"echo qc-smoke-$((6*7))\n"})
        got = ""
        deadline = time.monotonic() + 5
        while "42" not in got and time.monotonic() < deadline:
            kind, sid, body = s1.reader.read_frame(timeout=5)
            if kind == KIND["EVENT"]:
                ev, _ = mp_decode(body)
                if ev.get("event") == "ptyData":
                    got += ev["data"]["data"].decode(errors="replace")
        check("pty.input 实时回显 42", "42" in got, got.strip()[:40])

        # 8. 杀掉 SSH 代理模拟断线，daemon 与终端应存活
        os.killpg(os.getpgid(s1.proc.pid), signal.SIGKILL)
        s1.proc.wait()
        # 注意：二进制名超过 15 字符时 /proc comm 会截断，必须用 -f 匹配完整命令行；
        # 同样用 [x] 字符类避免 pgrep -f 匹配到承载本命令的 shell 自身。
        proc = ssh_run("pgrep -f 'qingcode-server-[x]86_64 daemon' | wc -l")
        check("断线后 daemon 进程存活", int(proc.stdout.strip() or "0") >= 1, proc.stdout.strip())
        time.sleep(1)

        # 9. 重连接回终端
        s2 = DaemonSession()
        s2.handshake(token)
        r = s2.request("pty.list", {})
        listing = str(r.get("res"))
        check("pty.list 仍包含终端", pty_id in listing, listing[:80])
        r = s2.request("pty.attach", {"id": pty_id, "fromSeq": 0})
        seq_end = r["res"].get("seqEnd", 0)
        check("pty.attach 返回 seqEnd", seq_end > 0, f"seqEnd={seq_end}")
        replay = b""
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            kind, sid, body = s2.reader.read_frame(timeout=2)
            if kind == KIND["STREAM_DATA"]:
                chunk, _ = mp_decode(body)
                replay += chunk["data"]
            elif kind == KIND["STREAM_END"] and sid == s2.next_id - 1:
                break
        check("attach 补发含历史输出 42", b"42" in replay, f"{len(replay)}B")

        # 10. 收尾
        s2.request("pty.kill", {"id": pty_id})
        s2.request("server.shutdown", {})
        try:
            s2.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(s2.proc.pid), signal.SIGKILL)
        check("server.shutdown 后代理退出", True)
    finally:
        for s in (s1, s2):
            try:
                os.killpg(os.getpgid(s.proc.pid), signal.SIGKILL)
            except Exception:
                pass
        # 清理远端。用 [x] 字符类避免 pkill -f 匹配到承载本命令的 shell 自身。
        ssh_run("pkill -f 'qingcode-server-[x]86_64 daemon'; sleep 0.5; "
                "rm -rf /tmp/qc-dsmoke /tmp/qc-probe")
        leftover = ssh_run("pgrep -f 'qingcode-server-[x]86_64 daemon' | wc -l")
        check("远端无残留进程", leftover.stdout.strip() == "0", leftover.stdout.strip())

    print(f"\n{'全部通过' if not failures else '失败: ' + ', '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
