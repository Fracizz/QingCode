import { randomUUID } from 'node:crypto'
import { isJsonRpcRequest, isJsonRpcResponse, type JsonRpcResponse } from '@qn/protocol'
import type {
  BackendEvent,
  BackendEvents,
  BackendMethod,
  BackendParams,
  BackendResult,
  BackendError,
} from '../shared/backendApi'
import { isBackendRequest } from '../shared/backendApi'

export class RouterError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RouterError'
  }
}

// 方法注册集中在 src/backend/index.ts 的 router 实例；T5/T8 在那里补注册新方法。

// 只依赖 MessagePort 的最小接口，便于纯逻辑单测与 T5 复用。
export interface WirePort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  start(): void
  close(): void
}

type AnyHandler = (params: unknown) => Promise<unknown> | unknown
type CodexRecv = BackendEvents['codex.recv']

export type CodexReplyRoute = {
  signal?: AbortSignal
  receive(payload: CodexRecv): void
}

const CODEX_REPLY_TIMEOUT_MS = 30_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const agentOf = (value: unknown): NonNullable<CodexRecv['agent']> =>
  value === 'claude' || value === 'pi' ? value : 'codex'

export type MethodHandler<M extends BackendMethod> = (
  params: BackendParams<M>
) => Promise<BackendResult<M>> | BackendResult<M>

export function toWireError(err: unknown): BackendError {
  if (err instanceof RouterError) return { code: err.code, message: err.message }
  if (err instanceof Error) return { code: 'internal', message: err.message }
  return { code: 'internal', message: String(err) }
}

export class BackendRouter {
  private readonly handlers = new Map<string, AnyHandler>()
  private readonly emitListeners = new Set<(name: string, payload: unknown) => void>()
  private readonly codexReplyPrefix = `qn-mobile-rpc:${randomUUID()}:`
  private codexReplySequence = 0
  private readonly codexReplies = new Map<string, {
    targetId: string
    agent: NonNullable<CodexRecv['agent']>
    deliver(payload: CodexRecv, msg: JsonRpcResponse): void
  }>()
  private port: WirePort | null = null

  register<M extends BackendMethod>(method: M, handler: MethodHandler<M>): void {
    this.handlers.set(method, handler as AnyHandler)
  }

  registerNotImplemented(methods: readonly BackendMethod[]): void {
    for (const method of methods) {
      // 后续任务注册了真实实现时，占位不应把它覆盖掉（与注册顺序无关）。
      if (this.handlers.has(method)) continue
      this.register(method, () => {
        throw new RouterError('not_implemented', `${method} 尚未实现`)
      })
    }
  }

  // 手机网关通过同一组 handler 调用 backend 方法，不能绕开参数校验与 RouterError 映射。
  async invoke(method: string, params: unknown, route?: CodexReplyRoute): Promise<unknown> {
    const handler = this.handlers.get(method)
    if (!handler) throw new RouterError('unknown_method', `未知方法：${method}`)
    if (method !== 'codex.send' || !route || !isRecord(params) || typeof params.targetId !== 'string' ||
        !isJsonRpcRequest(params.msg)) return await handler(params)

    // 手机和桌面共用 daemon 通道，原始请求 id 可以相同。
    const id = `${this.codexReplyPrefix}${++this.codexReplySequence}`
    const originalId = params.msg.id
    const sendParams = { ...params, msg: { ...params.msg, id } }
    if (route.signal?.aborted) return await handler(sendParams)

    const cleanup = () => {
      this.codexReplies.delete(id)
      clearTimeout(timer)
      route.signal?.removeEventListener('abort', cleanup)
    }
    const timer = setTimeout(cleanup, CODEX_REPLY_TIMEOUT_MS)
    timer.unref()
    route.signal?.addEventListener('abort', cleanup, { once: true })
    this.codexReplies.set(id, {
      targetId: params.targetId,
      agent: agentOf(params.agent),
      deliver: (payload, msg) => {
        cleanup()
        route.receive({ ...payload, msg: { ...msg, id: originalId } })
      },
    })
    try {
      return await handler(sendParams)
    } catch (err) {
      cleanup()
      throw err
    }
  }

  onEmit(listener: (name: string, payload: unknown) => void): () => void {
    this.emitListeners.add(listener)
    return () => {
      this.emitListeners.delete(listener)
    }
  }

  // main 重建通道时会传新 port；旧 port 关闭后其上的请求也不再回包。
  attachPort(port: WirePort): void {
    const previous = this.port
    this.port = port
    if (previous && previous !== port) {
      try {
        previous.close()
      } catch {
        // 已关闭的 port 再次 close 会抛错，不影响新通道。
      }
    }
    port.on('message', (e) => void this.handleMessage(e.data, port))
    port.start()
  }

  emit<N extends BackendEvent>(name: N, payload: BackendEvents[N]): void {
    if (name === 'codex.recv' && this.deliverCodexReply(payload as CodexRecv)) return
    this.port?.postMessage({ t: 'evt', name, payload })
    // 旁路订阅者异常不能影响 renderer 主通道，也不能阻断其它订阅者。
    for (const listener of [...this.emitListeners]) {
      try {
        listener(name, payload)
      } catch {
        // 手机网关等旁路自行处理自己的错误。
      }
    }
  }

  private deliverCodexReply(payload: CodexRecv): boolean {
    const { msg } = payload
    if (payload.seq !== null || !isJsonRpcResponse(msg) || typeof msg.id !== 'string' ||
        !msg.id.startsWith(this.codexReplyPrefix)) return false
    const pending = this.codexReplies.get(msg.id)
    if (pending && pending.targetId === payload.targetId && pending.agent === agentOf(payload.agent)) {
      try {
        pending.deliver(payload, msg)
      } catch {
        // 手机断开时的投递失败不能影响 daemon 通道。
      }
    }
    // 已超时或断开的回复仍属于手机，不能掉回共享事件总线。
    return true
  }

  async handleMessage(data: unknown, source?: WirePort): Promise<void> {
    if (!isBackendRequest(data)) return
    const replyPort = source ?? this.port
    let response: { t: 'res'; id: number } & (
      | { ok: true; result: unknown }
      | { ok: false; error: BackendError }
    )
    try {
      const result = await this.invoke(data.method, data.params)
      response = { t: 'res', id: data.id, ok: true, result }
    } catch (err) {
      response = { t: 'res', id: data.id, ok: false, error: toWireError(err) }
    }
    if (replyPort && replyPort === this.port) replyPort.postMessage(response)
  }
}
