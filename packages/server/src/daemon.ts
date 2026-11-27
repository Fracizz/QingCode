import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import {
  PROTOCOL_VERSION,
  attachFramedStream,
  parseAgent,
  parseClientMessage,
  type AgentKind,
  type FramedConnection,
  type Req,
  type ServerMessage,
} from '@qn/protocol'
import {
  AgentHostError,
  CodexHost,
  type AgentHost,
  type AgentHostHub,
} from './codexHost'
import { applyAgentEnv, installShim, newAgentToken } from './agentctl/env'
import { AGENT_REQ_METHODS } from './agentctl/policy'
import { createClaudeHost } from './claude/bridge'
import { createPiHost } from './pi/host'
import { DirectListener } from './direct/listener'
import { fsHome, fsList } from './fs'
import { Logger } from './log'
import {
  ensureRunDir,
  readOrCreateToken,
  removeDaemonJson,
  resolvePaths,
  writeDaemonJson,
  type ServerPaths,
} from './paths'
import { SocketStream } from './socketStream'
import { checkHello } from './validation'
import { WorkspaceError, findWorkspaceHandler, type WorkspaceContext } from './workspace/index'
import { terminalManager } from './terminal/index'

export interface DaemonOptions {
  stateDir?: string
  version: string
  idleTimeoutMs?: number
  idleCheckMs?: number
  /** 测试钩子：注入带假 query 工厂的 Claude host，避免在 e2e 里拉起真实 claude。 */
  createClaudeHost?: (hub: AgentHostHub, version: string) => AgentHost
}

export type DaemonOutcome = 'started' | 'existing'

interface ClientSession {
  id: number
  socket: net.Socket
  conn: FramedConnection
  hello: boolean
  attached: Set<AgentKind>
  /** 文件/Git 处理函数登记的连接级清理（监听、搜索） */
  cleanups: Array<() => void>
  workspace?: WorkspaceContext
  /** ipc：本机命名管道/unix socket（持主 token）；direct：TLS 直连（持可撤销授权）；
   * agent：daemon 拉起的 Agent 经 qn 命令连回（持进程内 agent token，只能调用白名单方法） */
  origin: 'ipc' | 'direct' | 'agent'
  peer?: string
  grantId?: string
}

// 只允许本机持主 token 的连接调用的管理方法；直连客户端不能关停 daemon 或改直连配置。
const ADMIN_METHODS = new Set(['server.shutdown', 'direct.reload', 'direct.status'])

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_IDLE_CHECK_MS = 5_000
const HELLO_TIMEOUT_MS = 10_000

export async function runDaemon(options: DaemonOptions): Promise<DaemonOutcome> {
  const paths = resolvePaths(options.stateDir)
  ensureRunDir(paths)
  const logger = new Logger(paths.daemonLog)
  const token = readOrCreateToken(paths)
  // agent token 只存在于本进程及其子进程环境中，daemon 重启即失效；与主 token 分开以便收窄权限。
  const agentToken = newAgentToken()

  const server = await listenSingleInstance(paths, logger)
  if (!server) {
    logger.info('检测到已有 daemon 实例，本进程退出')
    return 'existing'
  }

  writeDaemonJson(paths, { pid: process.pid, version: options.version, startedAt: Date.now() })
  logger.info(`daemon 启动 v${options.version}`)
  prepareAgentCli(paths, agentToken, logger)

  const clients = new Map<number, ClientSession>()
  // 每个 agent 的 codex.recv 必须带上自己的 agent（缺省等同 codex），否则客户端无法分流。
  const hubFor = (agent: AgentKind): AgentHostHub => ({
    send(clientId, msg) {
      const session = clients.get(clientId)
      if (session?.hello) {
        session.conn.send(
          agent === 'codex' || msg.t !== 'codex.recv' ? msg : { ...msg, agent },
        )
      }
    },
    broadcastRecv(seq, msg) {
      const frame: ServerMessage =
        agent === 'codex'
          ? { t: 'codex.recv', seq, msg }
          : { t: 'codex.recv', seq, msg, agent }
      for (const session of clients.values()) {
        if (session.hello && session.attached.has(agent)) session.conn.send(frame)
      }
    },
    broadcastEvt(name, payload) {
      const frame: ServerMessage = { t: 'evt', name, payload: payload ?? null }
      for (const session of clients.values()) {
        if (session.hello) session.conn.send(frame)
      }
    },
    log(message) {
      logger.info(message)
    },
  })
  const hosts: Record<AgentKind, AgentHost> = {
    codex: new CodexHost(hubFor('codex'), options.version),
    claude: options.createClaudeHost
      ? options.createClaudeHost(hubFor('claude'), options.version)
      : createClaudeHost(hubFor('claude'), options.version),
    pi: createPiHost(hubFor('pi'), options.version),
  }
  const allHosts = [hosts.codex, hosts.claude, hosts.pi]
  const direct = new DirectListener({
    stateDir: paths.stateDir,
    log: (message) => logger.info(message),
    onSocket: (socket, peer) => acceptSocket(socket, 'direct', peer),
    onRevoked: (ids) => closeDirectSessions((session) => session.grantId !== undefined && ids.has(session.grantId), '授权已撤销'),
  })
  let nextClientId = 1
  let shuttingDown = false

  const sendOk = (session: ClientSession, id: number, result: unknown): void => {
    if (!clients.has(session.id)) return
    session.conn.send({ t: 'res', id, ok: true, result: result === undefined ? null : result })
  }
  const sendErr = (session: ClientSession, id: number, code: string, message: string): void => {
    if (!clients.has(session.id)) return
    session.conn.send({ t: 'res', id, ok: false, error: { code, message } })
  }

  /** 错误帧必须写出后再 destroy，否则客户端只看得到断连。 */
  const fail = (session: ClientSession, code: string, message: string): void => {
    session.conn.send({ t: 'error', code, message })
    setTimeout(() => session.conn.close(), 40).unref()
  }

  /** 界面事件只发给真正的界面客户端（桌面/直连），不回发给 qn 连接。 */
  const broadcastUi = (name: string, payload: unknown): number => {
    let delivered = 0
    for (const session of clients.values()) {
      if (!session.hello || session.origin === 'agent') continue
      session.conn.send({ t: 'evt', name, payload })
      delivered++
    }
    return delivered
  }

  const workspaceContext = (session: ClientSession): WorkspaceContext => {
    session.workspace ??= {
      clientId: session.id,
      emit(name, payload) {
        if (clients.has(session.id)) session.conn.send({ t: 'evt', name, payload: payload ?? null })
      },
      onClose(cleanup) {
        session.cleanups.push(cleanup)
      },
      log(message) {
        logger.info(message)
      },
    }
    return session.workspace
  }

  const handleReq = async (session: ClientSession, req: Req): Promise<void> => {
    const { id, method, params } = req
    const p = asRecord(params)
    const agent = parseAgent(p?.agent)
    if (agent === null) {
      return sendErr(session, id, 'params', 'agent 只能是 codex、claude 或 pi')
    }
    if (session.origin === 'direct' && ADMIN_METHODS.has(method)) {
      return sendErr(session, id, 'forbidden', `直连客户端不能调用 ${method}`)
    }
    if (session.origin === 'agent' && !AGENT_REQ_METHODS.has(method)) {
      return sendErr(session, id, 'forbidden', `qn 不允许调用 ${method}：只开放查询与界面提醒，命令请用 Agent 自己的工具执行`)
    }
    try {
      switch (method) {
        case 'ping':
          return sendOk(session, id, { serverVersion: options.version, protocol: PROTOCOL_VERSION })
        case 'fs.home':
          return sendOk(session, id, fsHome())
        case 'fs.list': {
          if (typeof p?.path !== 'string' || p.path.length === 0) {
            return sendErr(session, id, 'params', 'fs.list 需要 path')
          }
          const result = await fsList({ path: p.path, ...(p.dirsOnly === true ? { dirsOnly: true } : {}) })
          return sendOk(session, id, result)
        }
        case 'codex.open': {
          const codexPath = typeof p?.codexPath === 'string' ? p.codexPath : undefined
          const claudePath = typeof p?.claudePath === 'string' ? p.claudePath : undefined
          const piPath = typeof p?.piPath === 'string' ? p.piPath : undefined
          // piPath 是 pi 桥的注入点；AgentOpenOptions 未改，用交叉类型透传额外字段。
          const openOptions = {
            codexPath,
            claudePath,
            ...(piPath ? { piPath } : {}),
            ...(agent === 'codex' ? { codexHome: p?.codexHome } : {}),
            ...(agent === 'claude' ? { claudeConfigDir: p?.claudeConfigDir } : {}),
          }
          const opened = await hosts[agent].open(openOptions)
          const capabilities = agent === 'pi'
            ? asRecord((opened as { capabilities?: unknown }).capabilities)
            : { approvals: true, rateLimits: true, accessModes: true, agentConfigDir: true }
          return sendOk(session, id, {
            initialize: opened.initialize ?? null,
            lastSeq: opened.lastSeq,
            // codexVersion 是旧字段；agentVersion 对三个 agent 统一给出。
            ...(agent === 'codex' && opened.codexVersion
              ? { codexVersion: opened.codexVersion }
              : {}),
            ...(opened.agentVersion ? { agentVersion: opened.agentVersion } : {}),
            ...(capabilities ? { capabilities } : {}),
          })
        }
        case 'codex.attach': {
          if (typeof p?.sinceSeq !== 'number' || !Number.isFinite(p.sinceSeq)) {
            return sendErr(session, id, 'params', 'codex.attach 需要 sinceSeq')
          }
          session.attached.add(agent)
          return sendOk(session, id, hosts[agent].attach(session.id, p.sinceSeq))
        }
        case 'codex.status':
          return sendOk(session, id, hosts[agent].status())
        case 'direct.reload':
          return sendOk(session, id, await direct.reload().then(afterDirectReload))
        case 'direct.status':
          return sendOk(session, id, direct.status())
        case 'ui.notify': {
          const body = typeof p?.body === 'string' ? p.body.trim().slice(0, 2000) : ''
          if (!body) return sendErr(session, id, 'params', 'ui.notify 需要 body')
          const title = typeof p?.title === 'string' ? p.title.trim().slice(0, 120) : ''
          return sendOk(session, id, {
            delivered: broadcastUi('ui.notify', { body, ...(title ? { title } : {}) }),
          })
        }
        case 'ui.open': {
          if (typeof p?.path !== 'string' || p.path.length === 0) {
            return sendErr(session, id, 'params', 'ui.open 需要 path')
          }
          return sendOk(session, id, {
            delivered: broadcastUi('ui.open', {
              path: p.path,
              ...(positiveInt(p.line) ? { line: p.line } : {}),
              ...(positiveInt(p.column) ? { column: p.column } : {}),
            }),
          })
        }
        case 'server.shutdown': {
          const whenIdle = p?.whenIdle === true
          if (whenIdle && hasActiveWork()) {
            return sendErr(session, id, 'server_busy', '有进行中的对话或终端，稍后可再次升级')
          }
          sendOk(session, id, {})
          scheduleShutdown('server.shutdown', whenIdle)
          return
        }
        default: {
          const handler = findWorkspaceHandler(method)
          if (!handler) return sendErr(session, id, 'method', `未知方法: ${method}`)
          return sendOk(session, id, await handler(p ?? {}, workspaceContext(session)))
        }
      }
    } catch (err) {
      const code =
        err instanceof AgentHostError || err instanceof WorkspaceError ? err.code : 'internal'
      return sendErr(session, id, code, describe(err))
    }
  }

  const cleanup = (): void => {
    if (paths.socketFile) {
      try {
        fs.rmSync(paths.socketFile, { force: true })
      } catch {
        // socket 已不存在。
      }
    }
    removeDaemonJson(paths)
  }

  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`daemon 退出: ${reason}`)
    clearInterval(idleTimer)
    for (const host of allHosts) host.shutdown()
    terminalManager().shutdown()
    server.close()
    void direct.close()
    for (const session of clients.values()) session.conn.close()
    clients.clear()
    cleanup()
    // 等 res/error 帧写出；定时器不引用事件循环，进程可自然退出。
    const timer = setTimeout(() => process.exit(0), 40)
    timer.unref()
  }

  const hasActiveWork = (): boolean =>
    allHosts.some((host) => host.activeTurns > 0) || terminalManager().activeCount > 0

  const scheduleShutdown = (reason: string, whenIdle = false): void => {
    // 先让 shutdown 的 res 帧送达调用方（ensure --replace 会等这个响应）。
    setTimeout(() => {
      if (!whenIdle || !hasActiveWork()) shutdown(reason)
    }, 100).unref()
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let idleSince: number | null = null
  const idleTimer = setInterval(() => {
    // 开着直连时 daemon 就是对外服务，不能空闲退出（否则远端客户端无处可连）。
    // 终端归 daemon 所有：还有运行中的终端时不回收，否则断线期间的会话会丢。
    const idle = clients.size === 0 && !direct.listening && !hasActiveWork()
    if (!idle) {
      idleSince = null
      return
    }
    if (idleSince === null) {
      idleSince = Date.now()
      return
    }
    if (Date.now() - idleSince >= idleTimeoutMs) shutdown('空闲超时')
  }, options.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS)
  idleTimer.unref()

  server.on('error', (err: Error) => logger.warn(`IPC server error: ${err.message}`))
  const acceptSocket = (socket: net.Socket, origin: 'ipc' | 'direct', peer?: string): void => {
    const id = nextClientId++
    let session!: ClientSession
    const conn = attachFramedStream(new SocketStream(socket), {
      onMessage(raw: unknown) {
        if (!session.hello) {
          let grantId: string | null = null
          let viaAgentToken = false
          const check = origin === 'ipc'
            ? checkHello(raw, {
                authorize: (candidate) => {
                  if (sameToken(candidate, token)) return true
                  viaAgentToken = sameToken(candidate, agentToken)
                  return viaAgentToken
                },
              })
            : checkHello(raw, {
                authorize: (candidate) => {
                  if (peer && direct.isLocked(peer)) return false
                  grantId = direct.authorize(candidate, peer ?? '')
                  return grantId !== null
                },
              })
          if (!check.ok) {
            if (origin === 'direct') logger.warn(`直连 ${peer ?? '?'} 握手失败: ${check.message}`)
            fail(session, check.code, check.message)
            return
          }
          if (grantId) session.grantId = grantId
          if (viaAgentToken) session.origin = 'agent'
          if (origin === 'direct') logger.info(`直连 ${peer ?? '?'} 已接入（授权 ${grantId ?? '?'}）`)
          session.hello = true
          session.conn.send({
            t: 'welcome',
            protocol: PROTOCOL_VERSION,
            serverVersion: options.version,
            pid: process.pid,
          })
          return
        }
        const parsed = parseClientMessage(raw)
        if (!parsed) {
          fail(session, 'protocol', '无法识别的消息')
          return
        }
        if (parsed.t === 'hello') return
        if (parsed.t === 'req') {
          void handleReq(session, parsed)
          return
        }
        // qn 连接不经手 Agent 官方协议：codex.send 直接断开，避免借此代答审批或改会话参数。
        if (session.origin === 'agent') {
          fail(session, 'forbidden', 'qn 连接不能收发 Agent 协议消息')
          return
        }
        hosts[parsed.agent ?? 'codex'].handleClientMessage(session.id, parsed.msg)
      },
      onClose() {
        clients.delete(id)
        for (const host of allHosts) host.detach(id)
        for (const cleanup of session.cleanups.splice(0)) {
          try {
            cleanup()
          } catch (err) {
            logger.warn(`连接清理失败: ${describe(err)}`)
          }
        }
      },
    })
    session = {
      id,
      socket,
      conn,
      hello: false,
      attached: new Set(),
      cleanups: [],
      origin,
      ...(peer !== undefined ? { peer } : {}),
    }
    clients.set(id, session)
    // 直连未完成握手的连接限时，避免空连接占位。
    if (origin === 'direct') {
      setTimeout(() => {
        if (clients.get(id) === session && !session.hello) fail(session, 'auth', 'hello 超时')
      }, HELLO_TIMEOUT_MS).unref()
    }
  }
  server.on('connection', (socket: net.Socket) => acceptSocket(socket, 'ipc'))

  const closeDirectSessions = (match: (session: ClientSession) => boolean, reason: string): void => {
    for (const session of clients.values()) {
      if (session.origin === 'direct' && match(session)) fail(session, 'auth', reason)
    }
  }
  const afterDirectReload = <T>(status: T): T => {
    if (!direct.listening) closeDirectSessions(() => true, '直连已关闭')
    return status
  }
  await direct.reload().then(afterDirectReload)

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  return 'started'
}

async function listenSingleInstance(paths: ServerPaths, logger: Logger): Promise<net.Server | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await canConnect(paths.endpoint, 600)) return null
    if (paths.socketFile) {
      try {
        fs.rmSync(paths.socketFile, { force: true })
      } catch {
        // 陈旧 socket 删除失败时让 listen 自己报错。
      }
    }
    const server = net.createServer()
    const result = await tryListen(server, paths.endpoint)
    if (result === true) return server
    if (result === 'inuse') {
      if (await canConnect(paths.endpoint, 600)) return null
      continue
    }
    throw new Error(`监听本地 IPC 失败: ${result}`)
  }
  throw new Error('监听本地 IPC 失败: 重试次数耗尽')
}

function tryListen(server: net.Server, endpoint: string): Promise<true | 'inuse' | string> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES' ? 'inuse' : err.message)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ path: endpoint })
  })
}

function canConnect(endpoint: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const socket = net.createConnection({ path: endpoint })
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** 写 qn 启动脚本并把连接信息放进本进程环境：之后拉起的 Agent 与终端都会继承。 */
function prepareAgentCli(paths: ServerPaths, agentToken: string, logger: Logger): void {
  const script = process.argv[1]
  if (!script) return
  try {
    const { binDir, cli } = installShim(paths.runDir, {
      execPath: process.execPath,
      script,
      electronAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    })
    applyAgentEnv(process.env, { endpoint: paths.endpoint, token: agentToken, binDir, cli })
  } catch (err) {
    logger.warn(`准备 qn 命令失败: ${describe(err)}`)
  }
}

function sameToken(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
