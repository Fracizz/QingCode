// 方案 A 的 Python 内联桥源码（交给 `python3 -I -c`），随 qn-server.cjs 单文件分发，
// 不向远端上传额外文件、不引入原生模块。
//
// 通道约定：stdin/stdout 只走原始 PTY 字节；fd 3 是双向 JSON 行控制通道
// （C→P：resize/shutdown/ping；P→C：ready/resized/pong/exit/error）；stderr 只放桥自身诊断。
// 相对 spike 原型的改动：子进程退出即结束（不再等 master EIO），
// 否则 `nohup cmd &` 之类仍持有 slave 的后台进程会让终端永远显示为存活。

export const PYTHON_PROBE_SOURCE = [
  'import json, os, sys, pty, fcntl, termios, select, signal, struct',
  'print(json.dumps({',
  '  "ok": os.name == "posix" and hasattr(pty, "fork") and hasattr(termios, "TIOCSWINSZ"),',
  '  "pty": hasattr(pty, "fork"),',
  '  "version": ".".join(map(str, sys.version_info[:3])),',
  '}))',
].join('\n')

export const PYTHON_BRIDGE_SOURCE = String.raw`
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

CTRL_FD = 3
cfg = json.loads(sys.argv[1])
shell = cfg['shell']
argv = [shell] + list(cfg.get('args') or [])
cwd = cfg['cwd']
cols = int(cfg['cols'])
rows = int(cfg['rows'])
env = dict(os.environ)

stopping = 0
status = None


def err(message):
    try:
        sys.stderr.write('qn-pty: ' + str(message) + '\n')
        sys.stderr.flush()
    except Exception:
        pass


def ctrl(obj):
    try:
        os.write(CTRL_FD, (json.dumps(obj, separators=(',', ':')) + '\n').encode('utf-8'))
    except OSError:
        pass


def set_winsize(rows_, cols_):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows_, cols_, 0, 0))


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
            view = view[n:]
        except InterruptedError:
            continue


def kill_child(signum):
    try:
        os.killpg(child, signum)
    except OSError:
        try:
            os.kill(child, signum)
        except OSError:
            pass


def reap(flags):
    global status
    if status is not None:
        return True
    try:
        done, st = os.waitpid(child, flags)
    except ChildProcessError:
        return True
    except InterruptedError:
        return False
    if done == child:
        status = st
        return True
    return False


def read_master():
    # 返回 bytes；b'' 表示 EOF/EIO；None 表示暂无数据
    try:
        return os.read(master, 65536)
    except BlockingIOError:
        return None
    except InterruptedError:
        return None
    except OSError as exc:
        if exc.errno == errno.EIO:
            return b''
        if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
            return None
        err('read master: ' + str(exc))
        return b''


def drain_master():
    # 子进程已退出：把 pty 里剩下的输出读完再结束，最多 300ms
    deadline = time.time() + 0.3
    while time.time() < deadline:
        data = read_master()
        if not data:
            return
        write_all(1, data)


def handle_ctrl(cmd):
    global stopping
    kind = cmd.get('type')
    if kind == 'resize':
        c = max(1, min(1000, int(cmd.get('cols') or cols)))
        r = max(1, min(1000, int(cmd.get('rows') or rows)))
        set_winsize(r, c)
        # TIOCSWINSZ 时内核会给前台进程组发 SIGWINCH；再显式发一次给前台进程组兜底。
        try:
            os.killpg(os.tcgetpgrp(master), signal.SIGWINCH)
        except OSError:
            try:
                os.kill(child, signal.SIGWINCH)
            except OSError:
                pass
        ctrl({'type': 'resized', 'cols': c, 'rows': r})
    elif kind == 'shutdown':
        stopping = signal.SIGTERM
        kill_child(signal.SIGHUP)
    elif kind == 'ping':
        ctrl({'type': 'pong', 'id': cmd.get('id')})
    else:
        err('unknown control type: ' + str(kind))


def on_signal(signum, _frame):
    global stopping
    stopping = signum
    kill_child(signal.SIGHUP)


try:
    child, master = pty.fork()
except OSError as exc:
    err('pty.fork failed: ' + str(exc))
    ctrl({'type': 'error', 'message': 'pty.fork failed: ' + str(exc)})
    sys.exit(2)

if child == 0:
    try:
        os.close(CTRL_FD)
    except OSError:
        pass
    try:
        os.chdir(cwd)
    except OSError as exc:
        os.write(2, ('qn-pty: chdir failed: ' + str(exc) + '\r\n').encode())
        os._exit(127)
    try:
        os.execvpe(shell, argv, env)
    except OSError as exc:
        os.write(2, ('qn-pty: exec ' + shell + ' failed: ' + str(exc) + '\r\n').encode())
        os._exit(127)

os.set_blocking(master, False)
os.set_blocking(0, False)
os.set_blocking(CTRL_FD, False)
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(sig, on_signal)
try:
    set_winsize(rows, cols)
except OSError as exc:
    err('initial winsize failed: ' + str(exc))
ctrl({'type': 'ready', 'pid': child, 'cols': cols, 'rows': rows})

readers = {master, 0, CTRL_FD}
pending = b''
ctrl_buf = b''

while not stopping:
    try:
        readable, writable, _ = select.select(sorted(readers), [master] if pending else [], [], 0.1)
    except InterruptedError:
        continue
    except (OSError, ValueError) as exc:
        err('select failed: ' + str(exc))
        break

    if writable and pending:
        try:
            n = os.write(master, pending[:65536])
            pending = pending[n:]
        except BlockingIOError:
            pass
        except OSError as exc:
            if exc.errno != errno.EIO:
                err('write master: ' + str(exc))
            pending = b''

    if 0 in readable:
        try:
            data = os.read(0, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            # stdin EOF 不结束终端：会话归 daemon 管，断线后仍要活着。
            readers.discard(0)
        elif data:
            pending += data

    if CTRL_FD in readable:
        try:
            data = os.read(CTRL_FD, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            # 控制通道关闭说明 daemon 已不在，结束会话以免留下孤儿 shell。
            stopping = signal.SIGHUP
            kill_child(signal.SIGHUP)
            break
        if data:
            ctrl_buf += data
            while b'\n' in ctrl_buf:
                line, ctrl_buf = ctrl_buf.split(b'\n', 1)
                if not line.strip():
                    continue
                try:
                    handle_ctrl(json.loads(line.decode('utf-8')))
                except Exception as exc:
                    err('bad control line: ' + str(exc))

    if master in readable:
        data = read_master()
        if data == b'':
            break
        if data:
            try:
                write_all(1, data)
            except OSError as exc:
                err('write stdout: ' + str(exc))
                stopping = signal.SIGHUP
                kill_child(signal.SIGHUP)
                break
    elif reap(os.WNOHANG):
        try:
            drain_master()
        except OSError:
            pass
        break

if stopping:
    # 给 SIGHUP 一点时间让 shell 正常收尾，再强杀整个进程组。
    deadline = time.time() + 0.5
    while not reap(os.WNOHANG) and time.time() < deadline:
        time.sleep(0.02)
    if status is None:
        kill_child(signal.SIGKILL)

deadline = time.time() + 2.0
while not reap(os.WNOHANG):
    if time.time() > deadline:
        kill_child(signal.SIGKILL)
        reap(0)
        break
    time.sleep(0.01)

exit_code = None
exit_signal = None
if status is not None:
    if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        exit_signal = os.WTERMSIG(status)
ctrl({'type': 'exit', 'code': exit_code, 'signal': exit_signal})
try:
    os.close(master)
except OSError:
    pass
sys.exit(0)
`.trim()
