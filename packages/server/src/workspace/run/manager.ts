import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type {
  RunDataEvt,
  RunExitEvt,
  RunInfo,
  RunOs,
  RunOutputResult,
  RunStartParams,
} from './types'
import { WorkspaceError, type WorkspaceContext } from '../registry'
import { RunOutputBuffer } from './buffer'
import {
  buildSpawnPlan,
  findInPath,
  mergeEnv,
  platformToOs,
  resolveTaskForOs,
  resolveWorkdir,
  type CommandTools,
} from './logic'

/** 结束的 run 只保留最近这么多条，运行中的不受限。 */
export const KEEP_ENDED_RUNS = 20
/** 合并小块输出再推送，避免逐字节刷屏时 evt 风暴。 */
const FLUSH_DELAY_MS = 16
const FLUSH_BYTES = 64 * 1024
/** POSIX：SIGTERM 后多久补 SIGKILL。 */
const KILL_GRACE_MS = 3000
/** 进程已退出但孙进程仍占着管道时，最多再等这么久就宣布结束。 */
const CLOSE_GRACE_MS = 2000

type Stream = 'stdout' | 'stderr'

type RunRecord = {
  info: RunInfo
  child: ChildProcess
  buffer: RunOutputBuffer
  decoders: Record<Stream, StringDecoder>
  pending: { stream: Stream; data: string } | null
  flushTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  finished: boolean
}

export type RunManagerOptions = {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  spawn?: typeof nodeSpawn
  log?: (message: string) => void
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>()
  private readonly subscribers = new Set<WorkspaceContext>()
  private readonly platform: NodeJS.Platform
  private readonly os: RunOs
  private readonly env: Record<string, string | undefined>
  private readonly spawnImpl: typeof nodeSpawn
  private readonly log: (message: string) => void

  constructor(options: RunManagerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.os = platformToOs(this.platform)
    this.env = options.env ?? process.env
    this.spawnImpl = options.spawn ?? nodeSpawn
    this.log = options.log ?? (() => undefined)
  }

  get targetOs(): RunOs {
    return this.os
  }

  /**
   * WorkspaceContext.emit 只发给本连接；调用过 run.* 的连接都登记为订阅者，
   * 输出与退出事件逐个转发，实现"广播给所有客户端"。
   */
  subscribe(ctx: WorkspaceContext): void {
    if (this.subscribers.has(ctx)) return
    this.subscribers.add(ctx)
    ctx.onClose(() => this.subscribers.delete(ctx))
  }

  activeCount(): number {
    let count = 0
    for (const record of this.runs.values()) if (!record.finished) count++
    return count
  }

  list(): RunInfo[] {
    return [...this.runs.values()]
      .map((record) => ({ ...record.info }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  output(runId: string, sinceSeq: number): RunOutputResult {
    const record = this.runs.get(runId)
    if (!record) throw new WorkspaceError('not_found', '运行记录不存在或已被清理')
    // 未推送的合并块也要算进去，否则补齐会漏掉最后几十毫秒的输出。
    this.flush(record)
    const { chunks, truncated } = record.buffer.since(sinceSeq)
    return { runId, chunks, truncated, lastSeq: record.buffer.lastSeq, running: !record.finished }
  }

  async start(params: RunStartParams): Promise<{ runId: string; pid: number | null }> {
    const task = resolveTaskForOs(params.task, this.os)
    const windows = this.os === 'windows'
    const tools: CommandTools = {
      which: (name) => findInPath(name, this.env, windows, isFile),
      ...(windows ? { comspec: envValue(this.env, 'ComSpec', true) } : {}),
    }
    const plan = buildSpawnPlan(task, this.os, tools)
    const workdir = resolveWorkdir(params.cwd, task.cwd)
    try {
      if (!(await fs.promises.stat(workdir)).isDirectory()) throw new Error('not dir')
    } catch {
      throw new WorkspaceError('not_found', `工作目录不存在：${workdir}`)
    }

    const options: SpawnOptions = {
      cwd: workdir,
      env: mergeEnv(this.env, task.env, windows),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // POSIX 独立进程组：停止时整组发信号，连带 npm/pnpm 拉起的子进程。
      detached: !windows,
    }
    const child = this.spawnImpl(plan.file, plan.args, options)
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        child.off('spawn', onSpawn)
        reject(new WorkspaceError('not_found', `无法启动 ${plan.file}：${err.message}`))
      }
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      child.once('error', onError)
      child.once('spawn', onSpawn)
    })

    const runId = randomUUID()
    const info: RunInfo = {
      runId,
      label: params.label ?? task.target,
      cwd: params.cwd,
      workdir,
      command: plan.command,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      lastSeq: 0,
    }
    if (params.key) info.key = params.key
    const record: RunRecord = {
      info,
      child,
      buffer: new RunOutputBuffer(),
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      pending: null,
      flushTimer: null,
      killTimer: null,
      finished: false,
    }
    this.runs.set(runId, record)
    this.log(`run.start ${runId} pid=${info.pid ?? '-'}`)

    child.stdout?.on('data', (buf: Buffer) => this.append(record, 'stdout', record.decoders.stdout.write(buf)))
    child.stderr?.on('data', (buf: Buffer) => this.append(record, 'stderr', record.decoders.stderr.write(buf)))
    child.on('error', (err) => this.log(`run ${runId} 进程错误：${err.message}`))

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let closeTimer: ReturnType<typeof setTimeout> | null = null
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      closeTimer = setTimeout(() => this.finish(record, code, signal), CLOSE_GRACE_MS)
      closeTimer.unref?.()
    })
    child.once('close', (code, signal) => {
      if (closeTimer) clearTimeout(closeTimer)
      const final = exitInfo ?? { code, signal }
      this.finish(record, final.code, final.signal)
    })
    return { runId, pid: info.pid }
  }

  async stop(runId: string): Promise<void> {
    const record = this.runs.get(runId)
    if (!record || record.finished) return
    const pid = record.child.pid
    if (pid === undefined) return
    if (this.os === 'windows') {
      // 只杀 cmd.exe 会留下 node/pnpm 等孙进程，必须 /T 连同进程树一起结束。
      await new Promise<void>((resolve) => {
        const killer = this.spawnImpl('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
        const timer = setTimeout(resolve, 5000)
        killer.once('error', () => {
          clearTimeout(timer)
          record.child.kill()
          resolve()
        })
        killer.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      return
    }
    signalGroup(record.child, pid, 'SIGTERM')
    if (record.killTimer) return
    record.killTimer = setTimeout(() => {
      record.killTimer = null
      if (!record.finished) signalGroup(record.child, pid, 'SIGKILL')
    }, KILL_GRACE_MS)
    record.killTimer.unref?.()
  }

  /** 测试与 daemon 退出时用：结束全部运行中的任务。 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.stop(runId)))
  }

  private append(record: RunRecord, stream: Stream, text: string): void {
    if (!text || record.finished) return
    if (record.pending && record.pending.stream !== stream) this.flush(record)
    if (record.pending) record.pending.data += text
    else record.pending = { stream, data: text }
    if (record.pending.data.length >= FLUSH_BYTES) {
      this.flush(record)
      return
    }
    if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => {
        record.flushTimer = null
        this.flush(record)
      }, FLUSH_DELAY_MS)
    }
  }

  private flush(record: RunRecord): void {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    const pending = record.pending
    if (!pending) return
    record.pending = null
    const chunk = record.buffer.push(pending.stream, pending.data)
    record.info.lastSeq = chunk.seq
    const payload: RunDataEvt = { runId: record.info.runId, ...chunk }
    this.broadcast('run.data', payload)
  }

  private finish(record: RunRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (record.finished) return
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = record.decoders[stream].end()
      if (rest) this.append(record, stream, rest)
    }
    this.flush(record)
    record.finished = true
    if (record.killTimer) {
      clearTimeout(record.killTimer)
      record.killTimer = null
    }
    record.info.exitCode = code
    record.info.signal = signal
    record.info.endedAt = Date.now()
    this.log(`run.exit ${record.info.runId} code=${code ?? '-'} signal=${signal ?? '-'}`)
    const payload: RunExitEvt = { runId: record.info.runId, exitCode: code, signal }
    this.broadcast('run.exit', payload)
    this.prune()
  }

  private prune(): void {
    const ended = [...this.runs.values()]
      .filter((record) => record.finished)
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0))
    for (const record of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED_RUNS))) {
      this.runs.delete(record.info.runId)
    }
  }

  private broadcast(name: string, payload: unknown): void {
    for (const ctx of this.subscribers) {
      try {
        ctx.emit(name, payload)
      } catch {
        // 连接已断开：onClose 会把它移出订阅集合。
      }
    }
  }
}

function signalGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // 进程组已不存在或无权限时退回只杀子进程本身。
    try {
      child.kill(signal)
    } catch {
      // 已退出。
    }
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function envValue(env: Record<string, string | undefined>, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name]
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}
