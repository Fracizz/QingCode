/**
 * 一个 pi RPC 子进程（pi --mode rpc，JSONL over stdio）的封装。
 * 纯逻辑：严格 LF 分帧与记录分类；IO：spawn / stdin / stdout / stderr / 退出清理。
 */
import { spawn } from 'node:child_process'
import { redact } from '../log'
import type { PiCommand } from './resolve'

export type RpcRecord = Record<string, unknown>
export type RecordKind = 'response' | 'extension_ui' | 'event'

export interface SplitResult {
  records: RpcRecord[]
  remainder: string
  invalid: number
}

const MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * 只按 LF 切分，去掉可选的 CR；U+2028/U+2029 是 JSON 字符串里的合法字符，不能当记录边界
 * （Node 的 readline 会误切，故这里不用）。末尾未换行的一段留到下次 push。
 */
export function splitJsonl(buffer: string): SplitResult {
  const parts = buffer.split('\n')
  const remainder = parts.pop() ?? ''
  const records: RpcRecord[] = []
  let invalid = 0
  for (const raw of parts) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as RpcRecord)
      } else {
        invalid += 1
      }
    } catch {
      invalid += 1
    }
  }
  return { records, remainder, invalid }
}

/** 响应按 id 关联；扩展 UI 记录不代答（合规：每个对话框都必须由用户本人决定）。 */
export function classifyRecord(record: unknown): RecordKind {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return 'event'
  const type = (record as RpcRecord).type
  if (type === 'response') return 'response'
  if (type === 'extension_ui_request' || type === 'extension_ui_response') return 'extension_ui'
  return 'event'
}

export interface PiProcessLike {
  stdin: { write(chunk: string): unknown; end(): void } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
  kill(): void
  readonly pid?: number
}

export interface PiRpcSpawnSpec {
  command: string
  args: string[]
  shell: boolean
  cwd: string
  env: NodeJS.ProcessEnv
}

export type PiSpawnFn = (spec: PiRpcSpawnSpec) => PiProcessLike

const defaultSpawn: PiSpawnFn = (spec) =>
  spawn(spec.command, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: spec.shell,
    cwd: spec.cwd,
    env: spec.env,
  }) as unknown as PiProcessLike

export interface PiRpcOptions {
  command: PiCommand
  cwd: string
  log: (message: string) => void
  /** 会话恢复/临时会话用的 CLI 参数，如 --no-session。 */
  extraArgs?: string[]
  spawnProcess?: PiSpawnFn
  commandTimeoutMs?: number
}

export interface PiExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

interface Waiter {
  resolve(record: RpcRecord): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcProcess {
  private readonly pending = new Map<string, Waiter>()
  private readonly eventListeners = new Set<(record: RpcRecord) => void>()
  private readonly exitListeners = new Set<(info: PiExitInfo) => void>()
  private child: PiProcessLike | null = null
  private stdoutRemainder = ''
  private stderrRemainder = ''
  private counter = 0
  private closed = false
  private exited = false

  constructor(private readonly options: PiRpcOptions) {}

  get running(): boolean {
    return this.child !== null && !this.exited && !this.closed
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    if (this.child || this.closed) return
    const spawnProcess = this.options.spawnProcess ?? defaultSpawn
    const child = spawnProcess({
      command: this.options.command.command,
      args: [...this.options.command.args, '--mode', 'rpc', ...(this.options.extraArgs ?? [])],
      shell: this.options.command.shell,
      cwd: this.options.cwd,
      // 原样继承用户环境，不注入任何凭据/提供方变量。
      env: { ...process.env },
    })
    this.child = child
    child.stdout?.on('data', (chunk) => this.onStdout(toText(chunk)))
    child.stderr?.on('data', (chunk) => this.onStderr(toText(chunk)))
    child.on('error', (err) => {
      this.options.log(`pi RPC 启动失败: ${redact(err.message)}`)
    })
    child.on('exit', (code, signal) => this.onExit(code, signal))
  }

  /** 每条命令分配唯一 id，按响应里的 id 关联（命令处理是异步的，顺序不可依赖）。 */
  command(type: string, payload: RpcRecord = {}): Promise<RpcRecord> {
    if (this.closed || !this.child || this.exited) {
      return Promise.reject(new Error('pi RPC 未运行'))
    }
    const id = `qn-pi-${++this.counter}`
    return new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pi ${type} 超时`))
      }, this.options.commandTimeoutMs ?? 30_000)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, type, ...payload })
    })
  }

  onEvent(cb: (record: RpcRecord) => void): () => void {
    this.eventListeners.add(cb)
    return () => {
      this.eventListeners.delete(cb)
    }
  }

  onExit(cb: (info: PiExitInfo) => void): () => void {
    this.exitListeners.add(cb)
    return () => {
      this.exitListeners.delete(cb)
    }
  }

  /** 先关 stdin 让 pi 自行收尾，超时才 kill；daemon 退出时必须调用。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    const child = this.child
    // 预期关闭：置空后 exit 回调里的会话状态不会误判为崩溃。
    this.child = null
    this.rejectPending(new Error('pi RPC 已关闭'))
    try {
      child?.stdin?.end()
    } catch {
      // 进程可能已退出。
    }
    const timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        // 同上。
      }
    }, 1_000)
    timer.unref?.()
  }

  private write(record: RpcRecord): void {
    const stdin = this.child?.stdin
    if (!stdin) return
    try {
      stdin.write(`${JSON.stringify(record)}\n`)
    } catch (err) {
      this.options.log(`pi RPC 写入失败: ${redact(describe(err))}`)
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutRemainder += chunk
    if (this.stdoutRemainder.length > MAX_LINE_BYTES) {
      this.stdoutRemainder = ''
      this.options.log('pi RPC stdout 单行过长，已丢弃')
      return
    }
    const { records, remainder, invalid } = splitJsonl(this.stdoutRemainder)
    this.stdoutRemainder = remainder
    if (invalid > 0) this.options.log(`pi RPC stdout 出现 ${invalid} 行非 JSON 记录`)
    for (const record of records) {
      const kind = classifyRecord(record)
      if (kind === 'response') {
        const id = typeof record.id === 'string' ? record.id : null
        const waiter = id ? this.pending.get(id) : null
        if (waiter && id) {
          clearTimeout(waiter.timer)
          this.pending.delete(id)
          waiter.resolve(record)
        }
        continue
      }
      // 扩展 UI 请求不自动应答；pi 自带 timeout 会自行兜底。
      if (kind === 'extension_ui') continue
      for (const cb of [...this.eventListeners]) cb(record)
    }
  }

  private onStderr(chunk: string): void {
    this.stderrRemainder += chunk
    if (this.stderrRemainder.length > MAX_LINE_BYTES) {
      this.options.log(`pi stderr: ${redact(this.stderrRemainder)}`)
      this.stderrRemainder = ''
      return
    }
    let index: number
    while ((index = this.stderrRemainder.indexOf('\n')) >= 0) {
      const line = this.stderrRemainder.slice(0, index).trim()
      this.stderrRemainder = this.stderrRemainder.slice(index + 1)
      if (line) this.options.log(`pi stderr: ${redact(line)}`)
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.rejectPending(new Error('pi RPC 已退出'))
    for (const cb of [...this.exitListeners]) cb({ code, signal })
  }

  private rejectPending(err: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.pending.clear()
  }
}

function toText(chunk: Buffer | string): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
