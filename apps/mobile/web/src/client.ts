// 手机网关调用适配：把 §9.2 的 /rpc、/pair、/probe、/events 映射到 T12 原生桥方法。
import { t } from '@qn/codex-client'
import { createMockPort } from './mock'
import {
  getWindowNativePort,
  installWindowCallbacks,
  NativeCallbacks,
  NativeClient,
  NativeRequestError,
  type NativeStreamClosed,
  type NativeStreamEvent,
} from './native'
import type {
  AgentKind,
  Connection,
  ConnectionDraft,
  PairResult,
  ProbeResult,
  RpcMethod,
} from './types'

type JsonRecord = Record<string, unknown>

export async function copyText(text: string): Promise<void> {
  if (getWindowNativePort()) await callDevice('clipboard.write', { text })
  else await navigator.clipboard.writeText(text)
}
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 网关可能直接回裸结果，也可能回 {ok,result} 信封；原生层已解一层，这里再兜一层。 */
export function unwrapRpcResult(value: unknown): unknown {
  if (!isRecord(value) || value.t !== undefined) return value
  if (value.ok === true && Object.prototype.hasOwnProperty.call(value, 'result')) return value.result
  if (value.ok === false || (value.error !== undefined && value.error !== null)) {
    const detail = isRecord(value.error) ? value.error : null
    const message =
      (typeof detail?.message === 'string' ? detail.message : null) ??
      (typeof value.error === 'string' ? value.error : null) ??
      (typeof value.message === 'string' ? value.message : null) ??
      t('电脑拒绝了请求')
    const code = typeof detail?.code === 'string' ? detail.code : 'server'
    throw new NativeRequestError(message, code)
  }
  return value
}

export interface StreamMessageHandler {
  (msg: NativeStreamEvent | NativeStreamClosed): void
}

export interface Gateway {
  probe(host: string, port: number): Promise<ProbeResult>
  pair(draft: ConnectionDraft, deviceName: string): Promise<PairResult>
  rpc<T>(
    conn: Connection,
    method: RpcMethod,
    params?: unknown,
    agent?: AgentKind,
    timeoutMs?: number,
  ): Promise<T>
  openEvents(conn: Connection): Promise<string>
  closeEvents(stream: string): Promise<void>
  readClipboard(): Promise<string>
  storageGet(key: string): Promise<string | null>
  storageSet(key: string, value: string | null): Promise<void>
  onStream(cb: StreamMessageHandler): () => void
}

type NativeCaller = {
  call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onStream(cb: StreamMessageHandler): () => void
}

function connectionParams(conn: Connection): JsonRecord {
  return { host: conn.host, port: conn.port, fp: conn.fp, token: conn.token }
}

export class GatewayClient implements Gateway {
  constructor(private readonly native: NativeCaller) {}

  device<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.native.call<T>(method, params, timeoutMs)
  }

  probe(host: string, port: number): Promise<ProbeResult> {
    return this.native.call<ProbeResult>('probe', { host, port })
  }

  pair(draft: ConnectionDraft, deviceName: string): Promise<PairResult> {
    return this.native.call<PairResult>('pair', {
      host: draft.host,
      port: draft.port,
      fp: draft.fp,
      code: draft.code,
      deviceName,
    })
  }

  async rpc<T>(
    conn: Connection,
    method: RpcMethod,
    params: unknown = {},
    agent?: AgentKind,
    timeoutMs?: number,
  ): Promise<T> {
    const request: JsonRecord = { ...connectionParams(conn), method, params }
    if (agent) request.agent = agent
    const result =
      timeoutMs === undefined
        ? await this.native.call<unknown>('rpc', request)
        : await this.native.call<unknown>('rpc', request, timeoutMs)
    return unwrapRpcResult(result) as T
  }

  async openEvents(conn: Connection): Promise<string> {
    const result = await this.native.call<unknown>('events.open', connectionParams(conn))
    if (typeof result !== 'string' || result === '') {
      throw new NativeRequestError(t('事件流建立失败'), 'events')
    }
    return result
  }

  async closeEvents(stream: string): Promise<void> {
    await this.native.call('events.close', { stream })
  }

  readClipboard(): Promise<string> {
    return this.native.call<string>('clipboard.read', {})
  }

  async storageGet(key: string): Promise<string | null> {
    const result = await this.native.call<unknown>('storage.get', { key })
    return typeof result === 'string' ? result : null
  }

  async storageSet(key: string, value: string | null): Promise<void> {
    await this.native.call('storage.set', { key, value })
  }

  onStream(cb: StreamMessageHandler): () => void {
    return this.native.onStream(cb)
  }
}

let singleton: Gateway | null = null
let usingMock = false

export function createGateway(): Gateway {
  const hub = new NativeCallbacks()
  const real = getWindowNativePort()
  usingMock = real === null
  installWindowCallbacks(hub)
  const port = real ?? createMockPort(hub)
  return new GatewayClient(new NativeClient(port, hub))
}

export function getGateway(): Gateway {
  if (!singleton) singleton = createGateway()
  return singleton
}

export function callDevice<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const gateway = getGateway()
  if (!(gateway instanceof GatewayClient)) {
    return Promise.reject(new NativeRequestError(t('此功能需要 Android 应用'), 'native_unavailable'))
  }
  return gateway.device<T>(method, params, timeoutMs)
}

/** 仅供单测注入假网关。 */
export function setGateway(gateway: Gateway | null): void {
  singleton = gateway
}

export function isMockGateway(): boolean {
  return usingMock
}
