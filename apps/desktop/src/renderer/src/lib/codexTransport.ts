import { t } from '@qn/codex-client'
import type { CodexTransport } from '@qn/codex-client'
import type { AgentKind, BackendEvents } from '../../../shared/backendApi'
import { call, on } from './backend'
import { friendlyError, jsonRpcErrorCode } from './errors'
import { DEFAULT_AGENT, isAgentKind } from './agents'

type MessageListener = (msg: unknown, seq: number | null) => void

export type TransportIo = {
  send(targetId: string, agent: AgentKind, msg: unknown): Promise<unknown>
  onRecv(cb: (payload: BackendEvents['codex.recv']) => void): () => void
}

// 传输与 backend IO 分离，纯逻辑可在 Node 下注入假实现单测。
export const backendTransportIo: TransportIo = {
  send: (targetId, agent, msg) => call('codex.send', { targetId, agent, msg }),
  onRecv: (cb) => on('codex.recv', cb),
}

export type RecvMessage = { targetId: string; seq: number | null; msg: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 缺省 agent 的帧来自旧版 server / codex 默认通道，不能串到 Claude 会话。 */
export function filterRecv(
  targetId: string,
  agent: AgentKind,
  payload: unknown,
): RecvMessage | null {
  if (!isRecord(payload)) return null
  if (payload.targetId !== targetId) return null
  const eventAgent =
    payload.agent === undefined ? DEFAULT_AGENT : isAgentKind(payload.agent) ? payload.agent : null
  if (eventAgent !== agent) return null
  const seq = payload.seq
  const normalizedSeq =
    seq === null || (typeof seq === 'number' && Number.isFinite(seq)) ? (seq as number | null) : null
  if (!Object.prototype.hasOwnProperty.call(payload, 'msg')) return null
  return { targetId, seq: normalizedSeq, msg: payload.msg }
}

export function advanceSeq(current: number | null, next: number | null): number | null {
  if (next === null || !Number.isFinite(next)) return current
  return current === null ? next : Math.max(current, next)
}

export function maxSeq(left: number | null, right: number | null): number | null {
  return advanceSeq(advanceSeq(null, left), right)
}

function seqOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function openSeq(result: unknown): number | null {
  if (!isRecord(result)) return null
  return seqOf(result.lastSeq)
}

export function attachResult(result: unknown): { lastSeq: number | null; truncated: boolean } {
  if (!isRecord(result)) return { lastSeq: null, truncated: false }
  return { lastSeq: seqOf(result.lastSeq), truncated: result.truncated === true }
}

export class BackendCodexTransport implements CodexTransport {
  private readonly listeners = new Set<MessageListener>()
  private readonly unsubscribe: () => void
  private lastSeq: number | null = null
  private disposed = false

  constructor(
    private readonly targetId: string,
    private readonly agent: AgentKind = DEFAULT_AGENT,
    private readonly io: TransportIo = backendTransportIo,
  ) {
    this.unsubscribe = io.onRecv((payload) => this.handleRecv(payload))
  }

  send(msg: unknown): void {
    if (this.disposed) return
    void this.io
      .send(this.targetId, this.agent, msg)
      .catch((err: unknown) => this.handleSendError(msg, err))
  }

  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getLastSeq(): number | null {
    return this.lastSeq
  }

  setLastSeq(seq: number | null): void {
    this.lastSeq = advanceSeq(this.lastSeq, seq)
  }

  resetLastSeq(): void {
    this.lastSeq = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
  }

  private handleRecv(payload: unknown): void {
    const recv = filterRecv(this.targetId, this.agent, payload)
    if (!recv) return
    this.lastSeq = advanceSeq(this.lastSeq, recv.seq)
    this.emit(recv.msg, recv.seq)
  }

  private handleSendError(msg: unknown, err: unknown): void {
    // backend 拒绝 codex.send 时不会回帧，补一条本地错误响应，避免 RPC 一直挂起。
    const id = isRecord(msg) ? msg.id : undefined
    if (typeof id !== 'string' && typeof id !== 'number') return
    this.emit(
      {
        id,
        error: {
          code: jsonRpcErrorCode(err),
          message: friendlyError(err, t('发送 Agent 消息失败')),
        },
      },
      null,
    )
  }

  private emit(msg: unknown, seq: number | null): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(msg, seq)
      } catch (error) {
        console.error('[codex] 传输回调失败', error) // i18n-ignore: 控制台日志
      }
    }
  }
}
