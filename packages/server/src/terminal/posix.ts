// POSIX PTY 后端（IO）：A = python3 内联桥（支持 resize），B = util-linux `script` 兜底（不支持 resize）。
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import type { Socket } from 'node:net'
import type { TermBackendPreference } from './types'
import type { PtyBackendImpl, PtyBackendResolver, PtyExit, PtyProcess, PtySpawnOptions } from './backend'
import {
  ControlLineDecoder,
  chooseBackend,
  encodeControlLine,
  normalizeSignal,
  parsePythonProbe,
  parseScriptProbe,
  scriptCommand,
  termError,
  type Capabilities,
  type ProbeResult,
} from './logic'
import { PYTHON_BRIDGE_SOURCE, PYTHON_PROBE_SOURCE } from './pythonBridge'
import { resolveWindowsPty } from './windows'

const PROBE_TIMEOUT_MS = 5_000
const READY_TIMEOUT_MS = 5_000
const SIGTERM_AFTER_MS = 1_000
const SIGKILL_AFTER_MS = 3_000
const STDERR_TAIL = 2_048

function runProbe(file: string, args: string[]): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? ''),
        error: err ? ((err as NodeJS.ErrnoException).code === 'ENOENT' ? `未找到 ${file}` : err.message) : '',
      })
    })
  })
}

export async function probeCapabilities(): Promise<Capabilities> {
  if (process.platform === 'win32') {
    const none: ProbeResult = { ok: false, version: '', detail: 'Windows 不支持' }
    return { posix: false, python3: none, script: none }
  }
  const [py, ver, help] = await Promise.all([
    runProbe('python3', ['-I', '-c', PYTHON_PROBE_SOURCE]),
    runProbe('script', ['--version']),
    runProbe('script', ['--help']),
  ])
  const python3 = py.ok ? parsePythonProbe(py.stdout) : { ok: false, version: '', detail: py.error }
  const script =
    ver.ok && help.ok
      ? parseScriptProbe(ver.stdout, help.stdout)
      : { ok: false, version: '', detail: ver.error || help.error }
  return { posix: true, python3, script }
}

let cachedCaps: Promise<Capabilities> | null = null

/** 有可用后端的探测结果才缓存：目标机后来装上 python3 时不必重启 daemon。 */
export function cachedCapabilities(): Promise<Capabilities> {
  if (!cachedCaps) {
    const pending = probeCapabilities()
    cachedCaps = pending
    void pending.then((caps) => {
      if (!caps.python3.ok && !caps.script.ok && cachedCaps === pending) cachedCaps = null
    })
  }
  return cachedCaps
}

export function resetCapabilitiesCache(): void {
  cachedCaps = null
}

/** 先于 manager 登记回调时缓存早到的数据与退出事件，避免丢首屏输出。 */
class Emitter {
  private dataListener: ((chunk: Buffer) => void) | null = null
  private exitListener: ((exit: PtyExit) => void) | null = null
  private early: Buffer[] = []
  private exitInfo: PtyExit | null = null
  private exitDelivered = false

  get exited(): boolean {
    return this.exitInfo !== null
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener
    const early = this.early
    this.early = []
    for (const chunk of early) listener(chunk)
  }

  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListener = listener
    this.deliverExit()
  }

  data(chunk: Buffer): void {
    if (this.exitInfo) return
    if (this.dataListener) this.dataListener(chunk)
    else this.early.push(chunk)
  }

  exit(info: PtyExit): void {
    if (this.exitInfo) return
    this.exitInfo = info
    this.deliverExit()
  }

  private deliverExit(): void {
    if (!this.exitInfo || !this.exitListener || this.exitDelivered) return
    // 早到的数据必须先于退出交付。
    if (this.early.length > 0 && this.dataListener) this.onData(this.dataListener)
    this.exitDelivered = true
    this.exitListener(this.exitInfo)
  }
}

function signalName(value: unknown): string | null {
  return normalizeSignal(value, os.constants.signals as unknown as Record<string, number>)
}

function tail(text: string): string {
  return text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text
}

function sendSignal(pid: number | undefined, signal: NodeJS.Signals, group: boolean): void {
  if (!pid) return
  try {
    process.kill(group ? -pid : pid, signal)
  } catch {
    // 进程（组）已不存在。
  }
}

export const pythonBackend: PtyBackendImpl = {
  name: 'python',
  supportsResize: true,
  spawn(options: PtySpawnOptions): Promise<PtyProcess> {
    const config = JSON.stringify({
      shell: options.shell,
      args: options.args,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
    })
    const child = spawn('python3', ['-I', '-c', PYTHON_BRIDGE_SOURCE, config], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return wirePython(child)
  },
}

function wirePython(child: ChildProcess): Promise<PtyProcess> {
  const control = (child.stdio[3] ?? null) as Socket | null
  const emitter = new Emitter()
  const decoder = new ControlLineDecoder()
  let stderr = ''
  let ctrlExit: PtyExit | null = null
  let shellPid: number | null = null
  let killTimers: Array<ReturnType<typeof setTimeout>> = []

  child.stdin?.on('error', () => {
    // 宿主退出后的 EPIPE 不是错误：退出事件会另行上报。
  })
  control?.on('error', () => {})
  child.stdout?.on('data', (chunk: Buffer) => emitter.data(chunk))
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = tail(stderr + chunk.toString('utf8'))
  })

  const proc: PtyProcess = {
    backend: 'python',
    supportsResize: true,
    get pid() {
      return shellPid ?? child.pid ?? null
    },
    onData: (listener) => emitter.onData(listener),
    onExit: (listener) => emitter.onExit(listener),
    write(data) {
      if (emitter.exited || !child.stdin?.writable) return
      child.stdin.write(data)
    },
    pendingWriteBytes: () => child.stdin?.writableLength ?? 0,
    resize(cols, rows) {
      if (emitter.exited || !control || control.destroyed) return false
      control.write(encodeControlLine({ type: 'resize', cols, rows }))
      return true
    },
    kill() {
      if (emitter.exited || killTimers.length > 0) return
      if (control && !control.destroyed) {
        try {
          control.write(encodeControlLine({ type: 'shutdown' }))
        } catch {
          // 控制通道已断，靠下面的信号兜底。
        }
      }
      killTimers = [
        setTimeout(() => sendSignal(child.pid, 'SIGTERM', false), SIGTERM_AFTER_MS),
        setTimeout(() => sendSignal(child.pid, 'SIGKILL', false), SIGKILL_AFTER_MS),
      ]
      for (const timer of killTimers) timer.unref()
    },
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      if (err) {
        sendSignal(child.pid, 'SIGKILL', false)
        reject(err)
      } else {
        resolve(proc)
      }
    }
    const readyTimer = setTimeout(() => settle(termError('term_spawn_failed', 'python3 PTY 桥启动超时')), READY_TIMEOUT_MS)

    control?.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.type === 'ready') {
          if (typeof msg.pid === 'number') shellPid = msg.pid
          settle(null)
        } else if (msg.type === 'error') {
          settle(termError('term_spawn_failed', `python3 PTY 桥失败: ${String(msg.message ?? '')}`))
        } else if (msg.type === 'exit') {
          ctrlExit = {
            code: typeof msg.code === 'number' ? msg.code : null,
            signal: signalName(msg.signal),
          }
        }
      }
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(termError(err.code === 'ENOENT' ? 'pty_unavailable' : 'term_spawn_failed', `无法启动 python3: ${err.message}`))
      emitter.exit({ code: null, signal: null })
    })
    // close 在 stdout 读完之后才触发：此时再报退出，保证最后一块输出先于 term.exit。
    child.on('close', (code, signal) => {
      for (const timer of killTimers) clearTimeout(timer)
      try {
        child.stdin?.destroy()
        control?.destroy()
      } catch {
        // 已关闭。
      }
      settle(
        termError(
          'term_spawn_failed',
          `python3 PTY 桥提前退出（code ${String(code)}）${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ),
      )
      emitter.exit(ctrlExit ?? { code, signal: signalName(signal) })
    })
  })
}

export const scriptBackend: PtyBackendImpl = {
  name: 'script',
  supportsResize: false,
  spawn(options: PtySpawnOptions): Promise<PtyProcess> {
    const command = scriptCommand(options.shell, options.args, options.cols, options.rows)
    const child = spawn('script', ['-q', '-f', '-e', '-c', command, '/dev/null'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 独立进程组：script 被杀时 pty 里的 shell 可能成为孤儿，需要整组回收。
      detached: true,
      windowsHide: true,
    })
    return wireScript(child)
  },
}

function wireScript(child: ChildProcess): Promise<PtyProcess> {
  const emitter = new Emitter()
  let killTimer: ReturnType<typeof setTimeout> | null = null
  child.stdin?.on('error', () => {})
  child.stdout?.on('data', (chunk: Buffer) => emitter.data(chunk))
  // script 的 stderr 只有它自己的诊断；PTY 输出全部走 stdout。
  child.stderr?.resume()
  const proc: PtyProcess = {
    backend: 'script',
    supportsResize: false,
    get pid() {
      return child.pid ?? null
    },
    onData: (listener) => emitter.onData(listener),
    onExit: (listener) => emitter.onExit(listener),
    write(data) {
      if (emitter.exited || !child.stdin?.writable) return
      child.stdin.write(data)
    },
    pendingWriteBytes: () => child.stdin?.writableLength ?? 0,
    resize: () => false,
    kill() {
      if (emitter.exited || killTimer) return
      sendSignal(child.pid, 'SIGHUP', true)
      killTimer = setTimeout(() => sendSignal(child.pid, 'SIGKILL', true), SIGKILL_AFTER_MS)
      killTimer.unref()
    },
  }
  return new Promise((resolve, reject) => {
    let settled = false
    child.once('spawn', () => {
      settled = true
      resolve(proc)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true
        reject(termError(err.code === 'ENOENT' ? 'pty_unavailable' : 'term_spawn_failed', `无法启动 script: ${err.message}`))
      }
      emitter.exit({ code: null, signal: null })
    })
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      // 正常退出时也回收进程组里可能残留的后台进程。
      sendSignal(child.pid, 'SIGHUP', true)
      emitter.exit({ code, signal: signalName(signal) })
    })
  })
}

/** POSIX 探测 python3 → script；Windows 按需加载本机 Electron 的预编译模块。 */
export function createDefaultResolver(
  probe: () => Promise<Capabilities> = cachedCapabilities,
): PtyBackendResolver {
  return async (preference: TermBackendPreference) => {
    if (process.platform === 'win32') {
      return resolveWindowsPty(preference)
    }
    const choice = chooseBackend(await probe(), preference)
    if (!choice.ok) throw termError('pty_unavailable', choice.message)
    return choice.backend === 'python' ? pythonBackend : scriptBackend
  }
}
