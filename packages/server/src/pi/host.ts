/**
 * pi 桥：对客户端说 codex app-server v2 JSON-RPC，实际经 pi 官方 RPC 模式驱动用户已装的 pi。
 * 每个会话一个 pi 进程；多客户端广播、seq 缓冲、未决请求仍由 JsonRpcAgentHost 统一处理。
 * pi 没有审批机制：这里绝不生成审批请求，也不代答扩展 UI 对话框。
 */
import { randomUUID } from 'node:crypto'
import { classifyJsonRpc, type JsonRpcId } from '@qn/protocol'
import {
  AgentHostError,
  JsonRpcAgentHost,
  type AgentHost,
  type AgentHostHub,
  type AgentOpenOptions,
  type CodexOpenResult,
} from '../codexHost'
import {
  asRecord,
  buildTurn,
  nowSeconds,
  scalarText,
  userMessageContentItem,
  type Json,
  type SessionMeta,
  type V2Notification,
} from '../claude/v2'
import { redact } from '../log'
import { VERSION } from '../version'
import { PiRpcError } from './errors'
import {
  emptyMapState,
  finishTurnNotifications,
  mapPiEvent,
  messagesToThread,
  piThread,
  type MapResult,
  type MapState,
} from './items'
import { resolvePiExecutable, type PiExecutable } from './resolve'
import { PiRpcProcess, type PiRpcOptions, type RpcRecord } from './rpc'
import { isPiLevel, parsePiModelKey, piModelList } from './models'
import { listPiSessions, type PiSessionInfo } from './sessions'
import { resolvePiPrompt } from './turnInput'

export interface PiCapabilities {
  approvals: false
  rateLimits: false
}

export const PI_CAPABILITIES: PiCapabilities = { approvals: false, rateLimits: false }

export interface PiHostOptions {
  resolve?: (piPath?: string) => PiExecutable
  createRpc?: (options: PiRpcOptions) => PiRpcProcess
  listSessions?: (cwd?: string | string[], threadId?: string) => Promise<PiSessionInfo[]>
  idleTimeoutMs?: number
}

type PiSessionMeta = SessionMeta & { sessionFile?: string }

interface PiSession {
  meta: PiSessionMeta
  rpc: PiRpcProcess | null
  starting: Promise<PiRpcProcess> | null
  turnId: string | null
  state: MapState
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 当前进程已切到的模型（provider/id）与推理档位；进程重启后清空。 */
  model?: string
  thinkingLevel?: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

export function createPiHost(
  hub: AgentHostHub,
  version: string = VERSION,
  options: PiHostOptions = {},
): AgentHost {
  return new PiHost(hub, version, options)
}

export class PiHost extends JsonRpcAgentHost {
  private opened = false
  private pi: PiExecutable | null = null
  private readonly sessions = new Map<string, PiSession>()
  private readonly metas = new Map<string, PiSessionMeta>()
  private readonly idleTimeoutMs: number
  private counter = 0
  // 最近一次从运行中进程取到的模型列表，daemon 生命周期内复用
  private cachedModels: Json | null = null

  constructor(
    hub: AgentHostHub,
    version: string = VERSION,
    private readonly options: PiHostOptions = {},
  ) {
    super(hub, version, 'pi-rpc', 'pi')
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  /** codex.open {agent:'pi'} 的结果：能力字段让前端如实标注无审批、无额度。 */
  override async open(
    options: AgentOpenOptions = {},
  ): Promise<CodexOpenResult & { capabilities: PiCapabilities }> {
    const result = await super.open(options)
    return { ...result, initialize: null, capabilities: { ...PI_CAPABILITIES } }
  }

  protected async openAgent(options: AgentOpenOptions): Promise<{ initialize: unknown; agentVersion?: string }> {
    if (this.opened) return { initialize: null, agentVersion: this.pi?.version }
    const explicit =
      typeof (options as { piPath?: unknown }).piPath === 'string'
        ? ((options as { piPath: string }).piPath).trim()
        : undefined
    const resolved = this.options.resolve
      ? this.options.resolve(explicit)
      : resolvePiExecutable(explicit)
    this.pi = resolved
    this.opened = true
    this.hub.log(`pi 桥已就绪 ${resolved.version}`)
    // initialize 由 daemon 负责，pi 桥没有 app-server 握手结果可缓存。
    return { initialize: null, agentVersion: resolved.version }
  }

  protected agentStatus(): { running: boolean; pid?: number } {
    let pid: number | undefined
    for (const session of this.sessions.values()) {
      if (typeof session.rpc?.pid === 'number') {
        pid = session.rpc.pid
        break
      }
    }
    return { running: this.opened, ...(pid !== undefined ? { pid } : {}) }
  }

  protected sendToAgent(msg: RpcRecord): void {
    void this.dispatch(msg).catch((err: unknown) => {
      this.hub.log(`pi 消息处理失败: ${redact(describe(err))}`)
    })
  }

  protected detachAgent(_clientId: number): void {}

  protected closeAgent(): void {
    this.opened = false
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer)
      this.closeRpc(session)
    }
    this.sessions.clear()
  }

  private async dispatch(msg: RpcRecord): Promise<void> {
    const kind = classifyJsonRpc(msg)
    // pi 没有审批，客户端发来的响应不应被当作审批决定。
    if (kind !== 'request') return
    const id = msg.id as JsonRpcId
    const method = scalarText(msg.method)
    const params = asRecord(msg.params) ?? {}
    try {
      const result = await this.handleRequest(method, params)
      this.emit({ id, result })
    } catch (err) {
      const { code, message } = rpcErrorOf(err)
      this.hub.log(`pi ${method} 失败: ${redact(message)}`)
      this.emit({ id, error: { code, message } })
    }
  }

  private async handleRequest(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return { userAgent: `pi-rpc/${this.pi?.version ?? 'unknown'}` }
      case 'thread/list':
        return this.threadList(params)
      case 'thread/start':
        return this.threadStart(params)
      case 'thread/resume':
      case 'thread/read':
        return this.threadRead(params)
      case 'turn/start':
        return this.turnStart(params)
      case 'turn/interrupt':
        return this.turnInterrupt(params)
      case 'model/list':
        // 只列出用户已在 pi 里配置好的模型（官方 get_available_models），不新增提供方、不碰凭据。
        return this.modelList()
      default:
        throw new PiRpcError(-32601, `不支持的 v2 方法: ${method}`)
    }
  }

  private async threadList(params: Json): Promise<Json> {
    const cwd = Array.isArray(params.cwd)
      ? params.cwd.filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
      : typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined
    const limit = typeof params.limit === 'number' && Number.isSafeInteger(params.limit) && params.limit > 0
      ? params.limit : undefined
    const infos = await this.safeListSessions(cwd)
    const metas = new Map<string, PiSessionMeta>()
    for (const info of infos) {
      if (metas.has(info.meta.id)) continue
      const meta = { ...info.meta, sessionFile: info.sessionFile }
      metas.set(meta.id, meta)
      this.metas.set(meta.id, meta)
    }
    return {
      data: [...metas.values()].slice(0, limit).map((meta) => piThread(meta)),
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private async threadStart(params: Json): Promise<Json> {
    const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd()
    const ephemeral = params.ephemeral === true
    const pendingId = `qn-pi-pending-${++this.counter}`
    const session = this.sessionFor(pendingId, { id: pendingId, cwd, preview: '', ephemeral })
    const rpc = await this.ensureRpc(session)
    await rpc.command('new_session')
    const state = await rpc.command('get_state')
    const data = asRecord(state.data) ?? {}
    const id = scalarText(data.sessionId) || pendingId
    const sessionFile =
      typeof data.sessionFile === 'string' && data.sessionFile ? data.sessionFile : undefined
    if (id !== pendingId) this.sessions.delete(pendingId)
    session.meta = {
      ...session.meta,
      id,
      ...(sessionFile ? { sessionFile } : {}),
      createdAt: nowSeconds(),
      updatedAt: nowSeconds(),
    }
    this.sessions.set(id, session)
    this.metas.set(id, session.meta)
    this.touch(session)
    return threadStartResult(session.meta)
  }

  private async threadRead(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const meta = await this.metaFor(threadId, typeof params.cwd === 'string' ? params.cwd : undefined)
    const session = this.sessionFor(threadId, meta)
    const rpc = await this.ensureRpc(session)
    const response = await rpc.command('get_messages')
    const messagesValue = asRecord(response.data)?.messages
    if (response.success !== true || !Array.isArray(messagesValue)) {
      throw new PiRpcError(-32603, '读取 pi 会话消息失败')
    }
    const history = messagesToThread(meta, messagesValue)
    this.touch(session)
    return { thread: history.thread }
  }

  private async turnStart(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const { prompt, echo } = await resolvePiPrompt(params.input)
    const meta = await this.metaFor(threadId, typeof params.cwd === 'string' ? params.cwd : undefined)
    const session = this.sessionFor(threadId, meta)
    if (session.turnId) throw new PiRpcError(-32603, '会话已有运行中的 turn')

    const turnId = randomUUID()
    session.turnId = turnId
    session.state = emptyMapState()
    const userItem = userMessageContentItem(`${turnId}-user`, echo)
    session.state.items[scalarText(userItem.id)] = userItem
    session.state.order.push(scalarText(userItem.id))
    const turn = buildTurn(turnId, [userItem], 'inProgress')
    this.notify({ method: 'turn/started', params: { threadId, turn } })

    try {
      const rpc = await this.ensureRpc(session)
      await this.applyModel(session, rpc, params)
      const response = await rpc.command('prompt', prompt as unknown as RpcRecord)
      if (response.success === false) {
        this.finishTurn(session, 'failed', scalarText(response.error) || 'pi 拒绝了 prompt')
      } else if (scalarText(asRecord(response.data)?.disposition) === 'handled') {
        // disposition=handled 表示没有启动 run，必须自行收尾，否则界面会一直显示运行中。
        this.finishTurn(session, 'completed', null)
      }
    } catch (err) {
      this.finishTurn(session, 'failed', describe(err))
      throw err
    }
    this.touch(session)
    return { turn }
  }

  private async modelList(): Promise<Json> {
    // 只借用已运行的会话进程（R9：后台取列表不为此启动 pi）；没有时返回上次缓存，首次则为空列表。
    let rpc: PiRpcProcess | null = null
    for (const session of this.sessions.values()) {
      if (session.rpc?.running) {
        rpc = session.rpc
        break
      }
    }
    if (!rpc) return this.cachedModels ?? piModelList([], {})
    const models = asRecord((await rpc.command('get_available_models')).data)?.models
    const state = asRecord((await rpc.command('get_state')).data) ?? {}
    const levels = await rpc
      .command('get_available_thinking_levels')
      .then((response) => asRecord(response.data)?.levels)
      .catch(() => undefined)
    this.cachedModels = piModelList(Array.isArray(models) ? models : [], {
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      levels,
    })
    return this.cachedModels
  }

  /** 按 turn/start 的 model/effort 切换；与当前一致时不发命令。切换失败让本轮失败，避免用错模型。 */
  private async applyModel(session: PiSession, rpc: PiRpcProcess, params: Json): Promise<void> {
    const key = scalarText(params.model)
    const target = key ? parsePiModelKey(key) : null
    if (target && key !== session.model) {
      const response = await rpc.command('set_model', target)
      if (response.success === false) throw new PiRpcError(-32603, scalarText(response.error) || `切换模型失败: ${key}`)
      session.model = key
    }
    const level = params.effort
    if (isPiLevel(level) && level !== session.thinkingLevel) {
      const response = await rpc.command('set_thinking_level', { level })
      if (response.success !== false) session.thinkingLevel = level
    }
  }

  private async turnInterrupt(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    const session = this.sessions.get(threadId)
    if (!session?.rpc || !session.turnId) {
      throw new PiRpcError(-32602, '没有运行中的 turn')
    }
    await session.rpc.command('abort')
    // abort 会等会话 idle；若 pi 没发 agent_settled，兜底按中断结束本轮。
    if (session.turnId) {
      const timer = setTimeout(() => {
        if (session.turnId) this.finishTurn(session, 'interrupted', null)
      }, 1_500)
      timer.unref?.()
    }
    return {}
  }

  private onPiEvent(session: PiSession, event: RpcRecord): void {
    if (!session.turnId) return
    const ctx = { threadId: session.meta.id, turnId: session.turnId, cwd: session.meta.cwd }
    const mapped = mapPiEventSafe(event, ctx, session.state)
    session.state = mapped.state
    for (const note of mapped.notifications) this.notify(note)
    if (mapped.turnEnd) {
      session.turnId = null
      this.touch(session)
    }
  }

  private onRpcExit(session: PiSession, rpc: PiRpcProcess, info: { code: number | null }): void {
    // closeRpc 会先置空 session.rpc，预期关闭不按崩溃处理。
    if (session.rpc !== rpc) return
    session.rpc = null
    if (session.turnId) this.finishTurn(session, 'failed', 'pi 进程提前退出')
    this.hub.log(`pi 会话进程退出 (thread=${session.meta.id} code=${String(info.code)})`)
  }

  private finishTurn(session: PiSession, status: string, error: string | null): void {
    const turnId = session.turnId
    if (!turnId) return
    const ctx = { threadId: session.meta.id, turnId, cwd: session.meta.cwd }
    for (const note of finishTurnNotifications(ctx, session.state, status, error)) this.notify(note)
    session.turnId = null
    this.touch(session)
  }

  private async metaFor(threadId: string, cwdHint?: string): Promise<PiSessionMeta> {
    const known = this.metas.get(threadId)
    if (known) return known
    const find = async (cwd?: string) => (await this.safeListSessions(cwd, threadId)).find((info) => info.meta.id === threadId)
    const info = (cwdHint ? await find(cwdHint) : undefined) ?? await find()
    if (!info) throw new PiRpcError(-32602, '未找到 pi 会话')
    const meta = { ...info.meta, sessionFile: info.sessionFile }
    this.metas.set(threadId, meta)
    return meta
  }

  private async safeListSessions(cwd?: string | string[], threadId?: string): Promise<PiSessionInfo[]> {
    try {
      return this.options.listSessions
        ? await this.options.listSessions(cwd, threadId)
        : listPiSessions(cwd, undefined, undefined, threadId)
    } catch (err) {
      this.hub.log(`pi 会话目录读取失败: ${redact(describe(err))}`)
      return []
    }
  }

  private sessionFor(threadId: string, meta: PiSessionMeta): PiSession {
    const existing = this.sessions.get(threadId)
    if (existing) return existing
    const session: PiSession = {
      meta,
      rpc: null,
      starting: null,
      turnId: null,
      state: emptyMapState(),
      idleTimer: null,
    }
    this.sessions.set(threadId, session)
    return session
  }

  private async ensureRpc(session: PiSession): Promise<PiRpcProcess> {
    if (session.starting) return session.starting
    const current = session.rpc
    if (current?.running) return current
    session.starting = this.startRpc(session).finally(() => { session.starting = null })
    return session.starting
  }

  private async startRpc(session: PiSession): Promise<PiRpcProcess> {
    const pi = this.pi
    if (!pi) throw new AgentHostError('agent_unavailable', 'pi 尚未就绪')
    const rpcOptions: PiRpcOptions = {
      command: { command: pi.command, args: pi.args, shell: pi.shell },
      cwd: session.meta.cwd,
      extraArgs: session.meta.ephemeral ? ['--no-session'] : [],
      log: (message) => this.hub.log(message),
    }
    const rpc = this.options.createRpc
      ? this.options.createRpc(rpcOptions)
      : new PiRpcProcess(rpcOptions)
    session.rpc = rpc
    delete session.model
    delete session.thinkingLevel
    rpc.onEvent((event) => this.onPiEvent(session, event))
    rpc.onExit((info) => this.onRpcExit(session, rpc, info))
    try {
      rpc.start()
      // 会话文件被移走或切换被扩展取消时，禁止把新进程当作原会话使用。
      if (!session.meta.ephemeral && session.meta.sessionFile) {
        const response = await rpc.command('switch_session', { sessionPath: session.meta.sessionFile })
        if (response.success !== true || asRecord(response.data)?.cancelled === true) {
          throw new PiRpcError(-32603, '切换到 pi 历史会话失败')
        }
        const state = await rpc.command('get_state')
        if (state.success !== true || asRecord(state.data)?.sessionId !== session.meta.id) {
          throw new PiRpcError(-32603, 'pi 返回的会话与所选会话不一致')
        }
      }
      return rpc
    } catch (err) {
      if (session.rpc === rpc) this.closeRpc(session)
      throw err
    }
  }

  private closeRpc(session: PiSession): void {
    const rpc = session.rpc
    if (!rpc) return
    session.rpc = null
    rpc.close()
  }

  private touch(session: PiSession): void {
    if (!this.opened || session.meta.ephemeral) return
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.turnId) return
      this.closeRpc(session)
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private notify(note: V2Notification): void {
    this.emit({ method: note.method, params: note.params })
  }
}

/** 单条事件映射异常不应让整个会话失联；错误只写日志，不进事件流。 */
function mapPiEventSafe(
  event: RpcRecord,
  ctx: { threadId: string; turnId: string; cwd: string },
  state: MapState,
): MapResult {
  try {
    return mapPiEvent(event, ctx, state)
  } catch {
    return { notifications: [], state }
  }
}

function threadStartResult(meta: PiSessionMeta): Json {
  return {
    thread: piThread(meta),
    model: 'pi',
    modelProvider: 'pi',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: meta.cwd,
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: null,
  }
}

function rpcErrorOf(err: unknown): { code: number; message: string } {
  if (err instanceof PiRpcError) return { code: err.code, message: err.message }
  const code = (err as { code?: unknown } | null)?.code
  return {
    code: typeof code === 'number' && code < 0 ? code : -32603,
    message: describe(err),
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
