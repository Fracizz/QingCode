import { createRequire } from 'node:module'
import path from 'node:path'
import type { PtyBackendImpl, PtyExit, PtyProcess, PtySpawnOptions } from './backend'
import { termError } from './logic'
import type { TermBackendPreference } from './types'

type NativePty = {
  readonly pid: number
  onData: (listener: (data: string) => void) => { dispose(): void }
  onExit: (listener: (exit: { exitCode?: number }) => void) => { dispose(): void }
  write(data: Buffer): void
  resize(cols: number, rows: number): void
  kill(): void
}

type NativeModule = {
  spawn(shell: string, args: string[], options: Omit<PtySpawnOptions, 'shell' | 'args'>): NativePty
}

let cachedBackend: PtyBackendImpl | undefined

export function resolveWindowsPty(preference: TermBackendPreference): PtyBackendImpl {
  if (preference !== 'auto' && preference !== 'conpty') {
    throw termError('pty_unavailable', 'Windows 本机终端需要 ConPTY 后端')
  }
  const serverPath = process.argv[1]
  if (process.arch !== 'x64' || process.env.ELECTRON_RUN_AS_NODE !== '1' || !serverPath) {
    throw termError('pty_unavailable', 'ConPTY 仅在 Windows x64 桌面端的本机目标可用')
  }
  if (cachedBackend) return cachedBackend
  try {
    // 与 qn-server.cjs 一起安装在 ASAR 外；远端部署只复制 JS 单文件。
    const require = createRequire(path.resolve(serverPath))
    const addon = require('./conpty/lib/index.js') as NativeModule
    if (typeof addon.spawn !== 'function') throw new Error('缺少 spawn')
    cachedBackend = createConPtyBackend(addon)
    return cachedBackend
  } catch {
    throw termError('pty_unavailable', '无法加载 Windows ConPTY，请确认预编译模块和 Electron 版本相容')
  }
}

export function createConPtyBackend(addon: NativeModule): PtyBackendImpl {
  return {
    name: 'conpty',
    supportsResize: true,
    async spawn({ shell, args, ...options }) {
      let native: NativePty
      try {
        native = addon.spawn(shell, args, options)
      } catch {
        throw termError('term_spawn_failed', '无法启动 Windows ConPTY 终端')
      }
      return bindPty(native)
    },
  }
}

function bindPty(native: NativePty): PtyProcess {
  let dataListener: ((data: Buffer) => void) | undefined
  let exitListener: ((exit: PtyExit) => void) | undefined
  let exitInfo: PtyExit | undefined
  let closing = false
  // 原生进程可能在 manager 注册回调前就写出提示符或退出。
  const early: Buffer[] = []
  const dataSubscription = native.onData((data) => {
    if (exitInfo) return
    const chunk = Buffer.from(data, 'utf8')
    if (dataListener) dataListener(chunk)
    else early.push(chunk)
  })
  native.onExit(({ exitCode }) => {
    if (exitInfo) return
    exitInfo = { code: exitCode ?? null, signal: null }
    dataSubscription.dispose()
    exitListener?.(exitInfo)
  })
  return {
    backend: 'conpty',
    supportsResize: true,
    get pid() {
      return native.pid > 0 ? native.pid : null
    },
    onData(listener) {
      dataListener = listener
      for (const chunk of early.splice(0)) listener(chunk)
    },
    onExit(listener) {
      exitListener = listener
      if (exitInfo) listener(exitInfo)
    },
    write(data) {
      if (!closing && !exitInfo) native.write(data)
    },
    // node-pty 的公开接口不提供管道写入队列长度；单次写入仍由 manager 限量。
    pendingWriteBytes: () => 0,
    resize(cols, rows) {
      if (closing || exitInfo) return false
      native.resize(cols, rows)
      return true
    },
    kill() {
      if (closing || exitInfo) return
      closing = true
      native.kill()
    },
  }
}
