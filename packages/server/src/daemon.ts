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
import { createClaudeHost } from './claude/bridge'
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
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_IDLE_CHECK_MS = 5_000

export async function runDaemon(options: DaemonOptions): Promise<DaemonOutcome> {
  const paths = resolvePaths(options.stateDir)
  ensureRunDir(paths)
  const logger = new Logger(paths.daemonLog)
  const token = readOrCreateToken(paths)

  const server = await listenSingleInstance(paths, logger)
  if (!server) {
    logger.info('检测到已有 daemon 实例，本进程退出')
    return 'existing'
  }

  writeDaemonJson(paths, { pid: process.pid, version: options.version, startedAt: Date.now() })
  logger.info(`daemon 启动 v${options.version}`)

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
  }
  const allHosts = [hosts.codex, hosts.claude]
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
      return sendErr(session, id, 'params', 'agent 只能是 codex 或 claude')
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
          const opened = await hosts[agent].open({ codexPath, claudePath })
          return sendOk(session, id, {
            initialize: opened.initialize ?? null,
            lastSeq: opened.lastSeq,
            // codexVersion 是旧字段；agentVersion 对两个 agent 统一给出。
            ...(agent === 'codex' && opened.codexVersion
              ? { codexVersion: opened.codexVersion }
              : {}),
            ...(opened.agentVersion ? { agentVersion: opened.agentVersion } : {}),
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
        case 'server.shutdown':
          sendOk(session, id, {})
          scheduleShutdown('server.shutdown')
          return
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
    server.close()
    for (const session of clients.values()) session.conn.close()
    clients.clear()
    cleanup()
    // 等 res/error 帧写出；定时器不引用事件循环，进程可自然退出。
    const timer = setTimeout(() => process.exit(0), 40)
    timer.unref()
  }

  const scheduleShutdown = (reason: string): void => {
    // 先让 shutdown 的 res 帧送达调用方（ensure --replace 会等这个响应）。
    setTimeout(() => shutdown(reason), 100).unref()
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let idleSince: number | null = null
  const idleTimer = setInterval(() => {
    const activeTurns = allHosts.reduce((total, host) => total + host.activeTurns, 0)
    const idle = clients.size === 0 && activeTurns === 0
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
  server.on('connection', (socket: net.Socket) => {
    const id = nextClientId++
    let session!: ClientSession
    const conn = attachFramedStream(new SocketStream(socket), {
      onMessage(raw: unknown) {
        if (!session.hello) {
          const check = checkHello(raw, { token })
          if (!check.ok) {
            fail(session, check.code, check.message)
            return
          }
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
        if (parsed.t === 'req') void handleReq(session, parsed)
        else hosts[parsed.agent ?? 'codex'].handleClientMessage(session.id, parsed.msg)
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
    session = { id, socket, conn, hello: false, attached: new Set(), cleanups: [] }
    clients.set(id, session)
  })

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
