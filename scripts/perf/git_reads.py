#!/usr/bin/env python3
"""Read-only Git CLI latency baseline; writes only explicitly requested fixtures/results."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import shutil
import statistics
import subprocess
import time


STATUS = ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]
LOCAL_REFS = ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)", "refs/heads"]
REMOTE_REFS = ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]
LOG = ["log", "-n40", "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%D"]


def invoke(git, root, args, data=None):
    process = subprocess.run([git, "-C", str(root), *args], input=data, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=60, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"})
    if process.returncode:
        raise RuntimeError(f"git {args[0]} failed: {process.stderr.decode(errors='replace')[:500]}")
    return process.stdout


def fixture(git, parent, count):
    root = parent / f"fixture-{count}"
    # Never reset or mutate an existing directory, even if it looks like a fixture.
    root.mkdir(parents=True, exist_ok=False)
    invoke(git, root, ["init", "--initial-branch=main"])
    invoke(git, root, ["config", "core.autocrlf", "false"])
    invoke(git, root, ["config", "core.fsmonitor", "false"])
    stream = bytearray()

    def blob(mark, content):
        stream.extend(f"blob\nmark :{mark}\ndata {len(content)}\n".encode() + content + b"\n")

    blob(1, b"fixture content\n" * 16)
    blob(2, b".cache/\n")
    for index in range(200):
        stamp = 1700000000 + index
        stream.extend(f"commit refs/heads/main\ncommitter Benchmark <benchmark@example.invalid> {stamp} +0000\ndata 12\nfixture {index:03d}\n".encode())
        if index == 0:
            stream.extend(b"M 100644 :2 .gitignore\n")
            for number in range(count):
                stream.extend(f"M 100644 :1 src/d{number // 100:04d}/f{number:06d}.txt\n".encode())
        else:
            content = f"history {index:03d}\n".encode()
            stream.extend(f"M 100644 inline history.txt\ndata {len(content)}\n".encode() + content + b"\n")
        stream.extend(b"\n")
    invoke(git, root, ["fast-import", "--quiet"], bytes(stream))
    invoke(git, root, ["reset", "--hard", "HEAD"])
    oid = invoke(git, root, ["rev-parse", "HEAD"]).decode().strip()
    updates = "".join(f"update refs/heads/feature-{n:02d} {oid}\nupdate refs/remotes/origin/feature-{n:02d} {oid}\n" for n in range(24))
    updates += f"update refs/remotes/origin/main {oid}\n"
    invoke(git, root, ["update-ref", "--stdin"], updates.encode())
    invoke(git, root, ["config", "branch.main.remote", "origin"])
    invoke(git, root, ["config", "branch.main.merge", "refs/heads/main"])
    invoke(git, root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"])
    # Dirty worktree and untracked paths; no staged changes in this fixture.
    for n in range(100):
        (root / f"src/d{n // 100:04d}/f{n:06d}.txt").write_bytes(b"modified\n")
    (root / "untracked").mkdir()
    for n in range(100):
        (root / "untracked" / f"u{n:04d}.txt").write_bytes(b"untracked\n")
    return root


def distribution(values):
    ordered = sorted(values)
    return {"samplesMs": values, "medianMs": statistics.median(values),
            "p95Ms": ordered[max(0, (95 * len(values) + 99) // 100 - 1)],
            "minMs": min(values), "maxMs": max(values)}


def measure_repo(git, root, samples, warmup):
    head = invoke(git, root, ["rev-parse", "HEAD"]).decode().strip()
    tracked = invoke(git, root, ["ls-files", "-z"]).count(b"\0")
    commits = int(invoke(git, root, ["rev-list", "--count", "HEAD"]))
    status_before = invoke(git, root, STATUS)
    branches = invoke(git, root, ["for-each-ref", "--format=%(HEAD)%09%(upstream:short)", "refs/heads"]).decode().splitlines()
    upstream = next((line.split("\t", 1)[1].strip() for line in branches if line.startswith("*\t")), "")
    # Legacy sequences before the combined-refs/sync-metadata-cache optimization.
    # Keep these stable as a CLI baseline; git_reads_compare.py tests current Rust.
    full = [STATUS, ["rev-parse", "--git-path", "FETCH_HEAD"], ["reflog", "show", "--date=unix", "-n", "100"]]
    if upstream and not upstream.startswith('-'):
        full.append(["reflog", "show", "--date=unix", "-n", "100", f"refs/remotes/{upstream}"])
    operations = {
        "git_version_spawn": [["--version"]],
        "status_core": [STATUS],
        "status_full_desktop": full,
        "branches_desktop": [LOCAL_REFS, REMOTE_REFS],
        "log_40": [LOG],
        "scm_refresh_no_cache": full + [LOCAL_REFS, REMOTE_REFS, LOG],
        "refs_combined_diagnostic": [["for-each-ref", "--format=%(refname)%09%(HEAD)%09%(upstream:short)", "refs/heads", "refs/remotes"]],
    }
    collected = {name: [] for name in operations}
    first = {}
    output_bytes = {}
    keys = list(operations)
    randomizer = random.Random(20261030)
    for repeat in range(warmup + samples):
        randomizer.shuffle(keys)
        for name in keys:
            started = time.perf_counter_ns()
            outputs = [invoke(git, root, command) for command in operations[name]]
            elapsed = (time.perf_counter_ns() - started) / 1e6
            first.setdefault(name, elapsed)
            output_bytes[name] = sum(map(len, outputs))
            if repeat >= warmup:
                collected[name].append(elapsed)
    status_after = invoke(git, root, STATUS)
    return {"path": str(root), "head": head, "trackedFiles": tracked, "commits": commits,
            "statusSha256Before": hashlib.sha256(status_before).hexdigest(),
            "statusSha256After": hashlib.sha256(status_after).hexdigest(),
            "headUnchanged": head == invoke(git, root, ["rev-parse", "HEAD"]).decode().strip(),
            "stateUnchanged": status_before == status_after,
            "operations": {name: {**distribution(values), "firstObservedMs": first[name],
                                   "subprocesses": len(operations[name]), "stdoutBytes": output_bytes[name],
                                   "gitArgs": operations[name]} for name, values in collected.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", action="append", default=[])
    parser.add_argument("--fixture-root", type=Path)
    parser.add_argument("--samples", type=int, default=25)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.samples < 5 or args.warmup < 1:
        parser.error("Use at least 5 samples and 1 warmup")
    git = shutil.which("git")
    if not git:
        parser.error("git must be installed")
    repos = [Path(path).resolve() for path in args.repo]
    if args.fixture_root:
        args.fixture_root.mkdir(parents=True, exist_ok=False)
        for count in (2000, 12000):
            repos.append(fixture(git, args.fixture_root, count))
    if not repos:
        parser.error("Specify --repo and/or --fixture-root")
    result = {"schemaVersion": 1, "startedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "metadata": {"platform": platform.platform(), "hostname": platform.node(), "python": platform.python_version(),
                           "logicalCpus": os.cpu_count(), "gitExecutable": git,
                           "gitVersion": invoke(git, repos[0], ["--version"]).decode().strip(),
                           "samples": args.samples, "warmup": args.warmup, "cache": "warm-after-explicit-warmup",
                           "optionalLocks": False, "includes": "Git subprocess startup, execution and stdout capture",
                           "excludes": "Tauri IPC, UI parsing, SSH transport, gitoxide; cross-host hardware differs"},
              "repositories": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for root in repos:
        measured = measure_repo(git, root, args.samples, args.warmup)
        result["repositories"].append(measured)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"path": str(root), "tracked": measured["trackedFiles"], "unchanged": measured["stateUnchanged"],
                          "medianMs": {name: round(operation["medianMs"], 2) for name, operation in measured["operations"].items()}}), flush=True)
    if not all(repo["stateUnchanged"] and repo["headUnchanged"] for repo in result["repositories"]):
        raise SystemExit("Repository changed during measurement; results require rerun")


if __name__ == "__main__":
    main()
