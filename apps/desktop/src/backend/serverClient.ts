import type { AgentKind } from '../shared/backendApi'
import {
  PROTOCOL_VERSION,
  attachFramedStream,
  parseServerMessage,
  type FramedConnection,
  type FramedStream,
} from '@qn/protocol'

export class ServerClientError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ServerClientError'
  }
}

export interface ServerClientHandlers {
  onEvent(name: string, payload: unknown): void
  onCodexRecv(seq: number | null, msg: unknown, agent: AgentKind): void
  onClose(err?: Error): void
}

export interface ServerClientOptions {
  stream: FramedStream
  token: string
  clientName?: string
  clientVersion?: string
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  handlers: ServerClientHandlers
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface HandshakeWaiter {
  resolve(client: ServerClient): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/** 与传输无关的 server 客户端：握手、req/res、事件转发、codex 透传。 */
export class ServerClient {
  private readonly conn: FramedConnection
  private readonly pending = new Map<number, Pending>()
  private readonly handshake: Promise<ServerClient>
  private handshakeWaiter: HandshakeWaiter | null = null
  private welcome: { serverVersion: string; pid: number } | null = null
  private nextId = 1
  private closed = false

  private constructor(private readonly options: ServerClientOptions) {
    this.conn = attachFramedStream(options.stream, {
      onMessage: (raw) => this.onMessage(raw),
      onClose: (err) => this.onClose(err),
    })
    this.handshake = new Promise<ServerClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiter = null
        reject(new ServerClientError('timeout', '等待 server welcome 超时'))
      }, options.handshakeTimeoutMs ?? 10_000)
      this.handshakeWaiter = { resolve, reject, timer }
      this.conn.send({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        token: options.token,
        client: {
          name: options.clientName ?? 'qingcode-next',
          version: options.clientVersion ?? '0.0.1',
        },
      })
    })
  }

  static async connect(options: ServerClientOptions): Promise<ServerClient> {
    const client = new ServerClient(options)
    try {
      await client.handshake
      return client
    } catch (err) {
      // 握手超时/被拒时 attachFramedStream 还活着，必须主动释放底层 socket。
      client.close()
      throw err
    }
  }

  get serverVersion(): string {
    return this.welcome?.serverVersion ?? ''
  }

  get pid(): number {
    return this.welcome?.pid ?? 0
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ServerClientError('closed', 'server 连接已关闭'))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ServerClientError('timeout', `等待 ${method} 响应超时`))
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 30_000)
      this.pending.set(id, { method, resolve, reject, timer })
      this.conn.send({
        t: 'req',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })
    })
  }

  codexSend(msg: unknown, agent: AgentKind = 'codex'): void {
    if (this.closed) throw new ServerClientError('closed', 'server 连接已关闭')
    if (!isRecord(msg)) throw new ServerClientError('invalid_params', 'codex.send 需要 JSON-RPC 对象')
    this.conn.send(agent === 'codex' ? { t: 'codex.send', msg } : { t: 'codex.send', agent, msg })
  }

  close(): void {
    this.conn.close()
  }

  private onMessage(raw: unknown): void {
    const msg = parseServerMessage(raw)
    if (!msg) return
    switch (msg.t) {
      case 'welcome': {
        const waiter = this.handshakeWaiter
        this.handshakeWaiter = null
        if (waiter) {
          clearTimeout(waiter.timer)
          this.welcome = { serverVersion: msg.serverVersion, pid: msg.pid }
          waiter.resolve(this)
        }
        return
      }
      case 'res': {
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        clearTimeout(waiter.timer)
        if (msg.ok) waiter.resolve(msg.result)
        else waiter.reject(new ServerClientError(String(msg.error.code), msg.error.message))
        return
      }
      case 'evt':
        this.options.handlers.onEvent(msg.name, msg.payload)
        return
      case 'codex.recv':
        this.options.handlers.onCodexRecv(msg.seq, msg.msg, (msg as { agent?: AgentKind }).agent === 'claude' ? 'claude' : 'codex')
        return
      case 'error': {
        const err = new ServerClientError(String(msg.code), msg.message)
        this.failAll(err)
        this.conn.close()
        return
      }
    }
  }

  private onClose(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.failAll(err ?? new ServerClientError('closed', 'server 连接已关闭'))
    this.options.handlers.onClose(err)
  }

  private failAll(err: Error): void {
    const waiter = this.handshakeWaiter
    this.handshakeWaiter = null
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}

interface RawStream {
  write(chunk: Uint8Array): boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  destroy(): void
}

/** net.Socket 与 ssh2 的 exec 通道都是 Node Duplex，显式适配 overload 差异。 */
export class DuplexStreamAdapter implements FramedStream {
  constructor(private readonly raw: RawStream) {}

  write(bytes: Uint8Array): boolean {
    return this.raw.write(Buffer.from(bytes))
  }

  on(ev: 'data', cb: (b: Uint8Array) => void): unknown
  on(ev: 'close' | 'end', cb: () => void): unknown
  on(ev: 'error', cb: (e: Error) => void): unknown
  on(ev: string, cb: (...args: any[]) => void): unknown {
    if (ev === 'data') {
      return this.raw.on(ev, (chunk: unknown) => cb(toBytes(chunk)))
    }
    return this.raw.on(ev, cb)
  }

  destroy(): void {
    this.raw.destroy()
  }
}

export function toFramedStream(stream: unknown): FramedStream {
  return new DuplexStreamAdapter(stream as RawStream)
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  throw new TypeError('流数据必须是字节')
}
