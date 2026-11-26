// CodexTransport 适配 + 事件流重连：纯逻辑与 IO 分离，可在 Node 下注入假网关单测。
import type { CodexTransport } from '@qn/codex-client'
import type { Gateway } from './client'
import type { NativeStreamClosed, NativeStreamEvent } from './native'
import { connectionRepairReason, friendlyError, type RepairReason } from './state'
import type { AgentKind, Connection, GatewayEvent } from './types'

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type RecvMessage = {
  targetId: string
  seq: number | null
  msg: unknown
  agent?: AgentKind
}

export function seqOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 只接收当前目标（以及当前 agent）的 codex.recv；响应帧的 seq 为 null。缺 agent 的帧视为 codex（旧 server）。 */
export function filterRecv(
  payload: unknown,
  targetId: string,
  agent?: AgentKind,
): RecvMessage | null {
  if (!isRecord(payload) || payload.targetId !== targetId) return null
  if (agent !== undefined && (payload.agent ?? 'codex') !== agent) return null
  if (!Object.prototype.hasOwnProperty.call(payload, 'msg')) return null
  const agentValue =
    payload.agent === 'codex' || payload.agent === 'claude' || payload.agent === 'pi'
      ? payload.agent
      : undefined
  return {
    targetId,
    seq: seqOf(payload.seq),
    msg: payload.msg,
    ...(agentValue ? { agent: agentValue } : {}),
  }
}

export function advanceSeq(current: number | null, next: number | null): number | null {
  if (next === null || !Number.isFinite(next)) return current
  return current === null ? next : Math.max(current, next)
}

export function maxSeq(left: number | null, right: number | null): number | null {
  return advanceSeq(advanceSeq(null, left), right)
}

export function openSeq(result: unknown): number | null {
  return isRecord(result) ? seqOf(result.lastSeq) : null
}

export function attachResult(result: unknown): { lastSeq: number | null; truncated: boolean } {
  if (!isRecord(result)) return { lastSeq: null, truncated: false }
  return { lastSeq: seqOf(result.lastSeq), truncated: result.truncated === true }
}

export function isHeartbeat(event: GatewayEvent): boolean {
  return event.name === 'ping'
}

export type MobileSend = (msg: unknown) => Promise<unknown>
type MessageListener = (msg: unknown, seq: number | null) => void

export class MobileCodexTransport implements CodexTransport {
  private readonly listeners = new Set<MessageListener>()
  private readonly seen = new Set<number>()
  private lastSeq: number | null = null
  private disposed = false

  constructor(
    private readonly targetId: string,
    private readonly sendMessage: MobileSend,
    private readonly agent: AgentKind = 'codex',
  ) {}

  send(msg: unknown): void {
    if (this.disposed) return
    void this.sendMessage(msg).catch((err: unknown) => this.handleSendError(msg, err))
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    if (this.disposed) throw new Error('会话连接已切换')
    await this.sendMessage({ id, result })
  }

  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  handleRecv(payload: unknown): void {
    const recv = filterRecv(payload, this.targetId, this.agent)
    if (!recv) return
    if (recv.seq !== null) {
      if (this.seen.has(recv.seq)) return
      this.seen.add(recv.seq)
      // 还未决的审批可以从回放游标之前补来，不能简单丢弃比 lastSeq 小的帧。
      if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!)
    }
    this.lastSeq = advanceSeq(this.lastSeq, recv.seq)
    this.emit(recv.msg, recv.seq)
  }

  getLastSeq(): number | null {
    return this.lastSeq
  }

  setLastSeq(seq: number | null): void {
    this.lastSeq = advanceSeq(this.lastSeq, seq)
  }

  resetSequence(): void {
    this.lastSeq = null
    this.seen.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private handleSendError(msg: unknown, err: unknown): void {
    // 网关拒绝 codex.send 时不会回帧，补一条本地错误响应，避免 RPC 一直挂起。
    const id = isRecord(msg) ? msg.id : undefined
    if (typeof id !== 'string' && typeof id !== 'number') return
    this.emit(
      { id, error: { code: -32000, message: friendlyError(err, '发送 Codex 消息失败') } },
      null,
    )
  }

  private emit(msg: unknown, seq: number | null): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(msg, seq)
      } catch {
        // 单个监听者异常不影响其它监听者。
      }
    }
  }
}

/** 1s→30s 指数退避，避免电脑离线时手机端忙等。 */
export function reconnectDelay(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const safe = Math.max(0, Math.min(Math.floor(attempt) || 0, 20))
  return Math.min(maxMs, baseMs * 2 ** safe)
}

export type EventStreamGateway = Pick<Gateway, 'openEvents' | 'closeEvents' | 'onStream'>

export type EventStreamHandlers = {
  onEvent: (event: GatewayEvent) => void
  onOpen: (reconnected: boolean) => void
  onClose: (error: string | null) => void
  onRepair?: (reason: RepairReason, message: string) => void
}

type TimerHandle = ReturnType<typeof setTimeout>

export class EventStreamController {
  private stream: string | null = null
  private off: (() => void) | null = null
  private timer: TimerHandle | null = null
  private attempts = 0
  private generation = 0
  private stopped = true
  private lastMessageAt = 0
  private opening = false

  constructor(
    private readonly gateway: EventStreamGateway,
    private readonly getConnection: () => Connection | null,
    private readonly handlers: EventStreamHandlers,
    private readonly schedule: (fn: () => void, ms: number) => TimerHandle = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: (handle: TimerHandle) => void = (handle) => clearTimeout(handle),
  ) {}

  start(reconnected = this.attempts > 0): void {
    this.stop()
    this.stopped = false
    this.generation += 1
    this.clearTimer()
    void this.open(this.generation, reconnected)
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.clearTimer()
    this.off?.()
    this.off = null
    this.opening = false
    const stream = this.stream
    this.stream = null
    if (stream) void this.gateway.closeEvents(stream).catch(() => undefined)
  }

  wake(force = false): void {
    if (this.stopped || this.opening) return
    // 网关 20 秒一次心跳，休眠后原有 socket 可能还没报告断开。
    if (force || !this.stream || Date.now() - this.lastMessageAt > 45_000) {
      if (this.stream) this.handlers.onClose(null)
      this.start(true)
    }
  }

  private async open(generation: number, reconnected: boolean): Promise<void> {
    const conn = this.getConnection()
    if (!conn || this.stopped) return
    this.opening = true
    try {
      const stream = await this.gateway.openEvents(conn)
      if (this.stopped || generation !== this.generation) {
        void this.gateway.closeEvents(stream).catch(() => undefined)
        return
      }
      this.stream = stream
      this.lastMessageAt = Date.now()
      this.off?.()
      this.off = this.gateway.onStream((msg) => this.handleStream(stream, msg))
      this.attempts = 0
      this.handlers.onOpen(reconnected)
    } catch (err) {
      if (this.stopped || generation !== this.generation) return
      const message = friendlyError(err, '')
      const reason = connectionRepairReason(err)
      if (reason && this.handlers.onRepair) {
        this.stop()
        this.handlers.onRepair(reason, message)
        return
      }
      this.handlers.onClose(message || null)
      this.scheduleRetry()
    } finally {
      if (generation === this.generation) this.opening = false
    }
  }

  private handleStream(stream: string, msg: NativeStreamEvent | NativeStreamClosed): void {
    if (msg.stream !== stream || this.stream !== stream) return
    if ('event' in msg) {
      this.lastMessageAt = Date.now()
      if (msg.event.name === 'unauthorized' && this.handlers.onRepair) {
        this.stop()
        this.handlers.onRepair('unauthorized', '设备已被撤销，请重新配对')
        return
      }
      this.handlers.onEvent(msg.event)
      return
    }
    if (this.stopped) return
    this.stream = null
    this.off?.()
    this.off = null
    this.handlers.onClose(msg.error)
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    this.clearTimer()
    const delay = reconnectDelay(this.attempts)
    this.attempts += 1
    this.timer = this.schedule(() => {
      this.timer = null
      if (!this.stopped) void this.open(this.generation, true)
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
  }
}
