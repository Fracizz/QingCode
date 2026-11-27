// 终端托管：终端归 daemon 所有、与连接解耦；连接只是订阅者。
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import type {
  TermAttachResult,
  TermDataEvt,
  TermErrorEvt,
  TermExitEvt,
  TermExitInfo,
  TermInfo,
  TermOpenResult,
  TermResizedEvt,
  TermSnapshot,
} from './types'
import type { WorkspaceContext } from '../workspace/registry'
import type { PtyBackendResolver, PtyExit, PtyProcess } from './backend'
import { OutputCoalescer, TermOutputBuffer, planAttach } from './buffer'
import {
  MAX_WRITE_QUEUE_BYTES,
  buildEnv,
  defaultShell,
  generateTermId,
  termError,
  type OpenRequest,
} from './logic'
import { createDefaultResolver } from './posix'

const FLUSH_DELAY_MS = 8
const EXITED_RETENTION_MS = 10 * 60 * 1000
const MAX_TERMINALS = 32

export interface TerminalManagerOptions {
  resolveBackend?: PtyBackendResolver
  env?: NodeJS.ProcessEnv
  now?: () => number
  randomId?: () => string
  /** 输出节流：不足一块的数据最多攒这么久再发 */
  flushDelayMs?: number
  /** 退出后保留缓冲供接回的时长 */
  retentionMs?: number
  maxTerminals?: number
  bufferBytes?: number
  /** cwd 不存在或不是目录时抛 WorkspaceError */
  checkCwd?: (cwd: string) => Promise<void>
}

interface Terminal {
  id: string
  cwd: string
  shell: string
  args: string[]
  backend: PtyProcess['backend']
  supportsResize: boolean
  pid: number | null
  startedAt: number
  cols: number
  rows: number
  proc: PtyProcess | null
  closing: boolean
  buffer: TermOutputBuffer
  coalescer: OutputCoalescer
  flushTimer: ReturnType<typeof setTimeout> | null
  retentionTimer: ReturnType<typeof setTimeout> | null
  subscribers: Set<WorkspaceContext>
  exit: TermExitInfo | null
  exitedAt: number | null
  snapshot: TermSnapshot | null
}

async function defaultCheckCwd(cwd: string): Promise<void> {
  let stat
  try {
    stat = await fsp.stat(cwd)
  } catch {
    throw termError('not_found', 'cwd 不存在')
  }
  if (!stat.isDirectory()) throw termError('params', 'cwd 不是目录')
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()
  private readonly opening = new Map<string, Promise<Terminal>>()
  private readonly watchedContexts = new WeakSet<WorkspaceContext>()
  private resolveBackend: PtyBackendResolver
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly flushDelayMs: number
  private readonly retentionMs: number
  private readonly maxTerminals: number
  private readonly bufferBytes: number | undefined
  private readonly checkCwd: (cwd: string) => Promise<void>
  private stopped = false

  constructor(options: TerminalManagerOptions = {}) {
    this.resolveBackend = options.resolveBackend ?? createDefaultResolver()
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => randomBytes(6).toString('hex'))
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS
    this.retentionMs = options.retentionMs ?? EXITED_RETENTION_MS
    this.maxTerminals = options.maxTerminals ?? MAX_TERMINALS
    this.bufferBytes = options.bufferBytes
    this.checkCwd = options.checkCwd ?? defaultCheckCwd
  }

  /** T31：Windows 上换成 ConPTY 解析器（可在内部回退到默认解析器）。 */
  setResolver(resolver: PtyBackendResolver): void {
    this.resolveBackend = resolver
  }

  /** 仍在运行（含启动中）的终端数：daemon 空闲退出判定要计入。 */
  get activeCount(): number {
    let count = this.opening.size
    for (const term of this.terminals.values()) if (term.proc) count++
    return count
  }

  async open(req: OpenRequest, ctx: WorkspaceContext): Promise<TermOpenResult> {
    if (this.stopped) throw termError('term_spawn_failed', 'daemon 正在退出')
    if (req.termId) {
      // 同一 termId 视为接回（含已退出、仍在保留期的终端）；正在启动的等它启动完再接回。
      const pendingOpen = this.opening.get(req.termId)
      const existing = this.terminals.get(req.termId) ?? (pendingOpen ? await pendingOpen : undefined)
      if (existing) {
        if (this.terminals.get(existing.id) !== existing) throw termError('term_not_found', `终端已关闭: ${existing.id}`)
        this.subscribe(existing, ctx)
        return { ...this.info(existing), created: false }
      }
    }
    // 从这里到 opening.set 之间不能有 await，否则同 termId 的并发 open 会各起一个终端。
    if (this.activeCount >= this.maxTerminals) {
      throw termError('term_limit', `同时运行的终端已达上限 ${this.maxTerminals}`)
    }
    let id = req.termId ?? generateTermId(this.randomId)
    while (!req.termId && (this.terminals.has(id) || this.opening.has(id))) id = generateTermId(this.randomId)
    const pending = this.spawn(id, req)
    this.opening.set(id, pending)
    let term: Terminal
    try {
      term = await pending
    } finally {
      this.opening.delete(id)
    }
    this.subscribe(term, ctx)
    return { ...this.info(term), created: true }
  }

  write(termId: string, data: Buffer): { acceptedBytes: number } {
    const term = this.require(termId)
    if (!term.proc || term.closing) throw termError('term_exited', '终端已退出')
    if (data.byteLength === 0) return { acceptedBytes: 0 }
    if (term.proc.pendingWriteBytes() + data.byteLength > MAX_WRITE_QUEUE_BYTES) {
      throw termError('term_backpressure', '终端写入积压，请稍后重试')
    }
    term.proc.write(data)
    return { acceptedBytes: data.byteLength }
  }

  resize(termId: string, cols: number, rows: number, ctx: WorkspaceContext): { applied: boolean; cols: number; rows: number } {
    const term = this.require(termId)
    if (!term.proc || term.closing || !term.supportsResize || !term.proc.resize(cols, rows)) {
      return { applied: false, cols: term.cols, rows: term.rows }
    }
    term.cols = cols
    term.rows = rows
    const evt: TermResizedEvt = { termId, cols, rows, by: ctx.clientId }
    this.broadcast(term, 'term.resized', evt)
    return { applied: true, cols, rows }
  }

  close(termId: string): Record<string, never> {
    const term = this.terminals.get(termId)
    if (!term) return {}
    if (term.proc) {
      // 等退出事件到达后再移除：订阅者还要收到 term.exit。
      term.closing = true
      term.proc.kill()
    } else {
      this.remove(term)
    }
    return {}
  }

  attach(termId: string, sinceSeq: number, ctx: WorkspaceContext): TermAttachResult {
    const term = this.require(termId)
    // 先订阅再取回放：合并器里尚未入缓冲的数据随后以 term.data 下发，seq 不重不漏。
    this.subscribe(term, ctx)
    const plan = planAttach(term.buffer, sinceSeq, term.snapshot)
    return {
      ...this.info(term),
      lastSeq: plan.lastSeq,
      mode: plan.mode,
      truncated: plan.truncated,
      chunks: plan.chunks,
      ...(plan.snapshot ? { snapshot: plan.snapshot } : {}),
    }
  }

  detach(termId: string, ctx: WorkspaceContext): Record<string, never> {
    this.terminals.get(termId)?.subscribers.delete(ctx)
    return {}
  }

  snapshot(termId: string, snapshot: TermSnapshot): { stored: boolean } {
    const term = this.require(termId)
    if (snapshot.seq > term.buffer.lastSeq) throw termError('params', 'snapshot.seq 超过终端当前输出进度')
    if (term.snapshot && term.snapshot.seq > snapshot.seq) return { stored: false }
    term.snapshot = snapshot
    return { stored: true }
  }

  list(): { terminals: TermInfo[] } {
    return { terminals: [...this.terminals.values()].map((term) => this.info(term)) }
  }

  /** daemon 退出时调用：结束全部终端（PTY 宿主在控制通道断开时也会自行收尾）。 */
  shutdown(): void {
    this.stopped = true
    for (const term of this.terminals.values()) {
      if (term.flushTimer) clearTimeout(term.flushTimer)
      if (term.retentionTimer) clearTimeout(term.retentionTimer)
      term.subscribers.clear()
      term.proc?.kill()
    }
    this.terminals.clear()
  }

  private async spawn(id: string, req: OpenRequest): Promise<Terminal> {
    await this.checkCwd(req.cwd)
    const backend = await this.resolveBackend(req.backend)
    const shell = req.shell ?? defaultShell(this.env)
    const proc = await backend.spawn({
      shell,
      args: req.args,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      env: buildEnv(this.env, req.env, req.cols, req.rows),
    })
    if (this.stopped) {
      proc.kill()
      throw termError('term_spawn_failed', 'daemon 正在退出')
    }
    const term: Terminal = {
      id,
      cwd: req.cwd,
      shell,
      args: req.args,
      backend: proc.backend,
      supportsResize: proc.supportsResize,
      pid: proc.pid,
      startedAt: this.now(),
      cols: req.cols,
      rows: req.rows,
      proc,
      closing: false,
      buffer: new TermOutputBuffer(this.bufferBytes !== undefined ? { maxRawBytes: this.bufferBytes } : {}),
      coalescer: new OutputCoalescer(),
      flushTimer: null,
      retentionTimer: null,
      subscribers: new Set(),
      exit: null,
      exitedAt: null,
      snapshot: null,
    }
    this.terminals.set(id, term)
    proc.onData((chunk) => this.onData(term, chunk))
    proc.onExit((exit) => this.onExit(term, exit))
    return term
  }

  private onData(term: Terminal, chunk: Buffer): void {
    for (const ready of term.coalescer.push(chunk)) this.emitChunk(term, ready)
    if (term.coalescer.pendingBytes > 0 && !term.flushTimer) {
      term.flushTimer = setTimeout(() => {
        term.flushTimer = null
        this.flush(term)
      }, this.flushDelayMs)
      term.flushTimer.unref?.()
    }
  }

  private flush(term: Terminal): void {
    if (term.flushTimer) {
      clearTimeout(term.flushTimer)
      term.flushTimer = null
    }
    const rest = term.coalescer.drain()
    if (rest) this.emitChunk(term, rest)
  }

  private emitChunk(term: Terminal, raw: Buffer): void {
    const chunk = term.buffer.append(raw)
    if (term.subscribers.size === 0) return
    const evt: TermDataEvt = { termId: term.id, seq: chunk.seq, data: chunk.data }
    this.broadcast(term, 'term.data', evt)
  }

  private onExit(term: Terminal, exit: PtyExit): void {
    this.flush(term)
    term.proc = null
    term.exit = { code: exit.code, signal: exit.signal }
    term.exitedAt = this.now()
    const evt: TermExitEvt = { termId: term.id, ...term.exit }
    this.broadcast(term, 'term.exit', evt)
    if (this.terminals.get(term.id) !== term) return
    if (term.closing) {
      this.remove(term)
      return
    }
    term.retentionTimer = setTimeout(() => this.remove(term), this.retentionMs)
    term.retentionTimer.unref?.()
  }

  private remove(term: Terminal): void {
    if (term.flushTimer) clearTimeout(term.flushTimer)
    if (term.retentionTimer) clearTimeout(term.retentionTimer)
    term.subscribers.clear()
    term.buffer.clear()
    term.snapshot = null
    if (this.terminals.get(term.id) === term) this.terminals.delete(term.id)
  }

  private subscribe(term: Terminal, ctx: WorkspaceContext): void {
    term.subscribers.add(ctx)
    if (this.watchedContexts.has(ctx)) return
    this.watchedContexts.add(ctx)
    // 连接断开只取消订阅，终端继续运行等待接回。
    ctx.onClose(() => {
      for (const t of this.terminals.values()) t.subscribers.delete(ctx)
    })
  }

  private broadcast(term: Terminal, name: string, payload: TermDataEvt | TermExitEvt | TermResizedEvt | TermErrorEvt): void {
    for (const ctx of term.subscribers) {
      try {
        ctx.emit(name, payload)
      } catch {
        // 单个连接写失败不影响其他订阅者；连接关闭时会自行清理订阅。
      }
    }
  }

  private require(termId: string): Terminal {
    const term = this.terminals.get(termId)
    if (!term) throw termError('term_not_found', `终端不存在: ${termId}`)
    return term
  }

  private info(term: Terminal): TermInfo {
    return {
      termId: term.id,
      cwd: term.cwd,
      shell: term.shell,
      args: [...term.args],
      pid: term.pid,
      backend: term.backend,
      supportsResize: term.supportsResize,
      alive: term.proc !== null,
      ...(term.exit ? { exit: { ...term.exit } } : {}),
      lastSeq: term.buffer.lastSeq,
      cols: term.cols,
      rows: term.rows,
      startedAt: term.startedAt,
      ...(term.exitedAt !== null ? { exitedAt: term.exitedAt } : {}),
    }
  }
}
