#!/usr/bin/env python3
"""Real SSH daemon acceptance using sshctl; no SSH credentials in this script.

The protocol client is reusable by platform-specific suites. The Linux runner
uses a dedicated binary, project and daemon state directory and never touches
the user's default daemon. Example:
  python stability.py --host HOST --binary PATH --duration 1860 --output DIR
"""

import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import struct
import subprocess
import sys
import threading
import time
import traceback

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


KIND = {"HELLO": 1, "REQ": 2, "RES": 3, "ERR": 4, "EVENT": 5,
        "STREAM_DATA": 6, "STREAM_END": 7, "WINDOW": 8, "CANCEL": 9,
        "PING": 10, "PONG": 11}


def mp(value):
    if value is None:
        return b"\xc0"
    if isinstance(value, bool):
        return b"\xc3" if value else b"\xc2"
    if isinstance(value, int):
        if 0 <= value < 128:
            return bytes([value])
        if -32 <= value < 0:
            return bytes([value & 255])
        if value >= 0:
            return b"\xcf" + struct.pack(">Q", value)
        return b"\xd3" + struct.pack(">q", value)
    if isinstance(value, str):
        data = value.encode("utf-8")
        if len(data) < 32:
            return bytes([0xa0 | len(data)]) + data
        return b"\xdb" + struct.pack(">I", len(data)) + data
    if isinstance(value, bytes):
        return b"\xc6" + struct.pack(">I", len(value)) + value
    if isinstance(value, dict):
        return (b"\xdf" + struct.pack(">I", len(value))
                + b"".join(mp(k) + mp(v) for k, v in value.items()))
    if isinstance(value, (list, tuple)):
        return b"\xdd" + struct.pack(">I", len(value)) + b"".join(map(mp, value))
    raise TypeError(type(value))


def mp_decode(data, pos=0):
    tag = data[pos]
    pos += 1
    if tag <= 127:
        return tag, pos
    if tag >= 224:
        return tag - 256, pos
    if tag in (192, 194, 195):
        return {192: None, 194: False, 195: True}[tag], pos
    scalar = {202: (">f", 4), 203: (">d", 8), 204: (">B", 1),
              205: (">H", 2), 206: (">I", 4), 207: (">Q", 8),
              208: (">b", 1), 209: (">h", 2), 210: (">i", 4), 211: (">q", 8)}
    if tag in scalar:
        fmt, size = scalar[tag]
        return struct.unpack(fmt, data[pos:pos + size])[0], pos + size
    if 160 <= tag <= 191:
        count, family = tag & 31, "str"
    elif 144 <= tag <= 159:
        count, family = tag & 15, "array"
    elif 128 <= tag <= 143:
        count, family = tag & 15, "map"
    else:
        lengths = {196: (1, "bin"), 197: (2, "bin"), 198: (4, "bin"),
                   217: (1, "str"), 218: (2, "str"), 219: (4, "str"),
                   220: (2, "array"), 221: (4, "array"),
                   222: (2, "map"), 223: (4, "map")}
        if tag not in lengths:
            raise ValueError("unsupported MessagePack tag %x" % tag)
        size, family = lengths[tag]
        count = int.from_bytes(data[pos:pos + size], "big")
        pos += size
    if family in ("str", "bin"):
        raw = data[pos:pos + count]
        return (raw.decode("utf-8") if family == "str" else raw), pos + count
    values = []
    for _ in range(count * (2 if family == "map" else 1)):
        value, pos = mp_decode(data, pos)
        values.append(value)
    return (dict(zip(values[::2], values[1::2])) if family == "map" else values), pos


def frame(kind, sid, payload=b""):
    return struct.pack(">IBI", len(payload) + 5, kind, sid) + payload


class RpcError(RuntimeError):
    def __init__(self, body):
        self.body = body
        super().__init__(str(body))


class Session:
    """Thread-safe multiplexed real SSH connection with bounded read deadlines.

    argv must launch a binary-clean SSH exec transport connected to
    qingcode-server connect --stdio. Background reader handles daemon PING,
    sends WINDOW credits and dispatches all responses by stream id.
    """
    def __init__(self, argv, token, client_id="qc-stability", timeout=30):
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.write_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.rid = 1
        self.streams = {}
        self.outputs = collections.defaultdict(bytearray)
        self.events = collections.deque(maxlen=20000)
        self.failure = None
        self.last_frame = time.monotonic()
        self.started = self.last_frame
        self.pings = 0
        self.pongs = 0
        self.seq = {}
        self.stderr = bytearray()
        self.hello_queue = queue.Queue()
        self.stderr_thread = threading.Thread(target=self._stderr, daemon=True)
        self.reader_thread = threading.Thread(target=self._read, daemon=True)
        self.stderr_thread.start()
        self.reader_thread.start()
        try:
            self.send(KIND["HELLO"], 0, mp({"clientId": client_id,
                      "protocolMin": 1, "protocolMax": 1, "token": token}))
            kind, self.hello = self.hello_queue.get(timeout=timeout)
            if kind != KIND["HELLO"]:
                raise RuntimeError("HELLO rejected: %r" % self.hello)
        except Exception:
            self.close()
            raise

    def _stderr(self):
        while True:
            chunk = self.proc.stderr.read(4096)
            if not chunk:
                break
            self.stderr.extend(chunk)

    def send(self, kind, sid=0, payload=b""):
        with self.write_lock:
            self.proc.stdin.write(frame(kind, sid, payload))
            self.proc.stdin.flush()

    def _exact(self, size):
        result = b""
        while len(result) < size:
            chunk = self.proc.stdout.read(size - len(result))
            if not chunk:
                raise EOFError("SSH proxy closed (%r)" % self.proc.poll())
            result += chunk
        return result

    def _read(self):
        try:
            while True:
                size = struct.unpack(">I", self._exact(4))[0]
                if not 5 <= size <= 1024 * 1024:
                    raise ValueError("invalid frame length: %d" % size)
                raw = self._exact(size)
                kind, sid = struct.unpack(">BI", raw[:5])
                body = mp_decode(raw[5:])[0] if len(raw) > 5 else None
                self.last_frame = time.monotonic()
                if kind == KIND["PING"]:
                    self.pings += 1
                    self.send(KIND["PONG"], sid)
                    continue
                if kind == KIND["PONG"]:
                    self.pongs += 1
                    continue
                if kind == KIND["HELLO"] or (sid == 0 and kind == KIND["ERR"]):
                    self.hello_queue.put((kind, body))
                    continue
                if kind == KIND["EVENT"]:
                    with self.state_lock:
                        self.events.append((time.monotonic(), sid, body))
                        if body.get("event") == "ptyData":
                            item = body["data"]
                            output = self.outputs[item["id"]]
                            output.extend(item["data"])
                            if len(output) > 4 * 1024 * 1024:
                                del output[:len(output) - 4 * 1024 * 1024]
                            self.seq[item["id"]] = item.get("seq", 0)
                if kind == KIND["STREAM_DATA"]:
                    self.send(KIND["WINDOW"], sid, mp({"credit": len(raw) - 5}))
                with self.state_lock:
                    target = self.streams.get(sid)
                if target is not None:
                    target.put((kind, body))
        except Exception as exc:
            self.failure = repr(exc)
            self.hello_queue.put((KIND["ERR"], self.failure))
            with self.state_lock:
                targets = list(self.streams.values())
            for target in targets:
                target.put((0, self.failure))

    def begin(self, method, params):
        with self.state_lock:
            sid = self.rid
            self.rid += 1
            target = self.streams[sid] = queue.Queue()
        self.send(KIND["REQ"], sid, mp({"id": sid, "method": method, "params": mp(params)}))
        return sid, target

    def response(self, target, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise TimeoutError("RPC response deadline exceeded")
            kind, body = target.get(timeout=remain)
            if kind == KIND["RES"]:
                return body.get("result", body)
            if kind == KIND["ERR"]:
                raise RpcError(body)
            if kind == 0:
                raise EOFError(body)

    def request(self, method, params=None, timeout=30):
        sid, target = self.begin(method, params or {})
        try:
            return self.response(target, timeout)
        finally:
            with self.state_lock:
                self.streams.pop(sid, None)

    def stream(self, method, params, timeout=30):
        sid, target = self.begin(method, params)
        deadline = time.monotonic() + timeout
        records = []
        try:
            response = None
            while True:
                remain = deadline - time.monotonic()
                if remain <= 0:
                    raise TimeoutError("RPC stream deadline exceeded")
                kind, body = target.get(timeout=remain)
                if kind == KIND["RES"]:
                    response = body.get("result", body)
                if kind == KIND["STREAM_DATA"]:
                    records.append(body)
                if kind == KIND["STREAM_END"]:
                    return response, records, body
                if kind == KIND["ERR"]:
                    raise RpcError(body)
                if kind == 0:
                    raise EOFError(body)
        finally:
            with self.state_lock:
                self.streams.pop(sid, None)

    def output(self, pty_id):
        with self.state_lock:
            return bytes(self.outputs[pty_id])

    def wait_output(self, pty_id, marker, timeout=15, after=0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            output = self.output(pty_id)
            if marker in output[after:]:
                return output
            if self.failure:
                raise EOFError(self.failure)
            time.sleep(.03)
        raise TimeoutError("no PTY output %r; tail=%r" % (marker, self.output(pty_id)[-800:]))

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=10)
        self.reader_thread.join(timeout=2)
        self.stderr_thread.join(timeout=2)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except OSError:
                pass


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * fraction))] * 1000, 3)


class LinuxSuite:
    def __init__(self, args):
        self.args = args
        self.output = Path(args.output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.base = args.remote_dir
        if not re.fullmatch(r"/tmp/qingcode-stability-[A-Za-z0-9_-]+", self.base):
            raise ValueError("remote directory must be dedicated /tmp/qingcode-stability-* path")
        self.project = self.base + "/project"
        self.binary = self.base + "/qingcode-server"
        self.state = self.base + "/run"
        self.cli = args.sshctl
        self.sessions = []
        self.checks = []
        self.failures = []
        self.timings = collections.defaultdict(list)
        self.mutex = threading.Lock()
        self.stop = threading.Event()
        self.ptys = []
        self.start = time.monotonic()
        self.started_at = time.time()
        self.run_id = "%d-%d" % (os.getpid(), time.time_ns())
        self.log_file = self.output / "progress.jsonl"

    def log(self, event, **data):
        row = {"time": time.time(), "runId": self.run_id,
               "elapsed": round(time.monotonic() - self.start, 3),
               "event": event, **data}
        with self.mutex:
            with self.log_file.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def remote(self, script, timeout=45):
        result = subprocess.run([self.cli, "--insecure", "exec", self.args.host,
                                 "--", "bash", "-lc", script], capture_output=True,
                                timeout=timeout)
        if result.returncode:
            raise RuntimeError("remote command failed: " + result.stderr.decode(errors="replace"))
        return result.stdout.decode("utf-8", errors="replace").strip()

    def check(self, name, ok, detail=None):
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        self.log("check", **self.checks[-1])
        if not ok:
            self.failures.append(name)

    def session(self):
        before = time.perf_counter()
        session = Session([self.cli, "--insecure", "exec", self.args.host, "--",
                           self.binary, "connect", "--stdio", "--state-dir", self.state], self.token)
        self.sessions.append(session)
        self.timings["ssh_hello"].append(time.perf_counter() - before)
        return session

    def setup(self):
        self.remote("test ! -e '" + self.base + "' && mkdir -p '" + self.project + "/src'")
        proc = subprocess.run([self.cli, "--insecure", "scp", self.args.binary,
                               self.args.host + ":" + self.binary], capture_output=True, timeout=120)
        if proc.returncode:
            raise RuntimeError(proc.stderr.decode(errors="replace"))
        sha = hashlib.sha256(Path(self.args.binary).read_bytes()).hexdigest()
        evidence = self.remote("chmod 755 '" + self.binary + "'; '" + self.binary
                               + "' self-check --expect-sha256 " + sha
                               + "; '" + self.binary + "' --version; uname -a; command -v top || true; command -v opencode || true")
        self.check("deployed sha256 self-check", "sha256 " + sha in evidence, evidence)
        self.remote("for d in $(seq 1 20); do mkdir -p '" + self.project
                    + "/src/dir-'$d; for f in $(seq 1 50); do printf 'stable needle 中文 %s %s\\n' $d $f > '"
                    + self.project + "/src/dir-'$d/file-$f.txt; done; done; "
                    + "printf 'hello 中文 needle\\n' > '" + self.project + "/中文.txt'; "
                    + "mkdir '" + self.base + "/outside'; printf 'external-secret\\n' > '" + self.base
                    + "/outside/sentinel.txt'; ln -s '" + self.base + "/outside' '" + self.project + "/escape'")
        self.remote("nohup setsid '" + self.binary + "' daemon --state-dir '" + self.state
                    + "' >'" + self.base + "/daemon-start.log' 2>&1 </dev/null &")
        for _ in range(30):
            try:
                self.token = self.remote("cat '" + self.state + "/token'")
                break
            except Exception:
                time.sleep(.2)
        first = self.session()
        self.pid = first.hello["pid"]
        self.check("HELLO version protocol and capability", first.hello.get("protocol") == 1
                   and "pty.persist" in first.hello.get("capabilities", []), first.hello)
        self.long_started = time.monotonic()
        # Start long-lived TUI, active shell and completely idle shell first.
        for name in ("active-shell", "idle-shell", "top-tui"):
            session = self.session()
            spec = {"cwd": self.project, "shell": "/bin/bash", "cols": 100, "rows": 30,
                    "env": {"HISTFILE": "/dev/null"}, "name": name}
            pty_id = session.request("pty.create", spec)["id"]
            self.ptys.append((session, pty_id, name))
            if name == "active-shell":
                session.request("pty.input", {"id": pty_id, "data": b"export QC_ALIVE=$$; printf '%s%s\\n' 'START-' 'ALIVE'\n"})
                session.wait_output(pty_id, b"START-ALIVE")
            elif name == "top-tui":
                # The shell emits an unambiguous completion marker after top
                # restores the terminal. Sending a shell command immediately
                # after q races with TUI exit: queued typeahead may be consumed
                # or flushed before the shell resumes.
                session.request("pty.input", {"id": pty_id, "data":
                                b"top -d 5; printf '%s%s\\n' 'TOP-EXIT-' 'READY'\n"})
                session.wait_output(pty_id, b"load average")
        self.log("soak_started", pid=self.pid, duration=self.args.duration,
                 ptys=[{"id": p, "name": n} for _, p, n in self.ptys], sha256=sha)

    def functional(self):
        main = self.sessions[0]
        listing = main.request("fs.scan", {"root": self.project, "path": ""})
        self.check("unicode directory scan", "中文.txt" in str(listing), str(listing)[:200])
        for path in ("../outside", "/etc", "escape"):
            try:
                main.request("fs.scan", {"root": self.project, "path": path})
                self.check("reject outside-root scan " + path, False)
            except RpcError as exc:
                self.check("reject outside-root scan " + path, True, exc.body)
        _, records, end = main.stream("search.content", {"root": self.project, "query": "中文", "maxMatches": 20})
        self.check("unicode streaming search and bound", bool(records) and end.get("ok"),
                   {"chunks": len(records), "end": end})
        _, records, end = main.stream("search.content", {"root": self.project, "query": "external-secret"})
        self.check("search does not follow escaped symlink", not records, {"chunks": len(records), "end": end})
        watch_id, watch_q = main.begin("watch.subscribe", {"root": self.project})
        main.response(watch_q)
        time.sleep(.7)
        self.remote("printf 'watch-value\\n' > '" + self.project + "/watch-probe.txt'")
        deadline = time.monotonic() + 12
        watch_ok = False
        while time.monotonic() < deadline:
            kind, event = watch_q.get(timeout=max(.01, deadline - time.monotonic()))
            if kind == KIND["EVENT"] and "watch-probe.txt" in str(event):
                watch_ok = True
                break
        self.check("watch reports real file change", watch_ok)
        main.send(KIND["CANCEL"], watch_id)
        self.watch_id, self.watch_queue = main.begin("watch.subscribe", {"root": self.project})
        main.response(self.watch_queue)
        session = self.session()
        pty_id = session.request("pty.create", {"cwd": self.project, "shell": "/bin/bash", "cols": 80, "rows": 24,
                                                "env": {"HISTFILE": "/dev/null"}})["id"]
        session.request("pty.input", {"id": pty_id, "seq": 0,
                        "data": b"printf 'once\\n' >> input-once.txt; printf '%s%s\\n' 'BEFORE-' 'DROP'\n"})
        session.wait_output(pty_id, b"BEFORE-DROP")
        session.close()
        time.sleep(.5)
        reconnect = self.session()
        self.check("daemon PID survives SSH disconnect", reconnect.hello["pid"] == self.pid)
        attach, records, _ = reconnect.stream("pty.attach", {"id": pty_id, "fromSeq": 0})
        history = b"".join(item.get("data", b"") for item in records)
        self.check("PTY history replay after reconnect", b"BEFORE-DROP" in history and not attach.get("exited"),
                   {"replayBytes": len(history), "attach": {k:v for k,v in attach.items() if k != "screen"}})
        # Re-send seq 0: daemon must acknowledge it without executing twice.
        reconnect.request("pty.input", {"id": pty_id, "seq": 0,
                          "data": b"printf 'once\\n' >> input-once.txt\n"})
        reconnect.request("pty.input", {"id": pty_id, "seq": 1,
                          "data": b"printf '%s%s\\n' 'AFTER-' 'DROP'\n"})
        reconnect.wait_output(pty_id, b"AFTER-DROP")
        count = self.remote("wc -l < '" + self.project + "/input-once.txt'")
        self.check("input sequence duplicate is idempotent", count == "1", count)
        reconnect.request("pty.resize", {"id": pty_id, "cols": 132, "rows": 43})
        reconnect.request("pty.input", {"id": pty_id, "seq": 2,
                          "data": b"stty size; printf '%s%s\\n' 'RESIZE-' 'DONE'\n"})
        output = reconnect.wait_output(pty_id, b"RESIZE-DONE")
        self.check("PTY resize applied remotely", b"43 132" in output)
        reconnect.request("pty.kill", {"id": pty_id})
        for i in range(8):
            session = self.session()
            pty_id = session.request("pty.create", {"cwd": self.project, "shell": "/bin/bash", "cols": 80, "rows": 24,
                                                    "env": {"HISTFILE": "/dev/null"}})["id"]
            self.ptys.append((session, pty_id, "parallel-%d" % i))
        self.check("multiple SSH connections and PTYs", len(self.ptys) >= 11,
                   {"connections": len(self.sessions), "ptys": len(self.ptys)})
        # Authentication rejection must not affect established sessions.
        try:
            Session([self.cli, "--insecure", "exec", self.args.host, "--", self.binary,
                     "connect", "--stdio", "--state-dir", self.state], "invalid-test-token")
            self.check("invalid token rejected", False)
        except RuntimeError as exc:
            self.check("invalid token rejected", True, str(exc))
        self.check("valid connection survives bad auth", bool(main.request("server.info")))

    def worker(self, index, session, pty_id):
        counter = 0
        while not self.stop.is_set():
            method = ("server.info", "fs.scan", "search.content", "pty.input")[counter % 4]
            before = time.perf_counter()
            try:
                if method == "fs.scan":
                    session.request(method, {"root": self.project, "path": "src/dir-1"})
                elif method == "search.content":
                    session.stream(method, {"root": self.project, "query": "needle", "maxMatches": 50})
                elif method == "pty.input":
                    marker = "W%d-%d-OK" % (index, counter)
                    offset = len(session.output(pty_id))
                    command = "printf '%s%s\\n' 'W%d-%d-' 'OK'\n" % ("%s", "%s", index, counter)
                    session.request(method, {"id": pty_id, "data": command.encode()})
                    session.wait_output(pty_id, marker.encode(), after=offset)
                else:
                    session.request(method)
                with self.mutex:
                    self.timings[method].append(time.perf_counter() - before)
            except Exception as exc:
                message = "worker %d %s: %r" % (index, method, exc)
                self.failures.append(message)
                self.log("worker_error", message=message)
                return
            counter += 1
            self.stop.wait(.35)

    def monitor(self):
        evidence = self.remote("cat /proc/%d/status | egrep 'VmRSS|VmHWM|Threads'; "
                               "printf 'FD '; ls /proc/%d/fd | wc -l; "
                               "ps -p %d -o pid,etime,pcpu,pmem,rss,nlwp --no-headers" % (self.pid, self.pid, self.pid))
        self.log("resource", detail=evidence,
                 connections=[{"pid": s.proc.pid, "alive": s.proc.poll() is None,
                               "lastFrameAge": round(time.monotonic() - s.last_frame, 3),
                               "pings": s.pings, "pongs": s.pongs,
                               "failure": s.failure} for s in self.sessions if s.proc.poll() is None],
                 completed={k: len(v) for k, v in self.timings.items()})

    @staticmethod
    def finish_terminal(session, pty_id, name):
        if name == "top-tui":
            session.request("pty.resize", {"id": pty_id, "cols": 120, "rows": 40})
            offset = len(session.output(pty_id))
            session.request("pty.input", {"id": pty_id, "data": b"q"})
            session.wait_output(pty_id, b"TOP-EXIT-READY", after=offset)
        marker = (name + "-FINAL-OK").encode()
        command = "printf '%s%s\\n' '" + name + "-FINAL-' 'OK'\n"
        offset = len(session.output(pty_id))
        session.request("pty.input", {"id": pty_id, "data": command.encode()})
        session.wait_output(pty_id, marker, after=offset)

    def run(self):
        try:
            self.setup()
            self.functional()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(self.worker, i, session, pty_id)
                           for i, (session, pty_id, _) in enumerate(self.ptys[3:])]
                while time.monotonic() - self.long_started < self.args.duration:
                    self.monitor()
                    self.stop.wait(min(30, max(0, self.args.duration - (time.monotonic() - self.long_started))))
                self.stop.set()
                for future in futures:
                    future.result(timeout=35)
            elapsed = time.monotonic() - self.long_started
            for session, pty_id, name in self.ptys[:3]:
                self.check(name + " SSH connection stayed open for requested duration", session.proc.poll() is None
                           and session.failure is None and elapsed >= self.args.duration,
                           {"elapsed": elapsed, "lastFrameAge": time.monotonic() - session.last_frame,
                            "daemonPings": session.pings})
                self.finish_terminal(session, pty_id, name)
                self.check(name + " interactive after soak", True)
            active, pty_id, _ = self.ptys[0]
            active.request("pty.input", {"id": pty_id, "data": b"test \"$QC_ALIVE\" = \"$$\" && printf '%s%s\\n' 'SAME-' 'PROCESS'\n"})
            active.wait_output(pty_id, b"SAME-PROCESS")
            self.check("same shell process after soak", True)
            for session, pty_id, _ in self.ptys:
                session.request("pty.kill", {"id": pty_id})
            remaining = self.sessions[0].request("pty.list")
            self.check("no live PTY after explicit cleanup", not remaining.get("ptys"), remaining)
            self.sessions[0].request("server.shutdown")
            for _ in range(30):
                state = self.remote("if [ -r /proc/%d/stat ]; then awk '{print $3}' /proc/%d/stat; else echo exited; fi" % (self.pid, self.pid))
                if state in ("exited", "Z"):
                    break
                time.sleep(.2)
            self.check("dedicated daemon exited after shutdown", state in ("exited", "Z"), state)
        except Exception as exc:
            self.failures.append(repr(exc))
            self.log("fatal", error=repr(exc), traceback=traceback.format_exc())
        finally:
            self.stop.set()
            for session in self.sessions:
                try:
                    session.close()
                except Exception:
                    pass
            summary = {"host": self.args.host, "remoteDir": self.base,
                       "runId": self.run_id, "startedAt": self.started_at,
                       "durationTarget": self.args.duration, "elapsed": time.monotonic() - self.start,
                       "soakElapsed": (time.monotonic() - self.long_started
                                       if hasattr(self, "long_started") else None),
                       "checks": self.checks, "failures": self.failures,
                       "metrics": {k: {"count": len(v), "p50_ms": percentile(v, .5),
                                       "p95_ms": percentile(v, .95), "max_ms": percentile(v, 1)}
                                   for k, v in self.timings.items()}}
            (self.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1 if self.failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--sshctl", default=str(Path.home() / ".codex/skills/sshctl/bin/sshctl.exe"))
    parser.add_argument("--duration", type=int, default=1860)
    parser.add_argument("--remote-dir", default="/tmp/qingcode-stability-" + time.strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.duration < 1:
        parser.error("--duration must be at least one second")
    return LinuxSuite(args).run()


if __name__ == "__main__":
    raise SystemExit(main())
