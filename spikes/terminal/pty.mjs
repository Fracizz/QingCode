import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import {
  ControlLineDecoder,
  chooseBackend,
  clampSize,
  encodeControlLine,
  posixQuote,
} from './control.mjs'
import { probeSync } from './probe.mjs'
import { PYTHON_BRIDGE_SOURCE } from './pythonBridge.mjs'

/**
 * @typedef {{
 *   shell?: string,
 *   args?: string[],
 *   cols?: number,
 *   rows?: number,
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   term?: string,
 *   backend?: 'auto' | 'python' | 'script',
 *   capabilities?: import('./probe.mjs').Capabilities,
 *   python3?: string,
 * }} SpawnPtyOptions
 */
/** @typedef {{ code: number | null, signal: number | string | null, source: string }} ExitInfo */
/** @typedef {{ backend: 'python' | 'script', pid: number | null, cols: number, rows: number }} ReadyInfo */

/**
 * 启动一个 PTY 会话。优先方案 A（python3 内联桥，支持 resize），
 * 其次方案 B（`script -qfec`，不具备运行时 resize）。无原生依赖、无需上传文件。
 *
 * @param {SpawnPtyOptions} [options]
 */
export function spawnPty(options = {}) {
  const caps = options.capabilities ?? probeSync()
  const backend = chooseBackend(caps, options.backend ?? 'auto')
  const shell = options.shell ?? process.env.SHELL ?? '/bin/bash'
  const args = options.args ?? []
  const cols = clampSize(options.cols, 80)
  const rows = clampSize(options.rows, 24)
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd()
  const env = {
    ...cleanEnv(process.env),
    ...cleanEnv(options.env ?? {}),
    TERM: options.term ?? process.env.TERM ?? 'xterm-256color',
    COLUMNS: String(cols),
    LINES: String(rows),
  }

  const child =
    backend === 'python'
      ? spawnPythonPty({ shell, args, cols, rows, cwd, env, python3: options.python3 ?? 'python3' })
      : spawnScriptPty({ shell, args, cols, rows, cwd, env })

  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const decoder = new ControlLineDecoder()
  /** @type {import('node:net').Socket | null} */
  const control = /** @type {any} */ (child.stdio[3]) ?? null
  /** @type {ReadyInfo | null} */
  let readyInfo = backend === 'script' ? { backend: 'script', pid: child.pid ?? null, cols, rows } : null
  /** @type {ExitInfo | null} */
  let exitInfo = null
  /** @type {Buffer[]} */
  let earlyData = []
  let dataAttached = false

  /** @param {ExitInfo} info */
  const finish = (info) => {
    if (exitInfo) return
    exitInfo = info
    emitter.emit('exit', info)
  }

  child.stdout?.on('data', (chunk) => {
    const buf = Buffer.from(chunk)
    if (dataAttached) emitter.emit('data', buf)
    else if (earlyData.length < 256) earlyData.push(buf)
  })
  child.stderr?.on('data', (chunk) => emitter.emit('stderr', Buffer.from(chunk)))
  child.on('error', (err) => emitter.emit('stderr', Buffer.from(String(err))))
  child.on('close', (code, signal) => finish({ code, signal: signal ?? null, source: 'process' }))

  control?.on('data', (chunk) => {
    for (const msg of decoder.push(Buffer.from(chunk))) {
      emitter.emit('control', msg)
      if (msg.type === 'ready' && !readyInfo) {
        readyInfo = {
          backend: 'python',
          pid: typeof msg.pid === 'number' ? msg.pid : child.pid ?? null,
          cols: typeof msg.cols === 'number' ? msg.cols : cols,
          rows: typeof msg.rows === 'number' ? msg.rows : rows,
        }
        emitter.emit('ready', readyInfo)
      } else if (msg.type === 'exit') {
        finish({
          code: typeof msg.code === 'number' ? msg.code : null,
          signal: typeof msg.signal === 'number' ? msg.signal : null,
          source: 'control',
        })
      }
    }
  })

  /** @param {NodeJS.Signals | number} [signal] */
  const kill = (signal = 'SIGTERM') => {
    if (exitInfo) return
    if (backend === 'python' && control && !control.destroyed) {
      try {
        control.write(encodeControlLine({ type: 'shutdown' }))
      } catch {
        // 控制通道已断时直接信号杀进程。
      }
    }
    killTree(child, backend, signal)
    setTimeout(() => {
      if (!exitInfo) killTree(child, backend, 'SIGKILL')
    }, 2000).unref()
  }

  return {
    backend,
    supportsResize: backend === 'python',
    get pid() {
      return child.pid ?? null
    },
    get exited() {
      return exitInfo !== null
    },
    /** 仅打印诊断，绝不记录 PTY 输出（可能含凭据）。 */
    capabilities: caps,
    /** @param {(chunk: Buffer) => void} fn */
    onData(fn) {
      dataAttached = true
      emitter.on('data', fn)
      const buffered = earlyData
      earlyData = []
      for (const chunk of buffered) fn(chunk)
      return () => emitter.off('data', fn)
    },
    /** @param {(chunk: Buffer) => void} fn */
    onStderr(fn) {
      emitter.on('stderr', fn)
      return () => emitter.off('stderr', fn)
    },
    /** @param {(info: ExitInfo) => void} fn */
    onExit(fn) {
      const info = exitInfo
      if (info) queueMicrotask(() => fn(info))
      emitter.on('exit', fn)
      return () => emitter.off('exit', fn)
    },
    /** @param {(msg: Record<string, unknown>) => void} fn */
    onControl(fn) {
      emitter.on('control', fn)
      return () => emitter.off('control', fn)
    },
    /**
     * @param {string | Uint8Array} data
     * @returns {number}
     */
    write(data) {
      if (exitInfo || !child.stdin?.writable) return 0
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
      child.stdin.write(buf)
      return buf.byteLength
    },
    /**
     * @param {number} nextCols
     * @param {number} nextRows
     * @returns {boolean} 后端是否真的能改窗口尺寸
     */
    resize(nextCols, nextRows) {
      if (backend !== 'python' || !control || exitInfo) return false
      control.write(
        encodeControlLine({
          type: 'resize',
          cols: clampSize(nextCols, cols),
          rows: clampSize(nextRows, rows),
        }),
      )
      return true
    },
    /** 控制通道 RTT 探针；方案 B 没有控制通道。 @param {number} [id] @returns {boolean} */
    ping(id = 0) {
      if (backend !== 'python' || !control || exitInfo) return false
      control.write(encodeControlLine({ type: 'ping', id, ts: Date.now() }))
      return true
    },
    /** @param {number} [timeoutMs] @returns {Promise<ReadyInfo>} */
    waitReady(timeoutMs = 5000) {
      if (readyInfo) return Promise.resolve(readyInfo)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('PTY 桥未在超时内就绪'))
        }, timeoutMs)
        /** @param {ExitInfo} info */
        const onFailed = (info) => {
          cleanup()
          reject(new Error(`PTY 桥提前退出: ${JSON.stringify(info)}`))
        }
        /** @param {ReadyInfo} info */
        const onReady = (info) => {
          cleanup()
          resolve(info)
        }
        const cleanup = () => {
          clearTimeout(timer)
          emitter.off('ready', onReady)
          emitter.off('exit', onFailed)
        }
        emitter.once('ready', onReady)
        emitter.once('exit', onFailed)
      })
    },
    kill,
    close() {
      kill()
    },
  }
}

/** @param {{ shell: string, args: string[], cols: number, rows: number, cwd: string, env: Record<string, string>, python3: string }} o */
function spawnPythonPty(o) {
  const config = JSON.stringify({
    shell: o.shell,
    args: o.args,
    cwd: o.cwd,
    cols: o.cols,
    rows: o.rows,
  })
  return spawn(o.python3, ['-I', '-c', PYTHON_BRIDGE_SOURCE, config], {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/** @param {{ shell: string, args: string[], cols: number, rows: number, cwd: string, env: Record<string, string> }} o */
function spawnScriptPty(o) {
  // script 自身不给 pty 设尺寸；用 stty 在 exec 之前设定一次（运行时无法改）。
  const quoted = [o.shell, ...o.args].map(posixQuote).join(' ')
  const command = `stty rows ${o.rows} cols ${o.cols} 2>/dev/null; exec ${quoted}`
  return spawn('script', ['-q', '-f', '-e', '-c', command, '/dev/null'], {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 独立进程组：script 被杀时可能留下 pty 里的 shell，需要整组回收。
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
}

/** @param {import('node:child_process').ChildProcess} child @param {string} backend @param {NodeJS.Signals | number} signal */
function killTree(child, backend, signal) {
  if (backend === 'script' && child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
    } catch {
      // 进程组已不存在。
    }
  }
  try {
    child.kill(signal)
  } catch {
    // 进程已退出。
  }
}

/** @param {Record<string, string | undefined>} source */
function cleanEnv(source) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}
