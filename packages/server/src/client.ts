import net from 'node:net'
import {
  PROTOCOL_VERSION,
  attachFramedStream,
  type FramedConnection,
} from '@qn/protocol'
import { readToken, type ServerPaths } from './paths'
import { SocketStream } from './socketStream'
import { VERSION } from './version'

interface Waiter {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class IpcRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** ensure 用的一次性 IPC 客户端：hello/welcome + 顺序 req/res。 */
export class IpcClient {
  private readonly conn: FramedConnection
  private readonly pending = new Map<number, Waiter>()
  private welcomeValue: { pid: number; serverVersion: string } | null = null
  private welcomeWaiter: { resolve(): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> } | null = null
  private nextId = 1
  private closed = false
  private clientName = 'qingcode-next-ensure'
  /** res/welcome/error 以外的帧（evt、codex.recv）交给它；qn 的会话命令靠它收通知。 */
  onFrame: ((frame: Record<string, unknown>) => void) | null = null
  onClose: (() => void) | null = null

  private constructor(socket: net.Socket) {
    this.conn = attachFramedStream(new SocketStream(socket), {
      onMessage: (msg: unknown) => this.onMessage(msg),
      onClose: () => {
        this.failAll(new Error('daemon 连接已关闭'))
        this.onClose?.()
      },
    })
  }

  static async connect(paths: ServerPaths, token?: string, timeoutMs = 1500): Promise<IpcClient> {
    const auth = token ?? readToken(paths)
    if (!auth) throw new Error('daemon token 不存在')
    return IpcClient.connectEndpoint(paths.endpoint, auth, timeoutMs)
  }

  static async connectEndpoint(endpoint: string, token: string, timeoutMs = 1500, clientName?: string): Promise<IpcClient> {
    const socket = await openSocket(endpoint, timeoutMs)
    const client = new IpcClient(socket)
    if (clientName) client.clientName = clientName
    await client.handshake(token, timeoutMs)
    return client
  }

  /** 发送 req 以外的帧（codex.send）。 */
  send(frame: Record<string, unknown>): void {
    if (this.closed) throw new Error('daemon 连接已关闭')
    this.conn.send(frame)
  }

  get pid(): number {
    return this.welcomeValue?.pid ?? 0
  }

  get serverVersion(): string {
    return this.welcomeValue?.serverVersion ?? VERSION
  }

  request(method: string, params?: unknown, timeoutMs = 2000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('daemon 连接已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`等待 ${method} 响应超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.conn.send({
        t: 'req',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })
    })
  }

  close(): void {
    this.closed = true
    this.failAll(new Error('daemon 连接已关闭'))
    this.conn.close()
  }

  private handshake(token: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.welcomeWaiter = null
        reject(new Error('等待 welcome 超时'))
      }, timeoutMs)
      this.welcomeWaiter = { resolve, reject, timer }
      this.conn.send({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        token,
        client: { name: this.clientName, version: VERSION },
      })
    })
  }

  private onMessage(raw: unknown): void {
    if (!isRecord(raw)) return
    if (raw.t === 'welcome' && this.welcomeWaiter) {
      const waiter = this.welcomeWaiter
      this.welcomeWaiter = null
      clearTimeout(waiter.timer)
      this.welcomeValue = {
        pid: typeof raw.pid === 'number' ? raw.pid : 0,
        serverVersion: typeof raw.serverVersion === 'string' ? raw.serverVersion : VERSION,
      }
      waiter.resolve()
      return
    }
    if (raw.t === 'error') {
      const message = typeof raw.message === 'string' ? raw.message : 'daemon 拒绝连接'
      this.failAll(new Error(`daemon 错误 (${String(raw.code)}): ${message}`))
      return
    }
    if (raw.t === 'res' && typeof raw.id === 'number') {
      const waiter = this.pending.get(raw.id)
      if (!waiter) return
      this.pending.delete(raw.id)
      clearTimeout(waiter.timer)
      if (raw.ok === true) {
        waiter.resolve(raw.result ?? null)
        return
      }
      const error = isRecord(raw.error) ? raw.error : {}
      const code = typeof error.code === 'string' ? error.code : 'internal'
      const detail = typeof error.message === 'string' ? error.message : '请求失败'
      waiter.reject(new IpcRequestError(code, detail))
      return
    }
    this.onFrame?.(raw)
  }

  private failAll(err: Error): void {
    if (this.welcomeWaiter) {
      clearTimeout(this.welcomeWaiter.timer)
      this.welcomeWaiter.reject(err)
      this.welcomeWaiter = null
    }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.pending.clear()
    this.closed = true
  }
}

function openSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('连接 daemon 超时'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
