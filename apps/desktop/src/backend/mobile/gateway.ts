import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server as HttpsServer } from 'node:https'
import { redactToken } from '../remoteCommands'
import { toWireError } from '../router'
import type { MobileCertificate } from './cert'
import type { DeviceStore, MobileDevice, PairFailureState } from './pairing'
import { constantTimeEqual, isPairLocked, normalizePairFailure, recordPairFailure } from './pairing'

export const MAX_REQUEST_BYTES = 1024 * 1024
export const EVENT_HEARTBEAT_MS = 20_000

export type GatewayEvent = { name: string; payload?: unknown }

export type RouterGateway = {
  invoke(method: string, params: unknown): Promise<unknown>
  onEmit(listener: (name: string, payload: unknown) => void): () => void
}

export type MobileGatewayOptions = {
  router: RouterGateway
  devices: DeviceStore
  getPairingCode: () => Promise<string | null>
  desktopName: string
  version: string
  now?: () => number
  lockMs?: number
  heartbeatMs?: number
  bindHost?: string
  maxBodyBytes?: number
}

type JsonRecord = Record<string, unknown>
type EventClient = {
  deviceId: string
  ip: string
  res: ServerResponse
  timer: ReturnType<typeof setInterval> | null
  closed: boolean
  pending: boolean
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const RPC_METHODS = new Set([
  'targets.list',
  'target.connect',
  'target.disconnect',
  'projects.list',
  'projects.save',
  'server.req',
  'codex.send',
])

const SERVER_REQ_METHODS = new Set([
  'ping',
  'fs.home',
  'fs.list',
  'codex.open',
  'codex.attach',
  'codex.status',
])

const FORWARDED_EVENTS = new Set(['target.state', 'codex.recv', 'server.evt'])

class HttpGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'HttpGatewayError'
  }
}

export type RpcWhitelistResult =
  | { ok: true }
  | { ok: false; code: 'invalid_params' | 'forbidden'; message: string }

/** 白名单收紧在网关层，避免手机借 server.req 调用任意 backend 方法。 */
export function checkRpcWhitelist(method: unknown, params: unknown): RpcWhitelistResult {
  if (typeof method !== 'string' || method === '') {
    return { ok: false, code: 'invalid_params', message: '缺少 RPC 方法名' }
  }
  if (!RPC_METHODS.has(method)) {
    return { ok: false, code: 'forbidden', message: '该方法不在手机网关白名单内' }
  }
  if (method === 'server.req') {
    if (!isRecord(params) || typeof params.method !== 'string' || params.method === '') {
      return { ok: false, code: 'invalid_params', message: 'server.req 缺少目标方法' }
    }
    if (!SERVER_REQ_METHODS.has(params.method)) {
      return { ok: false, code: 'forbidden', message: '该 server.req 方法不在手机网关白名单内' }
    }
  }
  return { ok: true }
}

/** 主机指纹确认只能发生在电脑端；手机只收到不含 promptId 的提示。 */
export function mobileEventFromRouter(name: string, payload: unknown): GatewayEvent | null {
  if (FORWARDED_EVENTS.has(name)) return { name, payload }
  if (name === 'hostKey.prompt') {
    const source = isRecord(payload) ? payload : {}
    return {
      name: 'mobile.notice',
      payload: {
        kind: 'hostKey',
        message: '请在电脑上确认主机指纹',
        ...(typeof source.host === 'string' ? { host: source.host } : {}),
        ...(typeof source.port === 'number' ? { port: source.port } : {}),
      },
    }
  }
  return null
}

export function parseBearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value
  if (typeof header !== 'string') return null
  const matched = /^Bearer\s+([0-9a-f]{64})$/i.exec(header.trim())
  return matched?.[1]?.toLowerCase() ?? null
}

function isAgent(value: unknown): value is 'codex' | 'claude' {
  return value === 'codex' || value === 'claude'
}

/** T14 的 agent 字段可能由原生桥放在 /rpc 顶层；补进目标方法的 params，不改 backend 类型。 */
function forwardRpcParams(body: JsonRecord, method: string): unknown {
  const params = body.params
  const agent = isAgent(body.agent) ? body.agent : undefined
  if (method === 'codex.send') {
    const next: JsonRecord = isRecord(params) ? { ...params } : {}
    if (agent && !hasOwn(next, 'agent')) next.agent = agent
    return next
  }
  if (method === 'server.req') {
    const next: JsonRecord = isRecord(params) ? { ...params } : {}
    if (agent) {
      if (!hasOwn(next, 'agent')) next.agent = agent
      const inner: JsonRecord = isRecord(next.params) ? { ...next.params } : {}
      if (!hasOwn(inner, 'agent')) inner.agent = agent
      next.params = inner
    }
    return next
  }
  return params ?? {}
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress || 'unknown'
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Array.isArray(req.headers['content-length'])
    ? req.headers['content-length'][0]
    : req.headers['content-length']
  if (declared && Number(declared) > maxBytes) {
    req.resume()
    throw new HttpGatewayError(413, 'payload_too_large', '请求体超过 1 MiB')
  }
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) throw new HttpGatewayError(413, 'payload_too_large', '请求体超过 1 MiB')
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpGatewayError(400, 'invalid_json', '请求体不是合法 JSON')
  }
}

function errorBody(code: string, message: string): JsonRecord {
  return { ok: false, error: { code, message } }
}

export class MobileGateway {
  private readonly now: () => number
  private readonly lockMs: number
  private readonly heartbeatMs: number
  private readonly bindHost: string
  private readonly maxBodyBytes: number
  private readonly failures = new Map<string, PairFailureState>()
  private readonly eventClients = new Set<EventClient>()
  private server: HttpsServer | null = null
  private unsubscribe: (() => void) | null = null
  private certificate: MobileCertificate | null = null

  constructor(private readonly options: MobileGatewayOptions) {
    this.now = options.now ?? (() => Date.now())
    this.lockMs = options.lockMs ?? 60_000
    this.heartbeatMs = options.heartbeatMs ?? EVENT_HEARTBEAT_MS
    this.bindHost = options.bindHost ?? '0.0.0.0'
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_REQUEST_BYTES
  }

  get running(): boolean {
    return this.server !== null
  }

  get boundPort(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  get fingerprint(): string {
    return this.certificate?.fingerprint ?? ''
  }

  async start(port: number, certificate: MobileCertificate): Promise<void> {
    if (this.server) await this.stop()
    this.certificate = certificate
    const server = createServer(
      { key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2' },
      (req, res) => {
        void this.handle(req, res)
      }
    )
    this.server = server
    this.unsubscribe = this.options.router.onEmit((name, payload) => {
      const event = mobileEventFromRouter(name, payload)
      if (event) this.broadcast(event)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        server.on('error', (err) => {
          if (!settled) {
            settled = true
            reject(err)
          }
        })
        server.listen(port, this.bindHost, () => {
          if (!settled) {
            settled = true
            resolve()
          }
        })
      })
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.closeAllEventClients()
    if (!server) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      try {
        server.close(() => finish())
        server.closeAllConnections?.()
        server.closeIdleConnections?.()
        const timer = setTimeout(finish, 1000)
        timer.unref?.()
      } catch {
        finish()
      }
    })
  }

  disconnectDevice(id: string): void {
    for (const client of [...this.eventClients]) {
      if (client.deviceId === id) this.closeClient(client)
    }
  }

  disconnectAllDevices(): void {
    this.closeAllEventClients()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/probe') {
        if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
        return this.sendJson(res, 200, {
          name: this.options.desktopName,
          desktopName: this.options.desktopName,
          version: this.options.version,
          protocol: 1,
          fingerprint: this.fingerprint,
        })
      }
      if (path === '/pair') {
        if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
        return await this.handlePair(req, res)
      }
      if (path === '/rpc') {
        if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
        return await this.handleRpc(req, res)
      }
      if (path === '/events') {
        if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
        return await this.handleEvents(req, res)
      }
      return this.sendError(res, 404, 'not_found', '手机网关路由不存在')
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          // 客户端可能已断开。
        }
        return
      }
      if (err instanceof HttpGatewayError) {
        return this.sendError(res, err.status, err.code, err.message)
      }
      return this.sendError(res, 500, 'internal', '手机网关内部错误')
    }
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req)
    const now = this.now()
    const current = normalizePairFailure(this.failures.get(ip), now)
    if (current && isPairLocked(current, now)) {
      this.failures.set(ip, current)
      req.resume()
      const seconds = Math.max(1, Math.ceil((current.lockedUntil - now) / 1000))
      return this.sendError(res, 429, 'pair_locked', '尝试次数过多，请稍后再试', {
        'Retry-After': String(seconds),
      })
    }
    if (current) this.failures.set(ip, current)
    else this.failures.delete(ip)

    const body = await readJsonBody(req, this.maxBodyBytes)
    if (!isRecord(body)) throw new HttpGatewayError(400, 'invalid_params', '配对请求格式不正确')
    let password: string | null
    try {
      password = await this.options.getPairingCode()
    } catch {
      return this.sendError(res, 503, 'pairing_unavailable', '配对密码不可用，请在电脑上重新设置')
    }
    if (!password) {
      return this.sendError(res, 409, 'pairing_unavailable', '请先在电脑上设置配对密码')
    }
    const candidate = typeof body.code === 'string' ? body.code : ''
    if (!constantTimeEqual(candidate, password)) {
      this.failures.set(ip, recordPairFailure(current, now, this.lockMs))
      return this.sendError(res, 401, 'pair_failed', '配对密码错误')
    }
    this.failures.delete(ip)
    const created = await this.options.devices.add({ name: body.deviceName, ip, now })
    return this.sendJson(res, 200, {
      token: created.token,
      desktopName: this.options.desktopName,
    })
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const device = await this.authenticate(req)
    if (!device) {
      req.resume()
      return this.sendError(res, 401, 'unauthorized', '设备未配对或令牌已失效')
    }
    const body = await readJsonBody(req, this.maxBodyBytes)
    if (!isRecord(body)) throw new HttpGatewayError(400, 'invalid_params', 'RPC 请求格式不正确')
    const allowed = checkRpcWhitelist(body.method, body.params)
    if (!allowed.ok) {
      const status = allowed.code === 'forbidden' ? 403 : 400
      return this.sendError(res, status, allowed.code, allowed.message)
    }
    const method = body.method as string
    const params = forwardRpcParams(body, method)
    try {
      const result = await this.options.router.invoke(method, params)
      return this.sendJson(res, 200, result ?? null)
    } catch (err) {
      const error = toWireError(err)
      const status = error.code === 'invalid_params' ? 400 : error.code === 'not_found' ? 404 : 502
      return this.sendError(res, status, error.code, redactToken(error.message) || '电脑端请求失败')
    }
  }

  private async handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const device = await this.authenticate(req)
    if (!device) {
      req.resume()
      return this.sendError(res, 401, 'unauthorized', '设备未配对或令牌已失效')
    }
    const client: EventClient = {
      deviceId: device.id,
      ip: clientIp(req),
      res,
      timer: null,
      closed: false,
      pending: false,
    }
    this.eventClients.add(client)
    const cleanup = () => this.closeClient(client)
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    this.writeEvent(client, { name: 'ping' })
    if (!client.closed && this.heartbeatMs > 0) {
      const timer = setInterval(() => void this.heartbeat(client), this.heartbeatMs)
      timer.unref?.()
      client.timer = timer
    }
  }

  private async authenticate(req: IncomingMessage): Promise<MobileDevice | null> {
    const token = parseBearerToken(req.headers.authorization)
    if (!token) return null
    return this.options.devices.authenticate(token, clientIp(req), this.now())
  }

  private async heartbeat(client: EventClient): Promise<void> {
    if (client.closed || client.pending) return
    client.pending = true
    try {
      const stillPaired = await this.options.devices
        .touch(client.deviceId, client.ip, this.now())
        .catch(() => false)
      if (!stillPaired) {
        this.closeClient(client, { name: 'unauthorized', payload: { message: '设备已被撤销' } })
        return
      }
      this.writeEvent(client, { name: 'ping' })
    } finally {
      client.pending = false
    }
  }

  private broadcast(event: GatewayEvent): void {
    for (const client of [...this.eventClients]) this.writeEvent(client, event)
  }

  private writeEvent(client: EventClient, event: GatewayEvent): void {
    if (client.closed || client.res.writableEnded) {
      this.closeClient(client)
      return
    }
    let line: string
    try {
      line = `${JSON.stringify(event)}\n`
    } catch {
      line = '{"name":"event.error","payload":{"message":"事件无法序列化"}}\n'
    }
    try {
      client.res.write(line)
    } catch {
      this.closeClient(client)
    }
  }

  private closeClient(client: EventClient, lastEvent?: GatewayEvent): void {
    if (client.closed) return
    if (lastEvent && !client.res.writableEnded) {
      try {
        client.res.write(`${JSON.stringify(lastEvent)}\n`)
      } catch {
        // 连接可能已断开。
      }
    }
    client.closed = true
    if (client.timer) clearInterval(client.timer)
    client.timer = null
    this.eventClients.delete(client)
    try {
      if (!client.res.writableEnded) client.res.end()
    } catch {
      // 连接可能已断开。
    }
  }

  private closeAllEventClients(): void {
    for (const client of [...this.eventClients]) this.closeClient(client)
  }

  private methodNotAllowed(res: ServerResponse, allow: string): void {
    this.sendError(res, 405, 'method_not_allowed', '请求方法不被允许', { Allow: allow })
  }

  private sendError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    headers?: Record<string, string>
  ): void {
    this.sendJson(res, status, errorBody(code, message), headers)
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>
  ): void {
    if (res.writableEnded || res.headersSent) return
    let code = status
    let text: string
    try {
      text = JSON.stringify(body ?? null)
    } catch {
      code = 500
      text = JSON.stringify(errorBody('internal', '手机网关序列化失败'))
    }
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    for (const [key, value] of Object.entries(headers ?? {})) res.setHeader(key, value)
    res.end(text)
  }
}
