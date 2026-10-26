#!/usr/bin/env python3
"""Windows daemon acceptance over sshctl, or explicitly labelled local IPC.

Credentials stay in sshctl. Every run uses its own daemon state and project.
Local IPC is supplemental coverage and is never remote SSH acceptance.
"""

import argparse
import base64
import collections
import concurrent.futures
import hashlib
import json
import re
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback

from stability import KIND, RpcError, Session, percentile


class WindowsSuite:
    def __init__(self, args):
        self.args = args
        self.output = Path(args.output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.start = time.monotonic()
        self.log_file = self.output / "progress.jsonl"
        self.sessions = []
        self.ptys = []
        self.checks = []
        self.failures = []
        self.infrastructure_warnings = []
        self.timings = collections.defaultdict(list)
        self.mutex = threading.Lock()
        self.stop = threading.Event()
        self.cli = args.sshctl
        self.base = args.remote_dir.replace("\\", "/")
        if "/qingcode-stability-" not in self.base or ".." in self.base:
            raise ValueError("use a dedicated absolute qingcode-stability-* directory")
        self.project = self.base + "/project"
        self.binary = self.base + "/qingcode-server.exe"
        self.state = self.base + "/run"
        self.transport = "local-named-pipe" if args.local else "SSH"

    def log(self, event, **data):
        row = {"time": time.time(), "elapsed": round(time.monotonic() - self.start, 3),
               "event": event, **data}
        with self.mutex:
            with self.log_file.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def check(self, name, ok, detail=None):
        row = {"name": name, "ok": bool(ok), "detail": detail}
        self.checks.append(row)
        self.log("check", **row)
        if not ok:
            self.failures.append(name)

    def remote(self, script, timeout=30):
        script = "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); " + script
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        command = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
        argv = command if self.args.local else [self.cli, "--insecure", "exec", self.args.host, "--"] + command
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError("command failed: " + result.stderr.decode("utf-8", "replace"))
        return result.stdout.decode("utf-8", "replace").strip()

    def argv(self):
        command = [self.binary, "connect", "--stdio", "--state-dir", self.state]
        return command if self.args.local else [self.cli, "--insecure", "exec", self.args.host, "--"] + command

    def session(self, token=None):
        before = time.perf_counter()
        session = Session(self.argv(), self.token if token is None else token, timeout=20)
        self.sessions.append(session)
        self.timings["hello"].append(time.perf_counter() - before)
        return session

    def create(self, name):
        session = self.session()
        pty_id = session.request("pty.create", {"cwd": self.project, "shell": "cmd.exe",
                    "args": ["/d", "/q"], "cols": 100, "rows": 30, "name": name})["id"]
        self.ptys.append((session, pty_id, name))
        return session, pty_id

    def opencode_processes(self):
        # pty.hasChildren deliberately returns false on Windows; inspect only
        # descendants of this run's dedicated daemon instead.
        data = self.remote("$all=@(Get-CimInstance Win32_Process); $ids=@(" + str(self.pid)
                    + "); for($i=0;$i -lt 12;$i++){ $new=@($all | Where-Object { "
                    + "$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId }); "
                    + "if(!$new.Count){break}; $ids+=@($new | ForEach-Object {$_.ProcessId}) }; "
                    + "ConvertTo-Json -Compress -InputObject @($all | Where-Object { "
                    + "$ids -contains $_.ProcessId -and $_.Name -like '*opencode*' } | "
                    + "Select-Object Name,ProcessId,ParentProcessId,ExecutablePath)")
        return json.loads(data)

    def marker(self, session, pty_id, label, seq=None):
        offset = len(session.output(pty_id))
        # Assemble a marker in CMD so echoed input is not a false positive.
        params = {"id": pty_id, "data": ("set QC_MARK=" + label + "\r\necho %QC_MARK%" + "-OK\r\n").encode()}
        if seq is not None:
            params["seq"] = seq
        session.request("pty.input", params)
        return session.wait_output(pty_id, (label + "-OK").encode(), after=offset)

    def setup(self):
        self.remote("$ErrorActionPreference='Stop'; if (Test-Path -LiteralPath '" + self.base
                    + "') { throw 'test directory already exists' }; New-Item -ItemType Directory -Path '"
                    + self.project + "/src' -Force | Out-Null")
        if self.args.local:
            Path(self.binary).write_bytes(Path(self.args.binary).read_bytes())
        else:
            # OpenSSH SFTP resolves relative destinations against the user's home.
            home = self.remote("$env:USERPROFILE").replace("\\", "/").rstrip("/")
            if not self.binary.lower().startswith(home.lower() + "/"):
                raise ValueError("remote test directory must be inside the SSH user's home")
            destination = self.binary[len(home) + 1:]
            result = subprocess.run([self.cli, "--insecure", "scp", self.args.binary,
                         self.args.host + ":" + destination], capture_output=True, timeout=90)
            if result.returncode:
                raise RuntimeError(result.stderr.decode(errors="replace"))
        sha = hashlib.sha256(Path(self.args.binary).read_bytes()).hexdigest()
        evidence = self.remote("& '" + self.binary + "' self-check --expect-sha256 '" + sha
                    + "'; & '" + self.binary + "' --version; [System.Environment]::OSVersion.VersionString; "
                    + "Get-Command opencode.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source; exit 0")
        self.opencode = "opencode.cmd" in evidence
        self.check("deployed sha256 self-check", "sha256 " + sha in evidence, evidence)
        self.remote("$ErrorActionPreference='Stop'; $utf8=New-Object System.Text.UTF8Encoding($false); "
                    + "for($d=1;$d -le 20;$d++){ $dir='" + self.project
                    + "/src/dir-'+$d; New-Item -ItemType Directory -Path $dir -Force | Out-Null; "
                    + "for($f=1;$f -le 50;$f++){[IO.File]::WriteAllText($dir+'/file-'+$f+'.txt', 'stable needle 中文 '+$d+' '+$f, $utf8)}}; "
                    + "[IO.File]::WriteAllText('" + self.project + "/中文.txt','hello 中文 needle',$utf8); "
                    + "New-Item -ItemType Directory -Path '" + self.base + "/outside' | Out-Null; "
                    + "[IO.File]::WriteAllText('" + self.base + "/outside/sentinel.txt','external-secret',$utf8); "
                    + "New-Item -ItemType Junction -Path '" + self.project + "/escape' -Target '"
                    + self.base + "/outside' | Out-Null")
        self.remote("& '" + self.binary + "' daemon --detach --state-dir '" + self.state + "'")
        for _ in range(25):
            try:
                self.token = self.remote("[IO.File]::ReadAllText('" + self.state + "/token')")
                break
            except RuntimeError:
                time.sleep(.2)
        main = self.session()
        self.pid = main.hello["pid"]
        self.check("HELLO protocol and persistence capability", main.hello.get("protocol") == 1
                   and "pty.persist" in main.hello.get("capabilities", []), main.hello)
        self.diagnostic_pty = main.request("pty.create", {"cwd": self.project,
                    "shell": "cmd.exe", "cols": 250, "rows": 20,
                    "name": "resource-probe"})["id"]
        # Start the long connections before the remaining functional tests.
        for name in ("active-shell", "idle-shell", "opencode-tui" if self.opencode else "second-idle-shell"):
            session, pty_id = self.create(name)
            if name == "active-shell":
                session.request("pty.input", {"id": pty_id, "data": b"set QC_ALIVE=preserved-state\r\n"})
                self.marker(session, pty_id, "START-ALIVE")
            elif name == "opencode-tui":
                session.request("pty.input", {"id": pty_id, "data": b"opencode.cmd\r\n"})
                time.sleep(4)
                self.opencode_initial = self.opencode_processes()
                self.check("opencode produced terminal output", bool(self.opencode_initial)
                           and len(session.output(pty_id)) > 150,
                           {"processes": self.opencode_initial,
                            "outputTail": session.output(pty_id)[-400:].decode("utf-8", "replace")})
        self.long_started = time.monotonic()
        self.log("soak_started", transport=self.transport, duration=self.args.duration, pid=self.pid,
                 sha256=sha, ptys=[{"id": p, "name": n} for _, p, n in self.ptys])

    def functional(self):
        main = self.sessions[0]
        listing = main.request("fs.scan", {"root": self.project, "path": ""})
        self.check("unicode scan", "中文.txt" in str(listing), str(listing)[:200])
        posix_root = "/" + self.project
        listing2 = main.request("fs.scan", {"root": posix_root, "path": ""})
        self.check("POSIX style Windows root accepted", bool(listing2))
        for path in ("../outside", "C:/Windows", "escape"):
            try:
                main.request("fs.scan", {"root": self.project, "path": path})
                self.check("reject outside-root scan " + path, False)
            except RpcError as exc:
                self.check("reject outside-root scan " + path, True, exc.body)
        _, records, end = main.stream("search.content", {"root": self.project, "query": "中文", "maxMatches": 20})
        self.check("unicode streaming search", bool(records) and end.get("ok"), {"chunks": len(records), "end": end})
        _, records, end = main.stream("search.content", {"root": self.project, "query": "external-secret"})
        self.check("search respects root boundary", not records and end.get("ok"))
        watch_id, target = main.begin("watch.subscribe", {"root": self.project})
        main.response(target)
        time.sleep(.7)
        before = time.monotonic()
        self.remote("[IO.File]::WriteAllText('" + self.project + "/watch-probe.txt','watch-value')")
        deadline = time.monotonic() + 12
        while True:
            kind, event = target.get(timeout=max(.01, deadline - time.monotonic()))
            if kind == KIND["EVENT"] and "watch-probe.txt" in str(event):
                break
        self.check("watch reports file change", True, {"wallLatencyMs": round((time.monotonic()-before)*1000, 2)})
        main.send(KIND["CANCEL"], watch_id)
        dropped, pty_id = self.create("disconnect-probe")
        dropped.request("pty.input", {"id": pty_id, "seq": 0,
                        "data": b"echo once>>input-once.txt\r\nset QC_MARK=BEFORE-DROP\r\necho %QC_MARK%-OK\r\n"})
        dropped.wait_output(pty_id, b"BEFORE-DROP-OK")
        dropped.close()
        reconnect = self.session()
        self.check("daemon survives proxy termination", reconnect.hello["pid"] == self.pid)
        attach, records, end = reconnect.stream("pty.attach", {"id": pty_id, "fromSeq": 0})
        history = b"".join(row.get("data", b"") for row in records)
        self.check("PTY persists and replays after proxy termination", b"BEFORE-DROP-OK" in history
                   and end.get("ok") and not attach.get("exited"), {"bytes": len(history)})
        reconnect.request("pty.input", {"id": pty_id, "seq": 0, "data": b"echo once>>input-once.txt\r\n"})
        self.marker(reconnect, pty_id, "AFTER-DROP", seq=1)
        count = self.remote("(Get-Content -LiteralPath '" + self.project + "/input-once.txt' | Measure-Object -Line).Lines")
        self.check("input sequence idempotence", count == "1", count)
        reconnect.request("pty.resize", {"id": pty_id, "cols": 132, "rows": 43})
        self.marker(reconnect, pty_id, "RESIZE", seq=2)
        self.check("ConPTY resize remains interactive", True)
        reconnect.request("pty.kill", {"id": pty_id})
        self.ptys = [row for row in self.ptys if row[1] != pty_id]
        self.workers = []
        for index in range(self.args.connections):
            session, pty_id = self.create("parallel-%d" % index)
            self.workers.append((session, pty_id))
        self.check("multiple clients and PTYs opened", len(self.workers) == self.args.connections,
                   {"connections": len(self.sessions), "longAndWorkerPtys": len(self.ptys),
                    "diagnosticPtys": 1})
        try:
            bad = self.session(token="invalid-test-token")
            bad.close()
            self.check("bad token rejected", False)
        except (RuntimeError, EOFError) as exc:
            self.check("bad token rejected", True, str(exc))
        self.check("valid client survives bad token", bool(main.request("server.info")))

    def worker(self, index, session, pty_id):
        count = 0
        while not self.stop.is_set():
            method = ("server.info", "fs.scan", "search.content", "pty.input")[count % 4]
            before = time.perf_counter()
            try:
                if method == "fs.scan":
                    session.request(method, {"root": self.project, "path": "src/dir-1"})
                elif method == "search.content":
                    session.stream(method, {"root": self.project, "query": "needle", "maxMatches": 50})
                elif method == "pty.input":
                    self.marker(session, pty_id, "W%d-%d" % (index, count))
                else:
                    session.request(method)
                with self.mutex:
                    self.timings[method].append(time.perf_counter()-before)
            except Exception as exc:
                message = "worker %d %s: %r" % (index, method, exc)
                self.failures.append(message)
                self.log("worker_error", message=message)
                return
            count += 1
            self.stop.wait(.35)

    def monitor(self):
        # Keep monitoring on the already authenticated SSH transport: a new
        # handshake failure must not terminate healthy long-lived PTYs.
        main = self.sessions[0]
        info = None
        diagnostic_error = None
        try:
            script = "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); "
            script += "$j=Get-Process -Id " + str(self.pid)
            script += " | Select-Object Id,WorkingSet64,PrivateMemorySize64,HandleCount,CPU,@{n='Threads';e={$_.Threads.Count}} | ConvertTo-Json -Compress; [Console]::WriteLine('QC_RESOURCE:'+$j)"
            encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
            offset = len(main.output(self.diagnostic_pty))
            main.request("pty.input", {"id": self.diagnostic_pty,
                         "data": ("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "
                                  + encoded + "\r\n").encode()})
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                data = main.output(self.diagnostic_pty)[offset:].decode("utf-8", "replace")
                data = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", data).replace("\r", "").replace("\n", "")
                match = re.search(r"QC_RESOURCE:(\{.*?\})", data)
                if match:
                    info = json.loads(match.group(1))
                    break
                if main.failure:
                    raise EOFError(main.failure)
                time.sleep(.03)
            if info is None:
                raise TimeoutError("resource PTY did not print JSON within 12 seconds")
        except Exception as exc:
            diagnostic_error = repr(exc)
            self.infrastructure_warnings.append("resource probe: " + diagnostic_error)
        self.log("resource", detail=info, completed={k: len(v) for k,v in self.timings.items()},
                 diagnosticError=diagnostic_error,
                 sessions=[{"alive": s.proc.poll() is None, "pings": s.pings,
                            "lastFrameAge": round(time.monotonic()-s.last_frame, 2), "failure": s.failure}
                           for s in self.sessions if s.proc.poll() is None])

    def cleanup(self):
        live = None
        for session in self.sessions:
            if session.proc.poll() is None and session.failure is None:
                live = session
                break
        if live:
            for row in live.request("pty.list").get("ptys", []):
                live.request("pty.kill", {"id": row["id"]})
            remaining = live.request("pty.list")
            self.check("no live PTY after explicit cleanup", not remaining.get("ptys"), remaining)
            live.request("server.shutdown")
            time.sleep(.7)
            try:
                state = self.remote("if (Get-Process -Id " + str(self.pid) + " -ErrorAction SilentlyContinue) {'alive'} else {'exited'}")
                self.check("dedicated daemon exited after shutdown", state == "exited", state)
            except subprocess.TimeoutExpired as exc:
                warning = "post-shutdown process verification unavailable: " + repr(exc)
                self.infrastructure_warnings.append(warning)
                self.log("process_verification_unavailable", detail=warning)

    def run(self):
        try:
            self.setup()
            self.functional()
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.args.connections) as pool:
                futures = [pool.submit(self.worker, i, session, pty_id) for i,(session,pty_id) in enumerate(self.workers)]
                try:
                    while time.monotonic()-self.long_started < self.args.duration:
                        self.monitor()
                        self.stop.wait(min(30, max(0, self.args.duration-(time.monotonic()-self.long_started))))
                finally:
                    # ThreadPoolExecutor waits on exit; signal workers first.
                    self.stop.set()
                for future in futures:
                    future.result(timeout=35)
            elapsed = time.monotonic()-self.long_started
            for session,pty_id,name in self.ptys[:3]:
                self.check(name+" connection stayed open for target duration", session.proc.poll() is None
                           and session.failure is None and elapsed >= self.args.duration,
                           {"elapsed": elapsed, "daemonPings": session.pings, "transport": self.transport})
                if name == "opencode-tui":
                    offset = len(session.output(pty_id))
                    session.request("pty.resize", {"id": pty_id,"cols": 120,"rows": 40})
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline and len(session.output(pty_id)) <= offset:
                        time.sleep(.03)
                    processes = self.opencode_processes()
                    initial_ids = {p["ProcessId"] for p in self.opencode_initial}
                    current_ids = {p["ProcessId"] for p in processes}
                    self.check(name+" repaints after soak resize", bool(initial_ids & current_ids)
                               and len(session.output(pty_id)) > offset,
                               {"newOutputBytes": len(session.output(pty_id))-offset,
                                "processes": processes, "sameProcess": bool(initial_ids & current_ids)})
                    continue
                self.marker(session,pty_id,name+"-FINAL")
                self.check(name+" interactive after soak", True)
            active,pty_id,_ = self.ptys[0]
            active.request("pty.input", {"id":pty_id,"data": b"echo %QC_ALIVE%\r\n"})
            active.wait_output(pty_id,b"preserved-state")
            self.check("same shell environment after soak", True)
        except Exception as exc:
            self.failures.append(repr(exc))
            self.log("fatal",error=repr(exc),traceback=traceback.format_exc())
        finally:
            self.stop.set()
            try:
                self.cleanup()
            except Exception as exc:
                self.failures.append("cleanup: "+repr(exc))
                self.log("cleanup_error",error=repr(exc))
            for session in self.sessions:
                try:
                    session.close()
                except Exception:
                    pass
            summary = {"host": "local-Windows" if self.args.local else self.args.host,
                       "transport":self.transport,"remoteDir":self.base,"durationTarget":self.args.duration,
                       "elapsed":time.monotonic()-self.start,"checks":self.checks,"failures":self.failures,
                       "infrastructureWarnings": self.infrastructure_warnings,
                       "metrics":{k:{"count":len(v),"p50_ms":percentile(v,.5),"p95_ms":percentile(v,.95),
                                     "max_ms":percentile(v,1)} for k,v in self.timings.items()}}
            (self.output/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
        return 1 if self.failures else 0


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host")
    parser.add_argument("--local",action="store_true")
    parser.add_argument("--binary",required=True)
    parser.add_argument("--sshctl",default=str(Path.home()/".codex/skills/sshctl/bin/sshctl.exe"))
    parser.add_argument("--remote-dir",required=True)
    parser.add_argument("--duration",type=int,default=1860)
    parser.add_argument("--connections",type=int,default=8)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    if not args.local and not args.host:
        parser.error("--host is required without --local")
    if args.duration < 1:
        parser.error("--duration must be at least one second")
    if not 1 <= args.connections <= 60:
        parser.error("--connections must be between 1 and 60 (plus three long PTYs and one diagnostic PTY)")
    return WindowsSuite(args).run()


if __name__=="__main__":
    raise SystemExit(main())
