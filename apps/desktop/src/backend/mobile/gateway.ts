import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server as HttpsServer } from 'node:https'
import { isGlobalAccessMode, resolveAccessMode, turnAccessOverride, type GlobalAccessMode } from '@qn/codex-client'
import { isJsonRpcRequest } from '@qn/protocol'
import { redactToken } from '../remoteCommands'
import { RouterError, toWireError, type CodexReplyRoute } from '../router'
import { openMobileHistory } from './history'
import { mobileProjectFiles } from './projectAccess'
import { MobileQueueRelay, parseRelayPut, type RelayRequest } from './queue'
import type { MobileCertificate } from './cert'
import type { DeviceStore, MobileDevice, PairFailureState } from './pairing'
import { constantTimeEqual, isPairLocked, normalizePairFailure, recordPairFailure } from './pairing'
import { MOBILE_TERMINAL_METHODS, MobileTerminals } from './terminals'

export const MAX_REQUEST_BYTES = 1024 * 1024
export const EVENT_HEARTBEAT_MS = 20_000

export type GatewayEvent = { name: string; payload?: unknown }

export type RouterGateway = {
  invoke(method: string, params: unknown, route?: CodexReplyRoute): Promise<unknown>
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
  replyLifetime: AbortController
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
  'mobile.turn.start',
  // 网关自有方法，不转发给同名 backend 方法。
  'mobile.agents',
  'mobile.history.open',
  'mobile.files.list',
  'mobile.files.search',
  'mobile.files.read',
  // 锁屏后的排队代发：手机逐条交给电脑，回到前台再收回。
  'mobile.queue.put',
  'mobile.queue.take',
  ...MOBILE_TERMINAL_METHODS,
])

const SERVER_REQ_METHODS = new Set([
  'ping',
  'fs.home',
  'fs.list',
  'codex.open',
  'codex.attach',
  'codex.status',
  // 未读状态电脑与手机共用：手机看过的会话在电脑上也算已读。
  'thread.unread.list',
  'thread.unread.set',
  // 手机端只读查看文件；fs.write / fs.delete / git.* / run.* 等方法一律不放行（手机版已移除 Git 差异）。
  'fs.read',
])

const FORWARDED_EVENTS = new Set(['target.state', 'codex.recv', 'server.evt', 'settings.access'])

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
  // 点对点回复由 router 匹配请求归属后直接投递，旁路只转发通知和审批。
  if (name === 'codex.recv' && isRecord(payload) && payload.seq === null) return null
  // 桌面连接订阅的终端输出可能含敏感内容，不能通过共享事件总线转给手机。
  if (name === 'server.evt' && isRecord(payload) && typeof payload.name === 'string' && payload.name.startsWith('term.')) {
    return null
  }
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

type AgentName = 'codex' | 'claude' | 'pi'
const AGENT_NAMES: readonly AgentName[] = ['codex', 'claude', 'pi']

function isAgent(value: unknown): value is AgentName {
  return value === 'codex' || value === 'claude' || value === 'pi'
}

/** 只读自有属性，避免 targetId 为 __proto__ 等键时读到原型链。 */
function ownRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value) || !hasOwn(value, key)) return null
  const item = value[key]
  return isRecord(item) ? item : null
}

export type MobileAgentsResult = {
  defaultAgent: AgentName
  globalAccessMode?: GlobalAccessMode
  agents: Record<string, Partial<Record<AgentName, { enabled: boolean }>>>
}

/** settings.get → 手机可见的 Agent 启用状态；刻意丢弃路径、配置目录等其余字段。 */
export function mobileAgentsFromSettings(settings: unknown): MobileAgentsResult {
  const general = ownRecord(settings, 'general')
  const defaultAgent = isAgent(general?.defaultAgent) ? general.defaultAgent : 'codex'
  const agents: MobileAgentsResult['agents'] = Object.create(null) as MobileAgentsResult['agents']
  const source = ownRecord(settings, 'agents') ?? {}
  for (const targetId of Object.keys(source)) {
    const prefs = ownRecord(source, targetId)
    if (!prefs) continue
    const picked: Partial<Record<AgentName, { enabled: boolean }>> = {}
    for (const agent of AGENT_NAMES) {
      const item = ownRecord(prefs, agent)
      if (item) picked[agent] = { enabled: item.enabled !== false }
    }
    agents[targetId] = picked
  }
  const globalAccessMode = general?.globalAccessMode
  return { defaultAgent, agents, ...(isGlobalAccessMode(globalAccessMode) ? { globalAccessMode } : {}) }
}

const AGENT_PATH_KEYS: Record<AgentName, 'codexPath' | 'claudePath' | 'piPath'> = {
  codex: 'codexPath',
  claude: 'claudePath',
  pi: 'piPath',
}

/**
 * 手机经 server.req 调 codex.open 时沿用电脑为该目标保存的 Agent 路径与配置目录。
 * 远端设备不能指定目标机上的程序或配置目录。
 */
export function injectAgentPath(serverReqParams: unknown, settings: unknown): unknown {
  if (!isRecord(serverReqParams) || serverReqParams.method !== 'codex.open') return serverReqParams
  const inner: JsonRecord = isRecord(serverReqParams.params) ? { ...serverReqParams.params } : {}
  for (const key of Object.values(AGENT_PATH_KEYS)) delete inner[key]
  delete inner.codexHome
  delete inner.claudeConfigDir
  const agent: AgentName = isAgent(inner.agent) ? inner.agent : 'codex'
  const targetId = typeof serverReqParams.targetId === 'string' ? serverReqParams.targetId : ''
  const prefs = targetId ? ownRecord(ownRecord(ownRecord(settings, 'agents'), targetId), agent) : null
  const path = typeof prefs?.path === 'string' ? prefs.path.trim() : ''
  if (path) inner[AGENT_PATH_KEYS[agent]] = path
  const configDir = typeof prefs?.configDir === 'string' ? prefs.configDir.trim() : ''
  if (configDir && agent === 'codex') inner.codexHome = configDir
  if (configDir && agent === 'claude') inner.claudeConfigDir = configDir
  return { ...serverReqParams, params: inner }
}

/** T14 的 agent 字段可能由原生桥放在 /rpc 顶层；补进目标方法的 params，不改 backend 类型。 */
function forwardRpcParams(body: JsonRecord, method: string): unknown {
  const params = body.params
  const agent = isAgent(body.agent) ? body.agent : undefined
  if (method === 'codex.send') {
    const next: JsonRecord = isRecord(params) ? { ...params } : {}
    if (agent && !hasOwn(next, 'agent')) next.agent = agent
    if (isRecord(next.msg) && next.msg.method === 'turn/start' && isRecord(next.msg.params)) {
      // 手机通过独立入口提交模式，由网关生成 Agent 权限字段。
      const input = { ...next.msg.params }
      delete input.claudePermissionMode
      delete input.qingcodeAccessOverride
      delete input.approvalPolicy
      delete input.approvalsReviewer
      delete input.sandboxPolicy
      next.msg = { ...next.msg, params: input }
    }
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

function mobileTurnParams(params: unknown, settings?: unknown): JsonRecord {
  if (!isRecord(params) || typeof params.targetId !== 'string' || !isAgent(params.agent) ||
      !isRecord(params.msg) || params.msg.method !== 'turn/start' || typeof params.msg.id !== 'string' ||
      !isRecord(params.msg.params)) {
    throw new RouterError('invalid_params', '访问模式发送参数无效')
  }
  if (params.inheritAccess === true) {
    if (resolveAccessMode(params.agent, mobileGlobalAccess(settings)) !== params.accessMode) {
      throw new RouterError('access_mode_changed', '权限总控已更新，请检查当前访问模式后重试')
    }
  }
  const access = turnAccessOverride(params.agent, params.accessMode)
  const { threadId, input, model, effort, serviceTier, clientUserMessageId } = params.msg.params
  const useDefault = params.agent !== 'pi' && params.accessMode === 'default' && typeof params.inheritAccess === 'boolean'
  if ((!access && !useDefault) ||
      typeof threadId !== 'string' || !threadId || !Array.isArray(input)) {
    throw new RouterError('invalid_params', '当前 Agent 不支持此访问模式，或轮次参数无效')
  }
  return {
    targetId: params.targetId,
    agent: params.agent,
    msg: {
      id: params.msg.id,
      method: 'turn/start',
      params: {
        threadId, input, ...access,
        ...(typeof clientUserMessageId === 'string' ? { clientUserMessageId } : {}),
        ...(typeof model === 'string' ? { model } : {}),
        ...(typeof effort === 'string' ? { effort } : {}),
        ...(typeof serviceTier === 'string' || serviceTier === null ? { serviceTier } : {}),
      },
    },
  }
}

function mobileGlobalAccess(settings: unknown): GlobalAccessMode {
  const mode = ownRecord(settings, 'general')?.globalAccessMode
  if (!isGlobalAccessMode(mode)) throw new RouterError('access_settings_unavailable', '暂时无法读取电脑的权限总控，请重试')
  return mode
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
  private readonly terminals = new MobileTerminals()
  private readonly queue = new MobileQueueRelay({
    send: (request) => this.relaySend(request),
    notify: (deviceId, update) => this.broadcast({ name: 'mobile.queue', payload: update }, deviceId),
  })
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

  setTerminalEnabled(enabled: boolean): void {
    this.terminals.setEnabled(enabled)
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
      // 代发队列靠轮次事件判断何时续发；点对点回复（seq 为 null）不是轮次通知。
      if (name === 'codex.recv' && isRecord(payload) && payload.seq !== null && typeof payload.targetId === 'string') {
        this.queue.onNotification(payload.targetId, payload.agent, payload.msg)
      }
      if (name === 'server.evt') {
        const terminal = this.terminals.toDevice(payload)
        if (terminal) {
          for (const client of this.eventClients) {
            if (client.deviceId !== terminal.deviceId) continue
            if (client.res.writableLength > MAX_REQUEST_BYTES) this.closeClient(client)
            else this.writeEvent(client, terminal.event)
          }
          return
        }
      }
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
    this.terminals.clear()
    this.queue.clear()
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
    this.terminals.disconnectDevice(id)
    for (const client of [...this.eventClients]) {
      if (client.deviceId === id) this.closeClient(client)
    }
  }

  disconnectAllDevices(): void {
    this.terminals.clear()
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
    let params = forwardRpcParams(body, method)
    if (method === 'server.req' && isRecord(params) && params.method === 'codex.open') {
      params = injectAgentPath(params, await this.readSettings())
    }
    try {
      const invoke = (name: string, value: unknown) => this.options.router.invoke(name, value)
      if (method === 'mobile.agents') {
        const settings = await this.readSettings()
        mobileGlobalAccess(settings)
        return this.sendJson(res, 200, { ...mobileAgentsFromSettings(settings), fastHistoryOpen: true, backgroundQueue: true })
      }
      if (method === 'mobile.queue.put') {
        const put = parseRelayPut(params)
        if (!put) throw new RouterError('invalid_params', '排队消息参数无效')
        this.queue.put(device.id, put.address, put.item, put.running)
        return this.sendJson(res, 200, { ok: true })
      }
      if (method === 'mobile.queue.take') {
        return this.sendJson(res, 200, { queues: await this.queue.take(device.id) })
      }
      if (method === 'mobile.history.open') {
        if (!isRecord(params) || typeof params.targetId !== 'string' || !params.targetId ||
            typeof params.threadId !== 'string' || !params.threadId || !isAgent(params.agent)) {
          throw new RouterError('invalid_params', '缺少目标、Agent 或会话 ID')
        }
        const lifetime = new AbortController()
        const close = () => lifetime.abort()
        if (res.destroyed) return
        res.once('close', close)
        try {
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)])
          const history = await openMobileHistory({ targetId: params.targetId, agent: params.agent, threadId: params.threadId },
            (value, route) => this.options.router.invoke('codex.send', value, route), signal)
          return this.sendJson(res, 200, history)
        } finally {
          res.off('close', close)
        }
      }
      if (method === 'codex.send' || method === 'mobile.turn.start') {
        params = await this.turnParams(method, params)
        if (isRecord(body.params) && body.params.replyViaHttp === true && isRecord(params) &&
            isJsonRpcRequest(params.msg) && params.msg.method === 'turn/start') {
          return this.sendJson(res, 200, { reply: await this.invokeTurn(res, params) })
        }
        const result = await this.invokeCodex(device.id, params)
        return this.sendJson(res, 200, result ?? null)
      }
      const result = method.startsWith('mobile.files.')
        ? await mobileProjectFiles(invoke, method, params)
        : MOBILE_TERMINAL_METHODS.has(method)
          ? await this.terminals.run(invoke, device.id, method, params)
          : await invoke(method, params)
      if (method === 'server.req' && isRecord(params) && isRecord(result)) {
        const supported = params.method === 'codex.open' && isRecord(result.capabilities)
          ? result.capabilities.accessModes
          : params.method === 'codex.attach' ? result.accessModes : undefined
        if (supported === true) return this.sendJson(res, 200, { ...result, mobileAccessModes: true })
      }
      return this.sendJson(res, 200, result ?? null)
    } catch (err) {
      const error = toWireError(err)
      const status = error.code === 'invalid_params' ? 400 : error.code === 'not_found' ? 404 : error.code === 'access_mode_changed' ? 409
        : error.code === 'access_settings_unavailable' ? 503
        : error.code === 'forbidden' || error.code === 'terminal_disabled' ? 403 : 502
      return this.sendError(res, status, error.code, redactToken(error.message) || '电脑端请求失败')
    }
  }

  /** 发送一轮前补上访问模式：手机直发与锁屏代发共用，保证两条路径的权限一致。 */
  private async turnParams(method: 'codex.send' | 'mobile.turn.start', params: unknown): Promise<unknown> {
    // 独立方法让旧网关拒绝请求，避免按默认权限误发该轮。
    if (method === 'mobile.turn.start') {
      const settings = isRecord(params) && params.inheritAccess === true ? await this.readSettings() : undefined
      return mobileTurnParams(params, settings)
    }
    if (isRecord(params) && isRecord(params.msg) && params.msg.method === 'turn/start' && isRecord(params.msg.params)) {
      // 旧手机和读取总控失败的手机都可能走普通入口，由网关补上当前总控。
      const agent = isAgent(params.agent) ? params.agent : 'codex'
      if (agent !== 'pi') {
        const mode = resolveAccessMode(agent, mobileGlobalAccess(await this.readSettings()))
        return { ...params, msg: { ...params.msg, params: { ...params.msg.params, ...turnAccessOverride(agent, mode) } } }
      }
    }
    return params
  }

  /** 代发队列里的一条：与手机直发走同一套参数处理，回包超时视为结果未确认。 */
  private async relaySend(request: RelayRequest): Promise<unknown> {
    const raw = forwardRpcParams({ method: request.method, params: request.params }, request.method)
    if (!isRecord(raw) || !isRecord(raw.msg)) throw new RouterError('invalid_params', '排队消息参数无效')
    // 每次发送生成新的请求 ID，与手机自身的 RPC 编号互不干扰。
    const params = await this.turnParams(request.method, { ...raw, msg: { ...raw.msg, id: randomUUID() } })
    if (!isRecord(params)) throw new RouterError('invalid_params', '排队消息参数无效')
    try {
      return await this.awaitTurnReply(params, AbortSignal.timeout(25_000))
    } catch (err) {
      // 已转发但没等到回包时，目标机可能已经开始这一轮，交给用户核对。
      if (isRecord(err) && (err.code === 'timeout' || err.code === 'network')) {
        throw { unconfirmed: true, message: '发送结果未确认' }
      }
      throw err
    }
  }

  private async invokeTurn(res: ServerResponse, params: JsonRecord): Promise<unknown> {
    const lifetime = new AbortController()
    const close = () => lifetime.abort()
    res.once('close', close)
    try {
      return await this.awaitTurnReply(params, AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)]))
    } finally {
      res.off('close', close)
      lifetime.abort()
    }
  }

  private awaitTurnReply(params: JsonRecord, signal: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      signal.throwIfAborted()
      const abort = () => reject(new RouterError('timeout', '发送结果未确认'))
      signal.addEventListener('abort', abort, { once: true })
      // 回包跟随发送请求，即使手机的事件流重连，也可以确认目标是否收到了这一轮。
      void this.options.router.invoke('codex.send', params, {
        signal,
        receive: ({ msg }) => resolve(msg),
      }).catch(reject)
    })
  }

  private invokeCodex(deviceId: string, params: unknown): Promise<unknown> {
    const client = [...this.eventClients].find((candidate) => candidate.deviceId === deviceId)
    return this.options.router.invoke('codex.send', params, {
      // 独立 signal 允许同一设备并行等待多条回复。
      signal: client ? AbortSignal.any([client.replyLifetime.signal]) : AbortSignal.abort(),
      receive: (payload) => this.broadcast({ name: 'codex.recv', payload }, deviceId),
    })
  }

  private async handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const device = await this.authenticate(req)
    if (!device) {
      req.resume()
      return this.sendError(res, 401, 'unauthorized', '设备未配对或令牌已失效')
    }
    const existing = [...this.eventClients].find((client) => client.deviceId === device.id)
    const client: EventClient = {
      deviceId: device.id,
      ip: clientIp(req),
      res,
      timer: null,
      closed: false,
      pending: false,
      replyLifetime: existing?.replyLifetime ?? new AbortController(),
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

  /** 设置不可用（旧版本未注册 settings.get 或读取失败）时返回 null，调用方按默认处理。 */
  private async readSettings(): Promise<unknown> {
    try {
      return await this.options.router.invoke('settings.get', {})
    } catch {
      return null
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

  private broadcast(event: GatewayEvent, deviceId?: string): void {
    for (const client of [...this.eventClients]) {
      if (deviceId === undefined || client.deviceId === deviceId) this.writeEvent(client, event)
    }
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
      line = `${JSON.stringify({ name: 'event.error', payload: { message: '事件无法序列化' } })}\n`
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
    if (![...this.eventClients].some((candidate) => candidate.deviceId === client.deviceId)) {
      client.replyLifetime.abort()
      this.terminals.disconnectDevice(client.deviceId)
    }
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
