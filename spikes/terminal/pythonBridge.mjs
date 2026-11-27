/**
 * 方案 A 的 Python 内联桥源码。
 *
 * 生产化时把这串常量交给 `python3 -I -c`，不需要往远端上传任何额外文件，
 * 也就不必往 qn-server.cjs 里塞原生模块。fd 3 是与 Node 之间的双向 JSON 行控制通道，
 * stdout / stdin 只走原始 PTY 字节，避免控制信息与终端数据互相污染。
 */
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
env['TERM'] = env.get('TERM') or 'xterm-256color'
env['COLUMNS'] = str(cols)
env['LINES'] = str(rows)

stopping = 0


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


def handle_ctrl(cmd):
    global stopping
    kind = cmd.get('type')
    if kind == 'resize':
        c = max(1, min(1000, int(cmd.get('cols') or cols)))
        r = max(1, min(1000, int(cmd.get('rows') or rows)))
        set_winsize(r, c)
        # Linux 的 TIOCSWINSZ 会给前台进程组发 SIGWINCH；再显式发一次，
        # 让没被内核判定为前台进程组的全屏程序也能重绘。
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
        ctrl({'type': 'pong', 'id': cmd.get('id'), 'ts': cmd.get('ts')})
    else:
        err('unknown control type: ' + str(kind))


def on_signal(signum, _frame):
    global stopping
    stopping = signum
    kill_child(signal.SIGTERM)


try:
    child, master = pty.fork()
except OSError as exc:
    err('pty.fork failed: ' + str(exc))
    ctrl({'type': 'error', 'message': 'pty.fork failed'})
    sys.exit(2)

if child == 0:
    try:
        os.close(CTRL_FD)
    except OSError:
        pass
    try:
        os.chdir(cwd)
    except OSError as exc:
        os.write(2, ('qn-pty: chdir failed: ' + str(exc) + '\n').encode())
        os._exit(127)
    try:
        os.execvpe(shell, argv, env)
    except OSError as exc:
        os.write(2, ('qn-pty: exec failed: ' + str(exc) + '\n').encode())
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
ctrl({'type': 'ready', 'pid': child, 'backend': 'python', 'cols': cols, 'rows': rows})

readers = {master, 0, CTRL_FD}
pending = b''
ctrl_buf = b''
exit_code = None
exit_signal = None

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
            break

    if 0 in readable:
        try:
            data = os.read(0, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            # stdin EOF 不结束终端：客户端断开后守护进程仍可继续持有会话。
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
            # 控制通道关闭说明宿主已退出，杀掉会话以免留下孤儿 shell。
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
        try:
            data = os.read(master, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                data = b''
            elif exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                data = None
            else:
                err('read master: ' + str(exc))
                data = b''
        if data == b'':
            break
        if data:
            try:
                write_all(1, data)
            except OSError as exc:
                err('write stdout: ' + str(exc))
                break

if stopping:
    kill_child(signal.SIGKILL)

status = None
deadline = time.time() + 2.0
while True:
    try:
        done, status = os.waitpid(child, os.WNOHANG)
        if done == child:
            break
    except ChildProcessError:
        break
    if time.time() > deadline:
        kill_child(signal.SIGKILL)
        try:
            _, status = os.waitpid(child, 0)
        except OSError:
            pass
        break
    time.sleep(0.01)

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
