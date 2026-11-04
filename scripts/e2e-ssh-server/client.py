#!/usr/bin/env python3
"""qingcode-server `serve` 协议客户端（真机端到端验收专用）。

协议与 `src-tauri/qingcode-server/src/lib.rs` 严格对齐：
  帧 = 4 字节小端长度 + JSON 负载；
  首帧 = {"token": "...", "op": {"type": "...", "params": {...}}}；
  响应 = ok / records / done / error。

密钥类信息全部由 run.sh 通过环境变量注入（主机、密码、token），本文件不含凭据。
用法见 run.sh；单独调试：

  python3 client.py --host 127.0.0.1 --port 12345 --token <token> \
      --phase core --expect-version 0.1.13-beta.3
"""

import argparse
import json
import os
import shlex
import socket
import struct
import subprocess
import sys
import time

# 与 lib.rs MAX_FRAME_BYTES / ops.rs MAX_RECORD_BYTES 对齐
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024

# watch 注册递归监视时 notify 会对被枚举的子目录各产生一条事件，归入「注册期噪声」；
# 超过这个时间窗的事件才算运行期空转。
REGISTRATION_NOISE_WINDOW = 1.5

RESULTS = []


def check(name, ok, detail=""):
    """记录一条断言并按统一格式输出，供 run.sh 汇总。"""
    ok = bool(ok)
    RESULTS.append((name, ok, detail))
    print("[{}] {} :: {}".format("PASS" if ok else "FAIL", name, detail), flush=True)
    return ok


def shorten(text, limit=240):
    text = text if isinstance(text, str) else repr(text)
    return text if len(text) <= limit else text[:limit] + "..."


# --------------------------------------------------------------------------- #
# 帧编解码
# --------------------------------------------------------------------------- #


def connect(host, port, timeout=20.0):
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    return sock


def send_frame(sock, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if not 0 < len(data) <= MAX_FRAME_BYTES:
        raise ValueError("请求帧长度非法: {}".format(len(data)))
    sock.sendall(struct.pack("<I", len(data)) + data)


def recv_exact(sock, size):
    buf = b""
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            raise ConnectionError("对端提前关闭连接（已读 {} 字节）".format(len(buf)))
        buf += chunk
    return buf


def read_frame(sock):
    (length,) = struct.unpack("<I", recv_exact(sock, 4))
    if length == 0 or length > MAX_FRAME_BYTES:
        raise ValueError("非法帧长度 {}".format(length))
    return json.loads(recv_exact(sock, length))


def make_request(token, op, params=None):
    op_obj = {"type": op}
    if params is not None:
        op_obj["params"] = params
    return {"token": token, "op": op_obj}


def first_frame(host, port, request):
    """发一帧、读一帧（连接随即关闭）：用于 ping 与被拒类断言。"""
    sock = connect(host, port)
    try:
        send_frame(sock, request)
        return read_frame(sock)
    finally:
        sock.close()


def collect(host, port, request, idle_timeout=60.0):
    """读到 done / error / ok 为止，返回 (records, done, error, eof)。"""
    records, done, error, eof = [], None, None, False
    sock = connect(host, port)
    sock.settimeout(idle_timeout)
    try:
        send_frame(sock, request)
        while True:
            frame = read_frame(sock)
            kind = frame.get("type")
            if kind == "records":
                records.extend(frame.get("data") or [])
            elif kind == "done":
                done = frame
                break
            elif kind == "error":
                error = frame
                break
            elif kind == "ok":
                done = frame
                break
            else:
                raise ValueError("未知响应类型: {}".format(shorten(frame)))
        # done 之后服务端应正常关闭（EOF），而不是 RST / 悬挂 —— 即「连接未断」的反面校验。
        sock.settimeout(3.0)
        try:
            eof = sock.recv(1) == b""
        except (ConnectionError, socket.timeout, OSError):
            eof = False
    finally:
        sock.close()
    return records, done, error, eof


# --------------------------------------------------------------------------- #
# 远端操作（构造测试现场）：walk 顺序不可控，故所有写操作都显式指定路径
# --------------------------------------------------------------------------- #


def remote(args, command):
    argv = shlex.split(args.ssh) + [command]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            "远端命令失败（{}）：{}\n{}".format(
                proc.returncode, command, shorten(proc.stderr.strip())
            )
        )
    return proc.stdout


def remote_inotify_count(args):
    """远端 server 进程持有的 inotify 实例数（watch 连接关闭后应回到基线）。"""
    if not args.server_pid:
        return None
    out = remote(
        args,
        "ls -l /proc/{}/fd 2>/dev/null | grep -c 'anon_inode:inotify' || true".format(
            args.server_pid
        ),
    )
    return int((out.strip() or "0").splitlines()[-1])


# --------------------------------------------------------------------------- #
# 断言：基础能力（ping / 鉴权 / scan / searchContent / 越界）
# --------------------------------------------------------------------------- #


def wait_ping(args, budget=20.0):
    """隧道刚建立时可能还没转发就绪，限定时间内重试。"""
    deadline = time.time() + budget
    last_error = "超时"
    while time.time() < deadline:
        try:
            return first_frame(args.host, args.port, make_request(args.token, "ping")), None
        except (OSError, ValueError) as error:
            last_error = "{}: {}".format(type(error).__name__, error)
            time.sleep(0.25)
    return None, last_error


def assert_ping(args):
    frame, error = wait_ping(args)
    ok = frame is not None and frame.get("type") == "ok"
    check("ping 通（隧道 + token 鉴权 + 版本帧）", ok, shorten(frame if ok else error))
    if ok and args.expect_version:
        check(
            "ping 版本号与仓库 Cargo.toml 一致",
            frame.get("version") == args.expect_version,
            "server={} expect={}".format(frame.get("version"), args.expect_version),
        )
    return ok


def assert_bad_token(args):
    frame = first_frame(args.host, args.port, make_request("0" * 32, "ping"))
    check(
        "错误 token 被拒（返回 error 帧）",
        frame.get("type") == "error" and "token" in frame.get("message", ""),
        shorten(frame),
    )


def assert_scan(args):
    records, done, error, _ = collect(args.host, args.port, make_request(args.token, "scan", {"path": "."}))
    if error is not None:
        check("scan 根目录成功", False, shorten(error))
        return
    entries = {item.get("name"): item.get("isDir") for item in records}
    expected = {"src", "escape", "big.txt", "中文文件.txt", ".qingcode"}
    check(
        "scan 根目录返回预期条目（含中文名与符号链接）",
        expected.issubset(set(entries)),
        "got={}".format(sorted(n for n in entries if n)),
    )
    # escape 是指向 /etc 的符号链接：read_dir 的 file_type 不跟随链接，必须为 false。
    check(
        "scan isDir 正确（src=true / escape 符号链接=false / big.txt=false）",
        entries.get("src") is True and entries.get("escape") is False and entries.get("big.txt") is False,
        "src={} escape={} big.txt={}".format(entries.get("src"), entries.get("escape"), entries.get("big.txt")),
    )
    check(
        "scan 返回 done 帧",
        done is not None and done.get("truncated") is False,
        shorten(done),
    )

    records, _, error, _ = collect(args.host, args.port, make_request(args.token, "scan", {"path": "src"}))
    names = {item.get("name") for item in records}
    check(
        "scan 子目录 src 正常（相对路径解析）",
        error is None and {"main.rs", "deep"}.issubset(names),
        "names={} error={}".format(sorted(names), shorten(error) if error else None),
    )


def search(args, **overrides):
    params = {
        "query": "",
        "ignoreCase": False,
        "includeGlobs": [],
        "excludeGlobs": [],
        "noIgnore": False,
        "maxMatches": 1000,
        "maxPerFile": 100,
        "maxFiles": 1000,
    }
    params.update(overrides)
    return collect(args.host, args.port, make_request(args.token, "searchContent", params))


def assert_search_cjk(args):
    """远端没有 rg：命中必须由代理自身的 grep/ignore 实现产出。"""
    records, done, error, eof = search(args, query="命中")
    if error is not None:
        check("searchContent 中文查询成功", False, shorten(error))
        return
    paths = [record["data"]["path"]["text"] for record in records]
    check(
        "searchContent 在无 rg 的远端返回匹配（中文查询）",
        len(records) == 2 and paths == ["./中文文件.txt", "./中文文件.txt"],
        "records={} paths={}".format(len(records), paths),
    )
    numbers = [record["data"]["line_number"] for record in records]
    check("searchContent 行号正确（2、3）", numbers == [2, 3], "line_numbers={}".format(numbers))

    offsets_ok, detail = True, []
    for record in records:
        line = record["data"]["lines"]["text"]
        raw = line.encode("utf-8")
        for submatch in record["data"]["submatches"]:
            start, end = submatch["start"], submatch["end"]
            sliced = raw[start:end].decode("utf-8", "replace")
            offsets_ok = offsets_ok and sliced == "命中"
            detail.append("{}..{}={}".format(start, end, sliced))
    check("searchContent submatch 字节偏移可还原查询词", offsets_ok, ",".join(detail))
    check(
        "searchContent 路径带 ./ 前缀且为 POSIX 分隔符",
        all(p.startswith("./") and "\\" not in p for p in paths),
        ",".join(paths),
    )
    check(
        "searchContent 结束帧 done（未截断）",
        done is not None and done.get("truncated") is False and eof,
        shorten(done),
    )


def assert_search_glob(args):
    records, _, error, _ = search(args, query="hello", includeGlobs=["*.rs"])
    paths = [record["data"]["path"]["text"] for record in records]
    check(
        "searchContent includeGlobs 过滤生效（*.rs 只留 main.rs）",
        error is None and paths == ["./src/main.rs"],
        "paths={} error={}".format(paths, shorten(error) if error else None),
    )

    records, _, error, _ = search(args, query="HELLO", includeGlobs=["*.rs"], ignoreCase=True)
    check(
        "searchContent ignoreCase 生效（HELLO 命中 hello）",
        error is None and len(records) == 1,
        "records={} error={}".format(len(records), shorten(error) if error else None),
    )


def assert_search_bigline(args):
    """3MB 单行：必须裁剪到 ≤2MB 后仍发 done（truncated=true），且连接不被写爆断开。"""
    records, done, error, eof = search(args, query="hello bigline", maxMatches=1000, maxPerFile=100)
    if error is not None:
        check("3MB 单行搜索返回 done", False, shorten(error))
        return
    paths = [record["data"]["path"]["text"] for record in records]
    check(
        "3MB 单行只产出 1 条记录（big.txt）",
        len(records) == 1 and paths == ["./big.txt"],
        "records={} paths={}".format(len(records), paths),
    )
    if records:
        text = records[0]["data"]["lines"]["text"]
        size = len(text.encode("utf-8"))
        check(
            "记录文本被裁剪到 ≤2MB",
            size <= MAX_RECORD_BYTES,
            "bytes={} limit={} startswith_ok={}".format(size, MAX_RECORD_BYTES, text.startswith("hello bigline ")),
        )
        check(
            "裁剪保留行首内容且 submatches 偏移仍有效",
            text.startswith("hello bigline ")
            and records[0]["data"]["submatches"][0]["start"] == 0
            and records[0]["data"]["submatches"][0]["end"] == len("hello bigline"),
            "line_number={} subs={}".format(
                records[0]["data"]["line_number"], records[0]["data"]["submatches"][:2]
            ),
        )
    check(
        "done.truncated=true 且连接正常收尾（未被帧长错误打断）",
        done is not None and done.get("truncated") is True and eof,
        shorten(done),
    )


def assert_escape_rejects(args):
    cases = [
        ("scan 拒绝 ../..", "scan", {"path": "../.."}),
        ("scan 拒绝绝对路径 /etc", "scan", {"path": "/etc"}),
        ("scan 拒绝经符号链接逃逸的 escape", "scan", {"path": "escape"}),
        ("watch 拒绝经符号链接逃逸的 escape", "watch", {"path": "escape"}),
        ("watch 拒绝 ../", "watch", {"path": "../"}),
    ]
    for name, op, params in cases:
        try:
            frame = first_frame(args.host, args.port, make_request(args.token, op, params))
            check(name, frame.get("type") == "error", shorten(frame))
        except (OSError, ValueError) as error:
            check(name, False, "{}: {}".format(type(error).__name__, error))


# --------------------------------------------------------------------------- #
# 断言：watch（事件时效 + 符号链接逃逸不泄露项目外路径 + 连接关闭后释放 inotify）
# --------------------------------------------------------------------------- #


def read_until(sock, deadline, predicate):
    frames = []
    while time.time() < deadline:
        sock.settimeout(max(0.05, min(1.0, deadline - time.time())))
        try:
            frame = read_frame(sock)
        except socket.timeout:
            continue
        frames.append(frame)
        if predicate(frames):
            return frames
    return frames


def assert_watch(args):
    baseline = remote_inotify_count(args)
    probe_name = "newfile-{}.txt".format(os.getpid())
    probe_path = "{}/{}".format(args.remote_project.rstrip("/"), probe_name)
    escape_name = "qc-e2e-probe-{}.txt".format(os.getpid())
    escape_path = "{}/escape/{}".format(args.remote_project.rstrip("/"), escape_name)

    sock = connect(args.host, args.port)
    try:
        send_frame(sock, make_request(args.token, "watch", {"path": "."}))
        watch_started = time.time()
        # 静默期：验证 15s 心跳（空 records 帧），保证安静仓库里客户端不会误判断流。
        # notify 注册递归监视时会对每个被枚举的子目录各产生一条事件（Access 类，
        # debouncer 已抹平成 any），属于注册期噪声；这里把它与「运行期空转」分开断言。
        beat_elapsed, late_events, startup_events = None, [], 0
        deadline = watch_started + 20.0
        while time.time() < deadline:
            sock.settimeout(max(0.05, min(1.0, deadline - time.time())))
            try:
                frame = read_frame(sock)
            except socket.timeout:
                continue
            elapsed = time.time() - watch_started
            if frame.get("type") == "records" and not frame.get("data"):
                beat_elapsed = elapsed
                break
            for item in frame.get("data") or []:
                if elapsed <= REGISTRATION_NOISE_WINDOW:
                    startup_events += 1
                else:
                    late_events.append(item.get("path"))
        check(
            "静默期收到 15s 心跳帧（空 records）",
            beat_elapsed is not None and 12.0 <= beat_elapsed <= 19.0,
            "elapsed={}".format("无" if beat_elapsed is None else "{:.1f}s".format(beat_elapsed)),
        )
        check(
            "注册期后无空转事件（{:.1f}s 至心跳之间零事件）".format(REGISTRATION_NOISE_WINDOW),
            not late_events,
            "注册期噪声={} 条，运行期空转={} 条{}".format(
                startup_events, len(late_events), "" if not late_events else " paths={}".format(late_events[:4])
            ),
        )

        # 给 notify 注册 inotify 的时间窗（350ms 去抖 + 注册耗时）。
        time.sleep(0.4)
        started = time.time()
        remote(args, "touch {}".format(shlex.quote(probe_path)))
        frames = read_until(
            sock,
            started + 8.0,
            lambda acc: any(_events(acc) & {probe_path}),
        )
        elapsed = time.time() - started
        events = _events(frames)
        arrived = probe_path in events
        check(
            "watch 在 2s 内推送新建文件事件",
            arrived and elapsed < 2.0,
            "elapsed={:.2f}s events={}".format(elapsed, sorted(events)[:6]),
        )
        kinds = {
            item.get("kind")
            for frame in frames
            for item in (frame.get("data") or [])
            if item.get("path") == probe_path
        }
        check(
            "watch 事件 kind 取值合法（any / notice）",
            kinds and kinds.issubset({"any", "notice"}),
            "kinds={}".format(sorted(kinds)),
        )

        # 通过 escape（-> /etc）创建文件：不得出现 /etc 或 escape 下的事件
        window_start = time.time()
        remote(args, "touch {}".format(shlex.quote(escape_path)))
        frames = read_until(sock, window_start + 2.5, lambda acc: False)
        leaked = [
            item.get("path")
            for frame in frames
            for item in (frame.get("data") or [])
            if item.get("path") and ("/etc" in item.get("path") or "/escape" in item.get("path"))
        ]
        check(
            "watch 不泄露符号链接逃逸路径（无 /etc、无 escape 事件）",
            not leaked,
            "frames={} leaked={}".format(len(frames), leaked[:4]),
        )
    finally:
        try:
            remote(args, "rm -f {} {}".format(shlex.quote(probe_path), shlex.quote(escape_path)))
        except RuntimeError:
            pass
        sock.close()

    if baseline is not None:
        time.sleep(1.2)
        after = remote_inotify_count(args)
        check(
            "watch 断开后 inotify 实例被释放（不泄漏内核资源）",
            after is not None and after <= baseline,
            "baseline={} after={}".format(baseline, after),
        )


def _events(frames):
    return {
        item.get("path")
        for frame in frames
        if frame.get("type") == "records"
        for item in (frame.get("data") or [])
        if item.get("path")
    }


def _has_empty_records(frames):
    return any(frame.get("type") == "records" and not frame.get("data") for frame in frames)


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #


def build_parser():
    parser = argparse.ArgumentParser(description="qingcode-server serve 协议验收客户端")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True, help="本地隧道端口")
    parser.add_argument("--token", required=True, help="从远端 server.json 读出的 token")
    parser.add_argument("--phase", choices=["core", "watch", "ping"], default="core")
    parser.add_argument("--expect-version", default="", help="仓库 Cargo.toml 里的版本号")
    parser.add_argument("--ssh", default="", help="ssh 命令前缀（含端口/认证选项），用于构造远端现场")
    parser.add_argument("--remote-project", default="", help="远端项目根绝对路径")
    parser.add_argument("--server-pid", type=int, default=0, help="远端 server 进程 pid")
    return parser


def main():
    args = build_parser().parse_args()
    if args.phase == "ping":
        ok = assert_ping(args)
    elif args.phase == "watch":
        if not args.ssh or not args.remote_project:
            print("watch 阶段需要 --ssh 与 --remote-project", file=sys.stderr)
            return 2
        assert_watch(args)
        ok = all(result[1] for result in RESULTS)
    else:
        ok = assert_ping(args)
        assert_bad_token(args)
        assert_scan(args)
        assert_search_cjk(args)
        assert_search_glob(args)
        assert_search_bigline(args)
        assert_escape_rejects(args)
        ok = all(result[1] for result in RESULTS)

    failed = [name for name, passed, _ in RESULTS if not passed]
    if failed:
        print("失败断言：{}".format("; ".join(failed)), file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
