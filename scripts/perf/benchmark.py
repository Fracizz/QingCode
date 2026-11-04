#!/usr/bin/env python3
"""Sample a launched application's process tree; no third party dependencies."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time


def snapshot():
    """Return pid, ppid, identity, cumulative CPU seconds and RSS bytes."""
    if sys.platform == "win32":
        script = (
            "$ErrorActionPreference='Stop'; "
            "@(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { "
            "[PSCustomObject]@{pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; "
            "identity=[string]$_.CreationDate.ToFileTimeUtc(); "
            "cpu=([double]$_.UserModeTime+[double]$_.KernelModeTime)/1e7; "
            "rss=[long]$_.WorkingSetSize} }) | ConvertTo-Json -Compress"
        )
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                check=True, capture_output=True, text=True, timeout=15)
        rows = json.loads(result.stdout)
        return {row["pid"]: row for row in rows}
    if sys.platform.startswith("linux"):
        rows = {}
        ticks = os.sysconf("SC_CLK_TCK")
        page = os.sysconf("SC_PAGE_SIZE")
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                raw = (entry / "stat").read_text()
                fields = raw[raw.rfind(")") + 2:].split()
                # A zombie has no working set and has already exited.
                if fields[0] == "Z":
                    continue
                pid = int(entry.name)
                rows[pid] = {"pid": pid, "ppid": int(fields[1]), "identity": fields[19],
                             "cpu": (int(fields[11]) + int(fields[12])) / ticks,
                             "rss": max(0, int(fields[21])) * page}
            except (OSError, ValueError, IndexError):
                continue  # Processes can exit during enumeration.
        return rows
    raise RuntimeError("Process sampling currently supports Windows and Linux only")


class ProcessTree:
    def __init__(self, root_pid):
        self.root_pid = root_pid
        self.identities = {}
        self.cpu_totals = {}

    def sample(self, rows):
        live = {pid for pid, identity in self.identities.items()
                if pid in rows and rows[pid]["identity"] == identity}
        # Seed the root only once; a reused PID must not become our process.
        if not self.identities and self.root_pid in rows:
            live.add(self.root_pid)
        changed = True
        while changed:
            children = {pid for pid, row in rows.items() if row["ppid"] in live}
            changed = not children.issubset(live)
            live.update(children)
        for pid in live:
            row = rows[pid]
            identity = row["identity"]
            self.identities[pid] = identity
            self.cpu_totals[(pid, identity)] = row["cpu"]
        return {"pids": sorted(live), "rssBytes": sum(rows[pid]["rss"] for pid in live),
                "cpuSeconds": sum(self.cpu_totals.values())}


def windows_window(pid, close=False):
    action = "$p.CloseMainWindow()" if close else "($p.MainWindowHandle -ne 0)"
    script = f"$p=Get-Process -Id {pid} -ErrorAction Stop; {action}"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, text=True, timeout=15)
    return result.returncode == 0 and result.stdout.strip().lower() == "true"


def summary(samples):
    rss = [row["rssBytes"] for row in samples]
    return {"sampleCount": len(samples), "peakRssBytes": max(rss, default=0),
            "medianRssBytes": statistics.median(rss) if rss else None,
            "meanCpuPercentOneCore": max(0, (samples[-1]["cpuSeconds"] - samples[0]["cpuSeconds"])
                                       / ((samples[-1]["atMs"] - samples[0]["atMs"]) / 1000) * 100)
            if len(samples) > 1 and samples[-1]["atMs"] > samples[0]["atMs"] else None,
            "peakProcessCount": max((len(row["pids"]) for row in samples), default=0)}


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def run(args):
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ValueError("Pass an executable and its arguments after --")
    if args.ready_file and Path(args.ready_file).exists():
        raise ValueError("Ready file already exists; remove it before launching the benchmark")
    if args.ready_window and sys.platform != "win32":
        raise ValueError("--ready-window is available only on Windows")
    if args.stop == "window-close" and sys.platform != "win32":
        raise ValueError("--stop window-close is available only on Windows")
    binary = Path(command[0]).resolve()
    if not binary.is_file():
        raise ValueError("Use an explicit path to the executable")
    if not all(math.isfinite(value) for value in (args.duration, args.interval, args.exit_timeout, args.warmup)):
        raise ValueError("Durations must be finite")
    if args.duration <= 0 or args.interval <= 0 or args.exit_timeout <= 0 or args.warmup < 0:
        raise ValueError("Durations must be positive; warmup may be zero")
    if args.warmup >= args.duration:
        raise ValueError("Warmup must be shorter than duration")
    ready_boundary = "marker-file" if args.ready_file else "main-window-handle" if args.ready_window else "unmeasured"
    result = {"schemaVersion": 1, "startedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "metadata": {"scenario": args.scenario, "cache": args.cache, "cachePreparation": args.cache_preparation,
                           "version": args.version, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                           "platform": platform.system(), "release": platform.release(), "architecture": platform.machine(),
                           "machine": platform.node(), "logicalCpuCount": os.cpu_count(), "python": platform.python_version(),
                           "intervalSeconds": args.interval, "durationSeconds": args.duration, "warmupSeconds": args.warmup,
                           "readyBoundary": ready_boundary, "stop": args.stop, "notes": args.notes},
              "startupMs": None, "exitMs": None, "exitCode": None, "samples": [], "errors": []}
    output_path = Path(args.output).resolve()
    log_path = output_path.with_suffix(".process.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    result["processLog"] = str(log_path)
    # Output is redirected to a file so a busy terminal cannot block the target.
    with log_path.open("wb") as output:
        started = time.monotonic()
        process = subprocess.Popen([str(binary), *command[1:]], cwd=args.cwd, stdout=output, stderr=output)
        tree = ProcessTree(process.pid)
        result["rootPid"] = process.pid
        try:
            while time.monotonic() - started < args.duration:
                sample_start = time.monotonic()
                process.poll()  # Reap exited root before taking /proc snapshots.
                current = tree.sample(snapshot())
                current["atMs"] = (time.monotonic() - started) * 1000
                current["collectionMs"] = (time.monotonic() - sample_start) * 1000
                result["samples"].append(current)
                if result["startupMs"] is None:
                    ready = (args.ready_file and Path(args.ready_file).is_file()) or (args.ready_window and windows_window(process.pid))
                    if ready:
                        result["startupMs"] = (time.monotonic() - started) * 1000
                if not current["pids"] and process.poll() is not None:
                    break
                time.sleep(max(0, args.interval - (time.monotonic() - sample_start)))
            before_stop = time.monotonic()
            stop_sent = False
            if process.poll() is None:
                if args.stop == "window-close":
                    stop_sent = windows_window(process.pid, close=True)
                    if not stop_sent:
                        result["errors"].append("Root process has no closable main window")
                elif args.stop == "terminate":
                    process.terminate()
                    stop_sent = True
                else:
                    print("Sampling complete. Close the application to finish the run.", file=sys.stderr)
            while time.monotonic() - before_stop < args.exit_timeout:
                process.poll()
                alive = tree.sample(snapshot())["pids"]
                if process.poll() is not None and not alive:
                    if stop_sent:
                        result["exitMs"] = (time.monotonic() - before_stop) * 1000
                    break
                time.sleep(min(args.interval, 0.25))
            else:
                result["errors"].append("Process tree did not exit before timeout; benchmark left it running")
            result["exitCode"] = process.poll()
            if result["exitCode"] not in (None, 0) and not (stop_sent and args.stop == "terminate"):
                result["errors"].append(f"Target exited with code {result['exitCode']}")
            if args.ready_file or args.ready_window:
                if result["startupMs"] is None:
                    result["errors"].append("Readiness boundary was never observed")
            if len(result["samples"]) < 2:
                result["errors"].append("Fewer than two samples; target may have forwarded to an existing single instance")
            if result["samples"] and result["samples"][-1]["atMs"] < args.duration * 1000 - args.interval * 1500:
                result["errors"].append("Target exited before the requested scenario duration")
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyboardInterrupt) as error:
            result["errors"].append(str(error) or type(error).__name__)
        measured = [sample for sample in result["samples"] if sample["atMs"] >= args.warmup * 1000]
        if len(measured) < 2:
            result["errors"].append("Fewer than two samples remain after warmup")
        result["summary"] = summary(measured)
        result["summary"]["observedProcessCount"] = len(tree.cpu_totals)
        result["status"] = "failed" if result["errors"] else "passed"
        save(output_path, result)
        print(json.dumps({"status": result["status"], "output": str(output_path), "summary": result["summary"]}))
        return 1 if result["errors"] else 0


def compare(args):
    before, after = [json.loads(Path(path).read_text(encoding="utf-8")) for path in (args.before, args.after)]
    if before.get("schemaVersion") != 1 or after.get("schemaVersion") != 1:
        raise ValueError("Unsupported benchmark schemaVersion")
    keys = ("scenario", "cache", "cachePreparation", "platform", "release", "architecture", "machine", "logicalCpuCount",
            "intervalSeconds", "durationSeconds", "warmupSeconds", "readyBoundary", "stop")
    mismatches = [key for key in keys if before["metadata"].get(key) != after["metadata"].get(key)]
    if mismatches:
        raise ValueError("Incompatible runs: " + ", ".join(mismatches))
    if before.get("status") != "passed" or after.get("status") != "passed":
        raise ValueError("Only passed benchmark runs can be compared")
    metrics = {}
    for key in ("startupMs", "exitMs", "peakRssBytes", "medianRssBytes", "meanCpuPercentOneCore"):
        left = before.get(key) if key in before else before["summary"].get(key)
        right = after.get(key) if key in after else after["summary"].get(key)
        metrics[key] = {"before": left, "after": right,
                        "changePercent": (right - left) / left * 100 if left and right is not None else None}
    print(json.dumps({"beforeVersion": before["metadata"]["version"], "afterVersion": after["metadata"]["version"],
                      "metrics": metrics}, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    command = subparsers.add_parser("run")
    command.add_argument("--scenario", required=True)
    command.add_argument("--cache", choices=("cold", "warm", "uncontrolled"), required=True)
    command.add_argument("--cache-preparation", required=True, help="Actual cache preparation; the runner never clears caches")
    command.add_argument("--version", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--cwd", default=os.getcwd())
    command.add_argument("--duration", type=float, default=30)
    command.add_argument("--interval", type=float, default=0.5)
    command.add_argument("--warmup", type=float, default=5)
    ready = command.add_mutually_exclusive_group()
    ready.add_argument("--ready-file")
    ready.add_argument("--ready-window", action="store_true")
    command.add_argument("--stop", choices=("manual", "terminate", "window-close"), default="manual")
    command.add_argument("--exit-timeout", type=float, default=20)
    command.add_argument("--notes", default="")
    command.add_argument("command", nargs=argparse.REMAINDER)
    comparison = subparsers.add_parser("compare")
    comparison.add_argument("before")
    comparison.add_argument("after")
    args = parser.parse_args()
    try:
        return run(args) if args.action == "run" else compare(args)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"benchmark: {error}\n")


if __name__ == "__main__":
    sys.exit(main())
