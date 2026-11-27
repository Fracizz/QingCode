// T12 原生桥：request 同步返回 ack，真正结果 / 事件经 window.__qnNativeCallback 异步回传。
import type { GatewayEvent } from './types'

export interface QnNativeLike {
  request(json: string): string
}

export type NativePort = QnNativeLike

export type NativeAck = { queued: boolean; error?: string }

export type NativeReplyOk = { id: number; ok: true; result: unknown }
export type NativeReplyErr = { id: number; ok: false; error: string; code?: string }
export type NativeReply = NativeReplyOk | NativeReplyErr
export type NativeStreamEvent = { stream: string; event: GatewayEvent }
export type NativeStreamClosed = { stream: string; closed: true; error: string | null }
export type NativeCallbackMessage = NativeReply | NativeStreamEvent | NativeStreamClosed

declare global {
  interface Window {
    QnNative?: QnNativeLike
    __qnNativeCallback?: (json: string) => void
    __qnBack?: () => boolean
  }
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 原生回调可能是回包、流事件或流关闭；格式不对的消息直接丢弃，避免误解析成回包。 */
export function toCallbackMessage(value: unknown): NativeCallbackMessage | null {
  if (!isRecord(value)) return null
  if (typeof value.id === 'number' && typeof value.ok === 'boolean') {
    if (value.ok === true) return { id: value.id, ok: true, result: value.result }
    const code = typeof value.code === 'string' ? value.code : undefined
    const error = typeof value.error === 'string' ? value.error : '请求失败'
    return { id: value.id, ok: false, error, ...(code ? { code } : {}) }
  }
  if (typeof value.stream === 'string' && isRecord(value.event)) {
    const event = value.event as GatewayEvent
    return {
      stream: value.stream,
      event: { name: typeof event.name === 'string' ? event.name : '', payload: event.payload },
    }
  }
  if (typeof value.stream === 'string' && value.closed === true) {
    return {
      stream: value.stream,
      closed: true,
      error: typeof value.error === 'string' ? value.error : null,
    }
  }
  return null
}

export function parseNativeAck(json: string): NativeAck | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!isRecord(parsed) || typeof parsed.queued !== 'boolean') return null
    const error = typeof parsed.error === 'string' ? parsed.error : undefined
    return { queued: parsed.queued, ...(error ? { error } : {}) }
  } catch {
    // 某些桥实现只返回空串，视为已排队，等异步回包。
    return null
  }
}

export class NativeRequestError extends Error {
  constructor(
    message: string,
    readonly code = 'internal',
  ) {
    super(message)
    this.name = 'NativeRequestError'
  }
}

export class NativeCallbacks {
  private readonly listeners = new Set<(msg: NativeCallbackMessage) => void>()

  on(cb: (msg: NativeCallbackMessage) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  deliver(json: string): void {
    const message = toCallbackMessage(safeParse(json))
    if (!message) return
    for (const cb of [...this.listeners]) {
      try {
        cb(message)
      } catch {
        // 单个订阅者异常不能阻断其它订阅者。
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch {
    return null
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

export class NativeClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly off: () => void

  constructor(
    private readonly port: NativePort,
    private readonly hub: NativeCallbacks,
    private readonly timeoutMs = 40_000,
  ) {
    this.off = hub.on((msg) => this.handle(msg))
  }

  call<T>(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (value: unknown) => void, reject }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new NativeRequestError('请求超时，请检查电脑是否在线', 'timeout'))
          }
        }, timeoutMs)
      }
      this.pending.set(id, pending)
      let ack: NativeAck | null = null
      try {
        ack = parseNativeAck(this.port.request(JSON.stringify({ id, method, params })))
      } catch (err) {
        this.fail(id, err)
        return
      }
      if (ack && !ack.queued) {
        this.fail(id, new NativeRequestError(ack.error ?? '原生桥拒绝请求', 'native'))
      }
    })
  }

  onStream(cb: (msg: NativeStreamEvent | NativeStreamClosed) => void): () => void {
    return this.hub.on((msg) => {
      if ('closed' in msg || 'event' in msg) cb(msg)
    })
  }

  dispose(): void {
    this.off()
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new NativeRequestError('原生桥已关闭', 'closed'))
    }
    this.pending.clear()
  }

  private handle(msg: NativeCallbackMessage): void {
    if (!('ok' in msg)) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.clearPending(msg.id)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new NativeRequestError(msg.error, msg.code ?? 'internal'))
  }

  private fail(id: number, error: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.clearPending(id)
    pending.reject(error)
  }

  private clearPending(id: number): void {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
  }
}

/** Android 只调用这个全局函数；浏览器开发模式也会安装，便于 mock 统一走 hub。 */
export function installWindowCallbacks(hub: NativeCallbacks): () => void {
  if (typeof window === 'undefined') return () => undefined
  const previous = window.__qnNativeCallback
  const callback = (json: string): void => hub.deliver(json)
  window.__qnNativeCallback = callback
  return () => {
    if (window.__qnNativeCallback === callback) window.__qnNativeCallback = previous
  }
}

export function getWindowNativePort(): NativePort | null {
  if (typeof window === 'undefined') return null
  return window.QnNative ?? null
}
