#!/usr/bin/env python3
"""在 Windows 构建 QingCode Next，并把校验后的安装包和 APK 取回当前项目。"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from uuid import uuid4


ROOT = Path(__file__).resolve().parent.parent
BUILD_PEER = "windows-91295"
BASE_VERSION = r"\d+\.\d+\.\d+"


def run(command, *, capture=False):
    return subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.PIPE if capture else None,
                          encoding="utf-8", errors="replace").stdout


def build_remote(args, branch, commit, transfer):
    channel = "stable" if args.stable else "beta"
    remote = {"BRANCH": branch, "COMMIT": commit, "TARGET": args.target,
              "CHANNEL": channel, "BASE_VERSION": args.base_version or "", "TRANSFER": transfer}
    command = ["agent-cli-x", "exec", BUILD_PEER, "--cwd", "dl:", "--timeout", "1800", "--detach", "--json"]
    for key, value in remote.items():
        command.extend(("--env", f"QN_PACKAGE_{key}={value}"))
    command.extend(("--script", str(ROOT / "scripts/qn-package-remote.ps1")))
    job = json.loads(run(command, capture=True))["job_id"]
    print(f"Windows 构建任务 {job}，源提交 {commit[:8]}，传输目录 dl:{transfer}", flush=True)

    marker = "QN_PACKAGE_READY "
    version = ""
    command = ["agent-cli-x", "job", "logs", BUILD_PEER, job, "--follow", "--full"]
    with subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, encoding="utf-8", errors="replace") as process:
        for line in process.stdout:
            print(line, end="", flush=True)
            if line.startswith(marker):
                version = line[len(marker):].strip()
        if process.wait():
            raise subprocess.CalledProcessError(process.returncode, command)

    expected = BASE_VERSION if args.stable else BASE_VERSION + r"-beta\.\d+"
    if not re.fullmatch(expected, version):
        raise ValueError("构建任务未报告符合所选渠道的版本")
    return version


def retrieve(version, target, transfer):
    release = ROOT / "release"
    release.mkdir(parents=True, exist_ok=True)
    destination = release / version
    if destination.exists():
        raise FileExistsError(f"本机已有此版本目录：{destination}")

    names = []
    if target != "android":
        names.append(f"QingCode-Next-{version}-x64.exe")
    if target != "desktop":
        names.append(f"QingCode-Next-{version}-android.apk")
    with tempfile.TemporaryDirectory(prefix=".qn-package-", dir=release) as work:
        staged = Path(work) / version
        staged.mkdir()
        for name in [*names, "SHA256SUMS"]:
            run(["agent-cli-x", "get", BUILD_PEER, f"dl:{transfer}/{name}", str(staged / name)])
        hashes = []
        for name in names:
            path = staged / name
            if not path.stat().st_size:
                raise ValueError(f"产物为空：{name}")
            digest = hashlib.sha256()
            with path.open("rb") as artifact:
                while chunk := artifact.read(1024 * 1024):
                    digest.update(chunk)
            hashes.append(f"{digest.hexdigest()}  {name}")
        if hashes != (staged / "SHA256SUMS").read_text(encoding="ascii").splitlines():
            raise ValueError("取回的文件与构建机 SHA256SUMS 不匹配")
        staged.rename(destination)
    run(["node", str(ROOT / "apps/desktop/build/release-retention.mjs")])
    print(f"已取回并校验 {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", choices=("all", "desktop", "android"), default="all",
                        help="构建目标，默认 all")
    parser.add_argument("--stable", action="store_true", help="打正式版，默认 beta（BT）")
    parser.add_argument("--base-version", help="指定基础版本 X.Y.Z，默认沿用归档中的基础版本")
    parser.add_argument("--remote-only", action="store_true", help="仅保留构建机产物，默认取回本机")
    args = parser.parse_args()
    if args.base_version and not re.fullmatch(BASE_VERSION, args.base_version):
        parser.error("--base-version 必须为 X.Y.Z")

    transfer = f"qn-package-{uuid4().hex[:12]}"
    try:
        branch = run(["git", "symbolic-ref", "--short", "HEAD"], capture=True).strip()
        commit = run(["git", "rev-parse", "HEAD"], capture=True).strip()
        version = build_remote(args, branch, commit, transfer)
        if args.remote_only:
            print(f"{version} 已保存在构建机 dl:{transfer}")
        else:
            retrieve(version, args.target, transfer)
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        print(f"打包未完成：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
