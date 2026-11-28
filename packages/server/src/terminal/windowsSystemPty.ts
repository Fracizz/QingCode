import { spawn } from 'node:child_process'
import path from 'node:path'
import { PtyEvents, type PtyBackendImpl, type PtyProcess } from './backend'
import { termError } from './logic'
import { CONPTY_SCRIPT } from './windowsSystemPtyScript'

const READY_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 3_000
const COMMAND = Buffer.from(CONPTY_SCRIPT, 'utf16le').toString('base64')

// CreateProcessW 接收命令行，按 Windows argv 规则转义。参数不会交给 PowerShell 解释。
function quoteArg(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"'
}

function dimensions(cols: number, rows: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeInt16LE(cols)
  buffer.writeInt16LE(rows, 2)
  return buffer
}

function lengthPrefix(length: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32LE(length)
  return buffer
}

export const windowsSystemPty: PtyBackendImpl = {
  name: 'conpty',
  supportsResize: true,
  spawn({ shell, args, cwd, env, cols, rows }) {
    const commandLine = Buffer.from([shell, ...args].map(quoteArg).join(' '), 'utf8')
    const powershell = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', COMMAND], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const events = new PtyEvents()
    let pid: number | null = null
    let closing: ReturnType<typeof setTimeout> | undefined
    // 输入帧用字节数区分按键和 resize，stdin 结束后由桥关闭 ConPTY。
    const proc: PtyProcess = {
      backend: 'conpty',
      supportsResize: true,
      get pid() { return pid },
      onData: (listener) => events.onData(listener),
      onExit: (listener) => events.onExit(listener),
      write(data) {
        if (!events.exited && !closing && data.length && child.stdin.writable) {
          child.stdin.write(Buffer.concat([lengthPrefix(data.length), data]))
        }
      },
      pendingWriteBytes: () => child.stdin.writableLength,
      resize(cols, rows) {
        if (events.exited || closing || !child.stdin.writable) return false
        child.stdin.write(Buffer.concat([lengthPrefix(0), dimensions(cols, rows)]))
        return true
      },
      kill() {
        if (events.exited || closing) return
        child.stdin.end()
        closing = setTimeout(() => child.kill(), CLOSE_TIMEOUT_MS)
        closing.unref()
      },
    }

    child.stdin.on('error', () => {})
    child.stdout.on('data', (data: Buffer) => events.data(data))
    return new Promise((resolve, reject) => {
      let status = ''
      const unavailable = () => termError('pty_unavailable', '无法使用 Windows ConPTY，请确认目标系统支持 ConPTY，且 Windows PowerShell 可运行')
      const readyTimer = setTimeout(() => {
        proc.kill()
        reject(termError('term_spawn_failed', 'Windows ConPTY 启动超时'))
      }, READY_TIMEOUT_MS)
      child.stderr.setEncoding('utf8').on('data', (data: string) => {
        if (pid !== null || status.length >= 4096) return
        status += data
        // stderr 只用于就绪标记。PowerShell 的原始诊断可能含路径或环境，不向客户端转发。
        const ready = /^ready (\d+)\r?\n/m.exec(status)
        if (!ready || closing) return
        pid = Number(ready[1])
        clearTimeout(readyTimer)
        resolve(proc)
      })
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(readyTimer)
        reject(error.code === 'ENOENT' ? unavailable() : termError('term_spawn_failed', '无法启动 Windows ConPTY 终端'))
      })
      // stdout 读完后再派发退出，保证最后一帧进入回放缓冲。
      child.once('close', (code, signal) => {
        clearTimeout(readyTimer)
        clearTimeout(closing)
        if (pid === null) {
          reject(/^conpty\r?$/m.test(status) ? termError('term_spawn_failed', '无法启动 Windows ConPTY 终端') : unavailable())
        }
        events.exit({ code, signal })
      })
      child.stdin.write(Buffer.concat([dimensions(cols, rows), lengthPrefix(commandLine.length), commandLine]))
    })
  },
}
