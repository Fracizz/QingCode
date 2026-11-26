import {
  isBackendEventMessage,
  isBackendResponse,
  type BackendEvent,
  type BackendEvents,
  type BackendMethod,
  type BackendParams,
  type BackendResult,
  type TypedRequest,
} from '../../../shared/backendApi'

export class BackendCallError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'BackendCallError'
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const pending = new Map<number, Pending>()
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const waiters: Array<(port: MessagePort) => void> = []
let port: MessagePort | null = null
let nextId = 1
let fallbackTimer: ReturnType<typeof setTimeout> | null = null
const restartListeners = new Set<() => void>()

/** 已建立的通道被换掉（backend 进程崩溃后重启）时通知，订阅方据此丢弃过期状态。 */
export function onBackendRestart(cb: () => void): () => void {
  restartListeners.add(cb)
  return () => {
    restartListeners.delete(cb)
  }
}

function usePort(next: MessagePort): void {
  const replaced = port !== null && port !== next
  if (port && port !== next) {
    for (const request of pending.values()) {
      request.reject(new BackendCallError('port_replaced', 'backend 通道已重建，请重试'))
    }
    pending.clear()
    try {
      port.close()
    } catch {
      // 旧通道可能已关闭。
    }
  }
  port = next
  next.onmessage = (event) => handle(event.data as unknown)
  next.start()
  for (const waiter of waiters.splice(0)) waiter(next)
  // 必须在新通道就绪后通知，订阅方的重连请求才能发得出去。
  if (replaced) for (const cb of [...restartListeners]) cb()
}

function handle(data: unknown): void {
  if (isBackendResponse(data)) {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (data.ok) request.resolve(data.result)
    else request.reject(new BackendCallError(String(data.error.code), data.error.message))
    return
  }
  if (isBackendEventMessage(data)) {
    const bucket = listeners.get(data.name)
    if (!bucket) return
    for (const cb of [...bucket]) {
      try {
        cb(data.payload)
      } catch (err) {
        console.error('[backend] 事件回调失败', err)
      }
    }
  }
}

function ensurePort(): Promise<MessagePort> {
  if (port) return Promise.resolve(port)
  return new Promise((resolve) => waiters.push(resolve))
}

/** 进场页据此区分"等待后台通道"与"加载数据"两个阶段。 */
export function whenBackendReady(): Promise<void> {
  return ensurePort().then(() => undefined)
}

export function call<M extends BackendMethod>(
  method: M,
  ...args: BackendParams<M> extends void ? [] : [params: BackendParams<M>]
): Promise<BackendResult<M>> {
  const params = args[0] as BackendParams<M> | undefined
  return ensurePort().then(
    (active) =>
      new Promise<BackendResult<M>>((resolve, reject) => {
        const id = nextId++
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        const message: TypedRequest<M> = {
          t: 'req',
          id,
          method,
          params: params as BackendParams<M>,
        }
        active.postMessage(message)
      })
  )
}

export function on<N extends BackendEvent>(
  name: N,
  cb: (payload: BackendEvents[N]) => void
): () => void {
  let bucket = listeners.get(name)
  if (!bucket) {
    bucket = new Set()
    listeners.set(name, bucket)
  }
  const listener = cb as (payload: unknown) => void
  bucket.add(listener)
  return () => {
    listeners.get(name)?.delete(listener)
  }
}

// vitest 在 Node 下加载纯逻辑模块时没有 window，避免副作用报错。
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    // preload 在隔离世界转发，event.source 在不同 Electron 版本下可能不是 window。
    if (event.data !== 'qn-backend-port') return
    const transferred = event.ports[0]
    if (!transferred) return
    usePort(transferred)
    if (fallbackTimer) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  })

  // preload 的转发若早于页面监听器注册，主动请 main 重建一次通道。
  // main 在 did-finish-load（≈ 页面 load）后才投递 port，所以兜底计时要从 load 起算：
  // 早先从模块执行起算 200ms，包体变大后 load 晚于 200ms，会多建一条通道，
  // 第二个 port 到达时把已在途的启动请求全部以 port_replaced 拒掉（侧栏"通信通道已重建"）。
  const scheduleFallback = () => {
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null
      if (!port) window.qn?.requestPort()
    }, 600)
  }
  if (document.readyState === 'complete') scheduleFallback()
  else window.addEventListener('load', scheduleFallback, { once: true })
}
