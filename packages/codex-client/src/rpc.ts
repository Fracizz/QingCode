import type {
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountParams,
  GetAccountRateLimitsParams,
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageParams,
  GetAccountTokenUsageResponse,
  GetAccountResponse,
  ModelListParams,
  ModelListResponse,
  RequestId,
  SkillsListParams,
  SkillsListResponse,
  ServerNotification,
  ServerRequest,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadDeleteParams,
  ThreadDeleteResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadItemsListParams,
  ThreadItemsListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadRevertParams,
  ThreadRevertResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from './codex-types'

export type ClientRequestMap = {
  'thread/list': { params: ThreadListParams; result: ThreadListResponse }
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse }
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse }
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse }
  'thread/turns/list': { params: ThreadTurnsListParams; result: ThreadTurnsListResponse }
  'thread/items/list': { params: ThreadItemsListParams; result: ThreadItemsListResponse }
  'thread/name/set': { params: ThreadSetNameParams; result: ThreadSetNameResponse }
  'thread/unsubscribe': { params: ThreadUnsubscribeParams; result: ThreadUnsubscribeResponse }
  'thread/archive': { params: ThreadArchiveParams; result: ThreadArchiveResponse }
  'thread/unarchive': { params: ThreadUnarchiveParams; result: ThreadUnarchiveResponse }
  'thread/compact/start': { params: ThreadCompactStartParams; result: ThreadCompactStartResponse }
  'thread/delete': { params: ThreadDeleteParams; result: ThreadDeleteResponse }
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse }
  'thread/revert': { params: ThreadRevertParams; result: ThreadRevertResponse }
  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse }
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse }
  'model/list': { params: ModelListParams; result: ModelListResponse }
  'skills/list': { params: SkillsListParams; result: SkillsListResponse }
  'account/read': { params: GetAccountParams; result: GetAccountResponse }
  'account/rateLimits/read': {
    params: GetAccountRateLimitsParams
    result: GetAccountRateLimitsResponse
  }
  'account/rateLimitResetCredit/consume': {
    params: ConsumeAccountRateLimitResetCreditParams
    result: ConsumeAccountRateLimitResetCreditResponse
  }
  'account/usage/read': { params: GetAccountTokenUsageParams; result: GetAccountTokenUsageResponse }
  // QingCode 桥接扩展（docs/tasks/T40-paseo-alignment.md）；回包字段由 agentControls.ts 校验。
  'qingcode/backgroundTasks/list': { params: { threadId: string }; result: { tasks?: unknown } }
  'qingcode/backgroundTasks/stop': { params: { threadId: string; taskId: string }; result: unknown }
  'qingcode/commands/list': { params: { threadId: string }; result: { commands?: unknown } }
  'qingcode/files/rewind': { params: { threadId: string; turnId: string; dryRun: boolean }; result: unknown }
}

export interface CodexTransport {
  send(msg: unknown): void
  onMessage(cb: (msg: unknown, seq: number | null) => void): () => void
}

export class CodexRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
    this.data = data
  }
}

type JsonRecord = Record<string, unknown>

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMessage(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asRequestId(value: unknown): RequestId | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

export class CodexRpc {
  private readonly transport: CodexTransport
  private readonly timeoutMs: number
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly notificationListeners = new Set<(n: ServerNotification) => void>()
  private readonly serverRequestListeners = new Set<(r: ServerRequest) => void>()
  private unsubscribe: (() => void) | null = null
  private nextId = 1
  private disposed = false

  constructor(t: CodexTransport, opts: { timeoutMs?: number } = {}) {
    this.transport = t
    this.timeoutMs = opts.timeoutMs ?? 0
    const unsubscribe = t.onMessage((msg) => this.handleMessage(msg))
    this.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
  }

  request<M extends keyof ClientRequestMap>(
    method: M,
    params: ClientRequestMap[M]['params'],
  ): Promise<ClientRequestMap[M]['result']> {
    if (this.disposed) return Promise.reject(new Error('CodexRpc disposed'))

    const id = `c${this.nextId++}`
    return new Promise<ClientRequestMap[M]['result']>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as unknown as (value: unknown) => void,
        reject,
      }
      if (this.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new CodexRpcError(`Codex request timed out: ${method}`, -32000))
          }
        }, this.timeoutMs)
      }
      this.pending.set(id, pending)

      const message: JsonRecord = { id, method }
      if (params !== undefined) message.params = params
      try {
        this.transport.send(message)
      } catch (error) {
        this.clearPending(id)
        reject(error)
      }
    })
  }

  onNotification(cb: (n: ServerNotification) => void): () => void {
    this.notificationListeners.add(cb)
    return () => {
      this.notificationListeners.delete(cb)
    }
  }

  onServerRequest(cb: (r: ServerRequest) => void): () => void {
    this.serverRequestListeners.add(cb)
    return () => {
      this.serverRequestListeners.delete(cb)
    }
  }

  respond(id: RequestId, result: unknown): void {
    if (this.disposed) return
    this.transport.send({ id, result })
  }

  respondError(id: RequestId, code: number, message: string): void {
    if (this.disposed) return
    this.transport.send({ id, error: { code, message } })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(new Error('CodexRpc disposed'))
    }
    this.pending.clear()
    this.notificationListeners.clear()
    this.serverRequestListeners.clear()
  }

  private handleMessage(raw: unknown): void {
    const msg = parseMessage(raw)
    if (!msg) return
    const id = asRequestId(msg.id)

    if (id !== null && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.clearPending(id)
      if ('error' in msg) {
        const error = isRecord(msg.error) ? msg.error : {}
        const code = typeof error.code === 'number' ? error.code : -32000
        const message = typeof error.message === 'string' ? error.message : 'Codex request failed'
        pending.reject(new CodexRpcError(message, code, error.data))
        return
      }
      pending.resolve(msg.result)
      return
    }

    if (typeof msg.method !== 'string') return
    if (id !== null) {
      for (const cb of [...this.serverRequestListeners]) cb(msg as unknown as ServerRequest)
      return
    }
    for (const cb of [...this.notificationListeners]) cb(msg as unknown as ServerNotification)
  }

  private clearPending(id: RequestId): void {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(id)
  }
}
