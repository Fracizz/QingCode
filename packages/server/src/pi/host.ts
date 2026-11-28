/**
 * pi 桥：对客户端说 codex app-server v2 JSON-RPC，实际经 pi 官方 RPC 模式驱动用户已装的 pi。
 * 每个会话一个 pi 进程；多客户端广播、seq 缓冲、未决请求仍由 JsonRpcAgentHost 统一处理。
 * pi 没有审批机制：这里绝不生成审批请求。扩展 UI 对话框作为提问交给用户，不代答。
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_CAPABILITIES, classifyJsonRpc, type AgentCapabilities, type JsonRpcId } from '@qn/protocol'
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
  finite,
  itemCompleted,
  isRecord,
  nowSeconds,
  scalarText,
  userMessageContentItem,
  type Json,
  type SessionMeta,
  type V2Item,
  type V2Notification,
} from '../claude/v2'
import { HistoryPageCache, listHistoryItems, listHistoryTurns } from '../claude/historyPages'
import { redact } from '../log'
import { ArchiveStore } from '../archiveStore'
import { ModelCache } from '../agentModelCache'
import { SteerHistoryStore } from '../steerHistory'
import { VERSION } from '../version'
import { nativeAgentCwd } from '../workspace/paths'
import { PiRpcError } from './errors'
import { parsePiDialog, piDialogQuestions, piDialogResponse, type PiDialog } from './extensionUi'
import {
  emptyMapState,
  finishTurnNotifications,
  mapPiEvent,
  piContextTokenUsage,
  messagesToThread,
  parsePiSteer,
  piThread,
  userEcho,
  type MapResult,
  type MapState,
  type UserMessageIdentity,
} from './items'
import { resolvePiExecutable, type PiExecutable } from './resolve'
import { readVersionAsync } from '../versionProbe'
import { PiRpcProcess, type PiRpcOptions, type RpcRecord } from './rpc'
import { isPiLevel, parsePiModelKey, piModelList } from './models'
import { listPiSessions, readPiSessionConfig, sameCwd, type PiSessionConfig, type PiSessionInfo } from './sessions'
import { piCommands, piSkills } from './skills'
import { resolvePiPrompt } from './turnInput'

export interface PiHostOptions {
  resolve?: (piPath?: string) => PiExecutable
  createRpc?: (options: PiRpcOptions) => PiRpcProcess
  listSessions?: (cwd?: string | string[], threadId?: string) => Promise<PiSessionInfo[]>
  idleTimeoutMs?: number
  stateDir?: string
}

type PiSessionMeta = SessionMeta & { sessionFile?: string }

interface PiSession {
  meta: PiSessionMeta
  rpc: PiRpcProcess | null
  starting: Promise<PiRpcProcess> | null
  preparingTurn: boolean
  compacting: boolean
  turnId: string | null
  /** pi 的运行从 agent_start 到 agent_settled，期间可能没有对应的客户端请求。 */
  runActive: boolean
  /** 正在停止的轮次，不再接受它的引导。 */
  stoppingTurnId?: string
  pendingUserItem?: UserMessageIdentity
  pendingSteers: Map<string, { item: V2Item; turnId: string }>
  steering?: Promise<void>
  userItemIds: Map<string, UserMessageIdentity | null>
  state: MapState
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 当前进程已切到的模型（provider/id）与推理档位；进程重启后清空。 */
  model?: string
  thinkingLevel?: string
}

interface OpenDialog {
  session: PiSession
  rpc: PiRpcProcess
  dialog: PiDialog
  /** 发起时所属的轮次；轮次结束时一并撤掉。 */
  turnId: string | null
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
// 停止流程里的各步等待上限：任何一步卡住都不能拖住 abort。
const STEER_SETTLE_MS = 1_000
const CLEAR_QUEUE_TIMEOUT_MS = 5_000
const LEGACY_ABORT_MS = 1_500
const PENDING_PREFIX = 'qn-pi-pending-'

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
  private readonly historyPages = new HistoryPageCache()
  private readonly idleTimeoutMs: number
  private readonly steerHistory: SteerHistoryStore<UserMessageIdentity>
  private readonly archives: ArchiveStore
  private counter = 0
  private readonly dialogs = new Map<JsonRpcId, OpenDialog>()
  private readonly modelCache: ModelCache
  private modelListRequest: Promise<Json> | null = null
  // 按 cwd 缓存最近一次取到的技能，进程空闲关闭后仍可选择
  private readonly cachedSkills = new Map<string, Json[]>()

  constructor(
    hub: AgentHostHub,
    version: string = VERSION,
    private readonly options: PiHostOptions = {},
  ) {
    super(hub, version, 'pi-rpc', 'pi')
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.steerHistory = new SteerHistoryStore(options.stateDir, 'pi', parsePiSteer, (msg) => this.hub.log(msg))
    this.archives = new ArchiveStore(options.stateDir, 'pi', (msg) => this.hub.log(msg))
    this.modelCache = new ModelCache(options.stateDir, 'pi', (msg) => this.hub.log(msg))
  }

  /** codex.open {agent:'pi'} 的结果：能力字段让前端如实标注无审批、无额度。 */
  override async open(
    options: AgentOpenOptions = {},
  ): Promise<CodexOpenResult & { capabilities: AgentCapabilities }> {
    const result = await super.open(options)
    return { ...result, initialize: null, capabilities: { ...AGENT_CAPABILITIES.pi } }
  }

  protected async openAgent(options: AgentOpenOptions): Promise<{ initialize: unknown; agentVersion?: string }> {
    if (this.opened) return { initialize: null, agentVersion: this.pi?.version }
    const explicit =
      typeof (options as { piPath?: unknown }).piPath === 'string'
        ? ((options as { piPath: string }).piPath).trim()
        : undefined
    // 默认路径下版本号异步读取，不用 spawnSync 阻塞 daemon（Windows 上 .ps1 经 powershell 尤其慢）。
    const resolved = this.options.resolve
      ? this.options.resolve(explicit)
      : resolvePiExecutable(explicit, { versionOf: () => 'unknown' })
    if (!this.options.resolve && resolved.version === 'unknown') {
      resolved.version = await readVersionAsync(resolved)
    }
    this.pi = resolved
    this.opened = true
    this.hub.log(`pi 桥已就绪 ${resolved.version}`) // i18n-ignore: 仅进日志
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
      this.hub.log(`pi 消息处理失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
    })
  }

  protected detachAgent(_clientId: number): void {}

  protected closeAgent(): void {
    this.opened = false
    this.historyPages.clear()
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer)
      this.closeRpc(session)
    }
    this.sessions.clear()
  }

  private async dispatch(msg: RpcRecord): Promise<void> {
    const kind = classifyJsonRpc(msg)
    // 客户端的响应只对应扩展对话框（pi 没有审批请求）。
    if (kind === 'response') {
      this.closeDialog(msg.id as JsonRpcId, msg)
      return
    }
    if (kind !== 'request') return
    const id = msg.id as JsonRpcId
    const method = scalarText(msg.method)
    const params = asRecord(msg.params) ?? {}
    try {
      const result = await this.handleRequest(method, params)
      this.emit({ id, result })
    } catch (err) {
      const { code, message } = rpcErrorOf(err)
      this.hub.log(`pi ${method} 失败: ${redact(message)}`) // i18n-ignore: 仅进日志
      this.emit({ id, error: { code, message } })
    }
  }

  private async handleRequest(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return { userAgent: `pi-rpc/${this.pi?.version ?? 'unknown'}` }
      case 'thread/unsubscribe': {
        const threadId = scalarText(params.threadId)
        const session = this.sessions.get(threadId)
        if (!session) return { status: 'notLoaded' }
        if (!session.meta.ephemeral) throw new PiRpcError(-32602, '仅可结束临时会话')
        if (session.turnId || session.preparingTurn) throw new PiRpcError(-32602, '请先停止当前轮次')
        this.closeRpc(session)
        this.forgetTemporary(threadId)
        return { status: 'unsubscribed' }
      }
      case 'thread/list':
        return this.threadList(params)
      case 'thread/archive':
      case 'thread/unarchive': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
        const archive = method === 'thread/archive'
        // 广播与 Codex 同名的通知，同一目标上的电脑和手机都据此移出或恢复列表。
        if (this.archives.set(threadId, archive)) {
          this.notify({ method: archive ? 'thread/archived' : 'thread/unarchived', params: { threadId } })
        }
        return {}
      }
      case 'thread/start':
        return this.threadStart(params)
      case 'thread/fork':
        return this.threadFork(params)
      case 'thread/resume':
      case 'thread/read':
      case 'thread/turns/list':
      case 'thread/items/list':
        return this.threadRead(method, params)
      case 'thread/name/set':
        return this.threadRename(params)
      case 'skills/list':
        return this.skillList(params)
      case 'qingcode/commands/list':
        return this.commandList(params)
      case 'thread/compact/start':
        return this.compactThread(params)
      case 'turn/start':
        return this.turnStart(params)
      case 'turn/steer':
        return this.turnSteer(params)
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
        .map((dir) => nativeAgentCwd(dir))
      : typeof params.cwd === 'string' && params.cwd ? nativeAgentCwd(params.cwd) : undefined
    const limit = typeof params.limit === 'number' && Number.isSafeInteger(params.limit) && params.limit > 0
      ? params.limit : undefined
    const infos = await this.safeListSessions(cwd)
    const metas = new Map<string, PiSessionMeta>()
    // 与 Codex 的 thread/list 一致：archived=true 只列归档，否则排除归档。
    const archived = params.archived === true
    for (const info of infos) {
      if (metas.has(info.meta.id)) continue
      const meta = { ...info.meta, sessionFile: info.sessionFile }
      this.metas.set(meta.id, meta)
      if (this.archives.has(meta.id) !== archived) continue
      metas.set(meta.id, meta)
    }
    return {
      data: [...metas.values()].slice(0, limit).map((meta) => {
        const thread = piThread(meta)
        return this.sessions.get(meta.id)?.turnId ? { ...thread, status: { type: 'active', activeFlags: [] } } : thread
      }),
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private async threadStart(params: Json): Promise<Json> {
    const cwd = typeof params.cwd === 'string' && params.cwd ? nativeAgentCwd(params.cwd) : process.cwd()
    const ephemeral = params.ephemeral === true
    const pendingId = `${PENDING_PREFIX}${++this.counter}`
    const session = this.sessionFor(pendingId, { id: pendingId, cwd, preview: '', ephemeral })
    let data: Json
    try {
      const rpc = await this.ensureRpc(session)
      const created = await rpc.command('new_session')
      if (created.success !== true || asRecord(created.data)?.cancelled === true) {
        throw new PiRpcError(-32603, 'pi 未创建会话')
      }
      const state = await rpc.command('get_state')
      data = asRecord(state.data) ?? {}
      if (state.success !== true || !scalarText(data.sessionId)) throw new PiRpcError(-32603, 'pi 未返回会话 ID')
    } catch (err) {
      this.closeRpc(session)
      this.sessions.delete(pendingId)
      throw err
    }
    const id = scalarText(data.sessionId)
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
    if (!ephemeral && session.rpc) void this.readModels(session.rpc, true)
    return threadStartResult(session.meta)
  }

  private async threadRead(method: string, params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const meta = await this.metaFor(threadId, typeof params.cwd === 'string' ? nativeAgentCwd(params.cwd) : undefined)
    const session = this.sessionFor(threadId, meta)
    const metadataOnly = (method === 'thread/resume' && params.excludeTurns === true)
      || (method === 'thread/read' && params.includeTurns === false)
    const paged = method === 'thread/turns/list' || method === 'thread/items/list'
    const config = paged ? undefined : sessionConfig(session)
    if (metadataOnly) {
      const status = session.turnId ? { type: 'active', activeFlags: [] } : { type: 'idle' }
      return { thread: { ...piThread(meta, [], config), status, historyMode: 'paginated' } }
    }
    const load = async () => {
      const rpc = await this.ensureRpc(session)
      const messages = await this.readMessages(rpc)
      const turns = messagesToThread(meta, messages, session.userItemIds).turns
      // 用量只在轮次结束时推送，打开历史会话时向 pi 读一次当前上下文占用补上读数。
      const lastTurnId = scalarText(asRecord(turns.at(-1))?.id)
      if (!session.turnId && lastTurnId) void this.reportContextUsage(session, lastTurnId, null)
      return turns
    }
    const saved = await (paged
      ? this.historyPages.read(threadId, params.cursor != null || method === 'thread/items/list', load)
      : load())
    this.touch(session)
    const turnId = session.turnId
    // 运行中条目同时经事件流推送，保留 active turn 的 ID 供中断和审批状态对齐。
    const turns = turnId ? [...saved, buildTurn(turnId, [], 'inProgress')] : saved
    if (method === 'thread/turns/list') return listHistoryTurns(threadId, turns, params)
    if (method === 'thread/items/list') return listHistoryItems(threadId, turns, params)
    const thread = piThread(meta, turns, config)
    return { thread: turnId ? { ...thread, status: { type: 'active', activeFlags: [] } } : thread }
  }

  private async readMessages(rpc: PiRpcProcess): Promise<unknown[]> {
    const response = await rpc.command('get_messages')
    const messages = asRecord(response.data)?.messages
    if (response.success !== true || !Array.isArray(messages)) {
      throw new PiRpcError(-32603, '读取 pi 会话消息失败')
    }
    return messages
  }

  private async threadFork(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const meta = await this.metaFor(threadId)
    const source = this.sessionFor(threadId, meta)
    const turnId = scalarText(params.lastTurnId)
    if (meta.ephemeral || !meta.sessionFile || (source.turnId && (!turnId || source.turnId === turnId))) {
      throw new PiRpcError(-32602, '请选择已保存且已结束的 pi 会话轮次')
    }

    // pi 的 fork 会切换调用方的会话。用独立进程载入源会话，正在查看或运行源会话的客户端可继续使用原进程。
    const fork = this.makeSession(meta)
    try {
      const rpc = await this.ensureRpc(fork)
      const entryId = turnId ? await this.piForkEntry(rpc, source, turnId) : undefined
      const response = entryId ? await rpc.command('fork', { entryId }) : await rpc.command('clone')
      if (response.success !== true || asRecord(response.data)?.cancelled === true) {
        throw new PiRpcError(-32603, 'pi 未创建会话分支')
      }
      const status = await rpc.command('get_state')
      const state = asRecord(status.data)
      const id = scalarText(state?.sessionId)
      const sessionFile = scalarText(state?.sessionFile)
      if (status.success !== true || !id || id === threadId || !sessionFile) {
        throw new PiRpcError(-32603, 'pi 未返回新的会话')
      }
      const branch = { ...meta, id, sessionFile, createdAt: nowSeconds(), updatedAt: nowSeconds() }
      this.metas.set(id, branch)
      const branchSession = this.sessionFor(id, branch)
      branchSession.userItemIds = new Map(source.userItemIds)
      if ([...branchSession.userItemIds.values()].some((identity) => identity?.steering)) this.persistSteers(branchSession)
      const messages = params.excludeTurns === true ? [] : await this.readMessages(rpc)
      const thread = messagesToThread(branch, messages, branchSession.userItemIds).thread
      this.notify({ method: 'thread/started', params: { thread } })
      return { ...threadStartResult(branch), thread }
    } finally {
      this.closeRpc(fork)
    }
  }

  private async piForkEntry(rpc: PiRpcProcess, source: PiSession, turnId: string): Promise<string | undefined> {
    const messages = await this.readMessages(rpc)
    const turns = messagesToThread(source.meta, messages, source.userItemIds).turns
    const index = turns.findIndex((turn) =>
      turn.id === turnId || (Array.isArray(turn.items) && turn.items.some((item) => asRecord(item)?.id === `${turnId}-user`)))
    if (index < 0) throw new PiRpcError(-32602, '在 pi 历史中找不到所选轮次')
    const prefix = `turn-${source.meta.id}-`
    // fork 排除传入的用户消息，按历史轮次找下一轮开头，跳过当前轮内的引导消息。
    const next = turns[index + 1]
    if (!next) return undefined
    const user = asRecord(messages[Number(scalarText(next.id).slice(prefix.length))])
    const response = await rpc.command('get_entries')
    const data = asRecord(response.data)
    if (!user || response.success !== true || !Array.isArray(data?.entries)) {
      throw new PiRpcError(-32603, '读取 pi 会话分支失败')
    }
    const entries = new Map(data.entries.filter(isRecord).map((entry) => [scalarText(entry.id), entry]))
    let selected: string | undefined
    let leaf = scalarText(data.leafId)
    while (leaf) {
      const entry = entries.get(leaf)
      if (!entry) throw new PiRpcError(-32603, 'pi 会话分支不完整')
      entries.delete(leaf)
      if (entry.type === 'message' && isDeepStrictEqual(entry.message, user)) {
        if (selected) throw new PiRpcError(-32602, 'pi 历史中的分支位置不唯一')
        selected = leaf
      }
      leaf = scalarText(entry.parentId)
    }
    if (!selected) throw new PiRpcError(-32602, '在 pi 历史中找不到下一轮的开头')
    return selected
  }

  private async turnStart(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const { prompt, echo } = await resolvePiPrompt(params.input)
    const meta = await this.metaFor(threadId, typeof params.cwd === 'string' ? nativeAgentCwd(params.cwd) : undefined)
    const session = this.sessionFor(threadId, meta)
    if (session.turnId || session.preparingTurn) throw new PiRpcError(-32603, '会话已有准备中或运行中的 turn')

    const turnId = randomUUID()
    const clientId = typeof params.clientUserMessageId === 'string' ? params.clientUserMessageId || null : null
    const userItemId = `${turnId}-user`
    const userItem = userMessageContentItem(userItemId, echo, clientId)
    const turn = buildTurn(turnId, [userItem], 'inProgress')

    session.preparingTurn = true
    try {
      const rpc = await this.ensureRpc(session)
      await this.applyModel(session, rpc, params)
      // 准备期间 pi 可能已自行开跑（扩展触发或排队续跑），此时发 prompt 会被拒绝。
      if (session.turnId) throw new PiRpcError(-32603, '会话已有准备中或运行中的 turn')
      session.turnId = turnId
      session.pendingUserItem = { id: userItemId, clientId }
      session.state = emptyMapState()
      session.state.items[userItemId] = userItem
      session.state.order.push(userItemId)
      this.notify({ method: 'turn/started', params: { threadId, turn } })
      const response = await rpc.command('prompt', prompt as unknown as RpcRecord)
      // 回执到达前本轮可能已经结束，这时的 turnId 属于另一次运行，不能动。
      if (session.turnId === turnId) {
        if (response.success === false) {
          this.finishTurn(session, 'failed', scalarText(response.error) || 'pi 拒绝了 prompt')
          // 因 pi 正在运行而被拒时，另建轮次接住它，保证能看到、能停止。
          if (session.runActive) this.startAutonomousTurn(session)
        } else if (scalarText(asRecord(response.data)?.disposition) === 'handled') {
          // handled 表示本次输入没有启动 run，必须自行收尾；扩展命令另行启动的运行则等 agent_settled。
          if (session.runActive) delete session.pendingUserItem
          else this.finishTurn(session, 'completed', null)
        }
      }
    } catch (err) {
      if (session.turnId === turnId) this.finishTurn(session, 'failed', describe(err))
      throw err
    } finally {
      session.preparingTurn = false
      this.touch(session)
    }
    return { turn }
  }

  private async threadRename(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    const name = scalarText(params.name).trim()
    if (!threadId || !name) throw new PiRpcError(-32602, 'threadId 与会话名称不能为空')
    const meta = await this.metaFor(threadId)
    if (meta.ephemeral) throw new PiRpcError(-32602, '临时会话不能重命名')
    const session = this.sessionFor(threadId, meta)
    const rpc = await this.ensureRpc(session)
    const response = await rpc.command('set_session_name', { name })
    if (response.success !== true) throw new PiRpcError(-32603, 'pi 未能重命名会话')
    meta.name = name
    session.meta.name = name
    this.touch(session)
    this.notify({ method: 'thread/name/updated', params: { threadId, threadName: name } })
    return {}
  }

  private async skillList(params: Json): Promise<Json> {
    const cwds = Array.isArray(params.cwds)
      ? params.cwds.filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
      : []
    const data = await Promise.all(cwds.map(async (requested) => {
      const cwd = nativeAgentCwd(requested)
      // 与模型列表一样只借用运行中的会话进程（R9），没有时返回缓存。
      const rpc = [...this.sessions.values()].find((session) =>
        !session.meta.ephemeral && session.rpc?.running && sameCwd(session.meta.cwd, cwd))?.rpc
      if (rpc) {
        try {
          const response = await rpc.command('get_commands')
          if (response.success === true) this.cachedSkills.set(cwd, piSkills(asRecord(response.data)?.commands))
        } catch (err) {
          this.hub.log(`pi 技能列表读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
        }
      }
      return { cwd: requested, skills: this.cachedSkills.get(cwd) ?? [], errors: [] }
    }))
    return { data }
  }

  /** 原生斜杠命令只读该会话运行中的进程（R9），没有时返回空列表。 */
  private async commandList(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const rpc = this.sessions.get(threadId)?.rpc
    if (!rpc?.running) return { commands: [] }
    const response = await rpc.command('get_commands')
    return { commands: response.success === true ? piCommands(asRecord(response.data)?.commands) : [] }
  }

  /** 占用以 pi 自己的统计为准；取不到时保留事件流里的本轮用量。 */
  private async reportContextUsage(session: PiSession, turnId: string, total: MapState['totalUsage']): Promise<void> {
    const rpc = session.rpc
    if (!rpc?.running) return
    try {
      const response = await rpc.command('get_session_stats')
      if (response.success !== true || session.rpc !== rpc) return
      const tokenUsage = piContextTokenUsage(asRecord(response.data)?.contextUsage, total)
      if (tokenUsage) this.notify({ method: 'thread/tokenUsage/updated', params: { threadId: session.meta.id, turnId, tokenUsage } })
    } catch (err) {
      this.hub.log(`pi 上下文用量读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
    }
  }

  private modelList(): Promise<Json> {
    for (const session of this.sessions.values()) {
      if (!session.meta.ephemeral && !session.starting && !session.meta.id.startsWith(PENDING_PREFIX) && session.rpc?.running) {
        return this.readModels(session.rpc)
      }
    }
    // 只从已有会话进程读取；冷连接时先返回目标机上的上次结果。
    return Promise.resolve(this.modelCache.get(this.pi?.path) ?? piModelList([], {}))
  }

  private readModels(rpc: PiRpcProcess, notify = false): Promise<Json> {
    // 同一时刻多个客户端请求、会话启动只发一组 RPC。
    const path = this.pi?.path
    const previous = this.modelCache.get(path)
    this.modelListRequest ??= this.fetchModelList(rpc, path, previous).finally(() => {
      this.modelListRequest = null
    })
    const task = this.modelListRequest
    if (notify) void task.then((list) => {
      if (this.opened && !isDeepStrictEqual(previous ?? piModelList([], {}), list)) {
        this.notify({ method: 'qingcode/models/updated', params: {} })
      }
    })
    return task
  }

  private async fetchModelList(rpc: PiRpcProcess, path: string | undefined, previous: Json | null): Promise<Json> {
    try {
      const response = await rpc.command('get_available_models')
      const models = asRecord(response.data)?.models
      if (response.success === true && Array.isArray(models)) {
        const state = asRecord((await rpc.command('get_state')).data) ?? {}
        const levels = await rpc.command('get_available_thinking_levels')
          .then((result) => asRecord(result.data)?.levels)
          .catch(() => undefined)
        const list = piModelList(models, { model: state.model, thinkingLevel: state.thinkingLevel, levels })
        if (!isDeepStrictEqual(previous, list)) this.modelCache.set(path, list)
        return list
      }
    } catch (err) {
      this.hub.log(`pi 模型表读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
    }
    return previous ?? piModelList([], {})
  }

  private async compactThread(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new PiRpcError(-32602, 'threadId 不能为空')
    const session = this.sessionFor(threadId, await this.metaFor(threadId))
    if (session.turnId || session.preparingTurn) throw new PiRpcError(-32602, '请先等待当前一轮结束')
    session.preparingTurn = true
    try {
      const rpc = await this.ensureRpc(session)
      if (session.turnId) throw new PiRpcError(-32602, '请先等待当前一轮结束')
      const turnId = randomUUID()
      const item = { type: 'contextCompaction', id: `${turnId}-compact`, status: 'inProgress' }
      session.turnId = turnId
      session.compacting = true
      session.state = emptyMapState()
      session.state.items[item.id] = item
      session.state.order.push(item.id)
      this.notify({ method: 'turn/started', params: { threadId, turn: buildTurn(turnId, [], 'inProgress') } })
      this.notify({ method: 'item/started', params: { threadId, turnId, item } })
      // 和 Codex 一样立即回执，压缩请求可在后台等待模型返回。
      void rpc.command('compact', {}, 5 * 60_000).then((response) => {
        if (session.turnId !== turnId) return
        const error = response.success === true ? null : scalarText(response.error) || 'pi 未完成上下文压缩'
        this.finishTurn(session, error ? 'failed' : 'completed', error)
        // 压缩期间开始的运行在压缩轮结束后接上。
        if (session.runActive) this.startAutonomousTurn(session)
      }, (error: unknown) => {
        if (session.turnId === turnId) this.finishTurn(session, 'failed', describe(error))
      })
      return {}
    } finally {
      session.preparingTurn = false
      this.touch(session)
    }
  }

  /** 按 turn/start 的 model/effort 切换；与当前一致时不发命令。切换失败让本轮失败，避免用错模型。 */
  private async applyModel(session: PiSession, rpc: PiRpcProcess, params: Json): Promise<void> {
    const key = scalarText(params.model)
    const target = key ? parsePiModelKey(key) : null
    if (target && key !== session.model) {
      const response = await rpc.command('set_model', target)
      if (response.success === false) {
        this.hub.log(`pi 切换模型失败: ${redact(scalarText(response.error))}`) // i18n-ignore: 仅进日志
        throw new PiRpcError(-32603, 'pi 切换模型失败，消息未发送')
      }
      session.model = key
      // 换模型后原思考档可能被 pi 调整，下一次显式选择要重新应用。
      delete session.thinkingLevel
    }
    const level = params.effort
    if (isPiLevel(level) && level !== session.thinkingLevel) {
      const response = await rpc.command('set_thinking_level', { level })
      if (response.success === false) {
        this.hub.log(`pi 切换思考强度失败: ${redact(scalarText(response.error))}`) // i18n-ignore: 仅进日志
        throw new PiRpcError(-32603, 'pi 切换思考强度失败，消息未发送，请检查当前模型支持的档位')
      }
      session.thinkingLevel = level
    }
  }

  private async turnInterrupt(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    const session = this.sessions.get(threadId)
    if (!session?.rpc || !session.turnId) {
      throw new PiRpcError(-32602, '没有运行中的 turn')
    }
    const rpc = session.rpc
    const turnId = session.turnId
    session.stoppingTurnId = turnId
    // 停止本轮等于放弃回答，否则 pi 会一直停在对话框上。
    this.dismissDialogs((open) => open.session === session, true)
    try {
      // 在途引导先让 pi 入队，随后一起清掉。
      await settledWithin(session.steering, STEER_SETTLE_MS)
      // 官方要求先 clear_queue 再 abort，否则 abort 后会继续执行队列里的消息。
      const cleared = await this.clearQueue(session, rpc)
      if (!cleared && session.pendingSteers.size > 0 && !session.meta.ephemeral) {
        // 旧版 pi 清不掉未送达的引导，只能结束进程；会话已落盘，下次使用时重新载入。
        await settledWithin(rpc.command('abort'), LEGACY_ABORT_MS)
        if (session.rpc === rpc) {
          this.closeRpc(session)
          this.finishTurn(session, 'interrupted', null)
        }
        return {}
      }
      await rpc.command('abort')
    } catch (error) {
      delete session.stoppingTurnId
      throw error
    }
    // abort 会等会话 idle；若 pi 没发 agent_settled，兜底按中断结束本轮。
    if (session.turnId === turnId) {
      const timer = setTimeout(() => {
        if (session.turnId !== turnId) return
        session.runActive = false
        this.finishTurn(session, 'interrupted', null)
      }, 1_500)
      timer.unref?.()
    }
    return {}
  }

  /** 撤掉 pi 里排队的引导和后续消息；返回 false 表示这个版本的 pi 清不掉。 */
  private async clearQueue(session: PiSession, rpc: PiRpcProcess): Promise<boolean> {
    try {
      const response = await rpc.command('clear_queue', {}, CLEAR_QUEUE_TIMEOUT_MS)
      if (response.success === true) {
        session.pendingSteers.clear()
        return true
      }
      this.hub.log(`pi 清空队列失败: ${redact(scalarText(response.error))}`) // i18n-ignore: 仅进日志
    } catch (err) {
      this.hub.log(`pi 清空队列失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
    }
    return false
  }

  private async turnSteer(params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    const session = this.sessions.get(threadId)
    const rpc = session?.rpc
    const turnId = scalarText(params.expectedTurnId)
    if (!rpc?.running || !session?.turnId || session.turnId !== turnId || session.compacting) {
      throw new PiRpcError(-32602, '当前轮次已结束或切换，请重新发送')
    }
    const { prompt, echo } = await resolvePiPrompt(params.input)
    // pi 没有客户端消息 ID；串行提交以保持相同的原生入队顺序。
    const previous = session.steering
    let release!: () => void
    session.steering = new Promise<void>((resolve) => { release = resolve })
    try {
      await previous
      if (session.turnId !== turnId || session.rpc !== rpc || session.stoppingTurnId === turnId) {
        throw new PiRpcError(-32602, '当前轮次已结束或切换，请重新发送')
      }
      const clientId = scalarText(params.clientUserMessageId) || null
      const itemId = `steer-${clientId ?? randomUUID()}`
      if (session.pendingSteers.has(itemId) || session.state.items[itemId]) return { turnId }
      const item = userMessageContentItem(itemId, echo, clientId)
      // pi 可能先发 message_start，再返回 steer 回执。
      session.pendingSteers.set(itemId, { item, turnId })
      try {
        const response = await rpc.command('steer', { ...prompt })
        if (response.success !== true) {
          throw new PiRpcError(-32602, scalarText(response.error) || 'pi 拒绝了引导消息')
        }
        // 扩展可能处理了输入，只有原生用户消息送达时才回显到对话。
        if (asRecord(response.data)?.disposition === 'handled') session.pendingSteers.delete(itemId)
      } catch (error) {
        session.pendingSteers.delete(itemId)
        throw error
      }
      return { turnId }
    } finally {
      release()
    }
  }

  private onPiEvent(session: PiSession, event: RpcRecord): void {
    // 只有运行事件能开轮次；空闲时的扩展消息、压缩、队列变化等不算运行。
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      session.runActive = true
      if (!session.turnId) this.startAutonomousTurn(session)
    } else if (event.type === 'agent_settled') {
      session.runActive = false
    }
    if (!session.turnId) {
      // 运行开始前 pi 可能先压缩上下文，顺延空闲计时。
      if (event.type === 'compaction_start' || event.type === 'compaction_end') this.touch(session)
      return
    }
    if (session.compacting) {
      if (event.type === 'compaction_end' && event.reason === 'manual' && event.aborted === true) {
        this.finishTurn(session, 'interrupted', null)
      }
      return
    }
    if (event.type === 'message_start') {
      const message = asRecord(event.message)
      if (message?.role === 'user') this.onUserMessage(session, session.turnId, message)
    }
    const ctx = { threadId: session.meta.id, turnId: session.turnId, cwd: session.meta.cwd }
    const mapped = mapPiEventSafe(event, ctx, session.state)
    session.state = mapped.state
    for (const note of mapped.notifications) this.notify(note)
    if (mapped.turnEnd) {
      this.dismissDialogs((open) => open.session === session && open.turnId === ctx.turnId, true)
      session.turnId = null
      delete session.pendingUserItem
      this.historyPages.clear(session.meta.id)
      this.touch(session)
      void this.reportContextUsage(session, ctx.turnId, session.state.totalUsage)
    }
  }

  /** 扩展触发或排队续跑的运行没有对应的客户端请求，为它建立轮次，agent_settled 时照常结束。 */
  private startAutonomousTurn(session: PiSession): void {
    // 分叉用的临时进程和尚未拿到 ID 的会话没有可展示轮次的对话。
    if (this.sessions.get(session.meta.id) !== session || session.meta.id.startsWith(PENDING_PREFIX)) return
    const turnId = randomUUID()
    session.turnId = turnId
    session.state = emptyMapState()
    delete session.pendingUserItem
    this.notify({
      method: 'turn/started',
      params: { threadId: session.meta.id, turn: buildTurn(turnId, [], 'inProgress') },
    })
  }

  private onUserMessage(session: PiSession, turnId: string, message: Json): void {
    let identity = session.pendingUserItem
    if (identity) delete session.pendingUserItem
    else {
      let item: V2Item
      const next = session.pendingSteers.entries().next().value
      if (next) {
        const [id, pending] = next
        session.pendingSteers.delete(id)
        const steering = turnId === pending.turnId ? 'currentTurn' : 'nextTurn'
        item = { ...pending.item, steering }
        identity = { id, clientId: scalarText(pending.item.clientId) || null, steering }
      } else {
        // 扩展或排队续跑带来的用户消息；首条沿用 `-user` 后缀，分叉时按它定位轮次。
        const content = userEcho(message.content)
        if (content.length === 0) return
        const first = `${turnId}-user`
        const id = session.state.items[first] ? `${first}-${++session.state.nextItem}` : first
        item = userMessageContentItem(id, content, null)
        identity = { id, clientId: null }
      }
      session.state.items[identity.id] = item
      session.state.order.push(identity.id)
      this.notify(itemCompleted({ threadId: session.meta.id, turnId, cwd: session.meta.cwd }, item))
    }
    // pi 不接收客户端消息 ID，沿用原生用户消息在事件和历史中共有的时间戳。
    const timestamp = finite(message.timestamp)
    if (timestamp === null) return
    const key = String(timestamp)
    const previous = session.userItemIds.get(key)
    session.userItemIds.set(key, previous === undefined ? identity : null)
    if (identity.steering || previous?.steering) this.persistSteers(session)
  }

  private persistSteers(session: PiSession): void {
    if (session.meta.ephemeral) return
    const entries = [...session.userItemIds].flatMap(([key, identity]) => identity?.steering ? [[key, identity] as const] : [])
    this.steerHistory.write(session.meta.id, entries)
  }

  private onRpcExit(session: PiSession, rpc: PiRpcProcess, info: { code: number | null }): void {
    // closeRpc 会先置空 session.rpc，预期关闭不按崩溃处理。
    if (session.rpc !== rpc) return
    session.rpc = null
    session.runActive = false
    session.pendingSteers.clear()
    this.dismissDialogs((open) => open.rpc === rpc, false)
    if (session.turnId) this.finishTurn(session, 'failed', 'pi 进程提前退出')
    if (session.meta.ephemeral) this.forgetTemporary(session.meta.id)
    this.hub.log(`pi 会话进程退出 (thread=${session.meta.id} code=${String(info.code)})`) // i18n-ignore: 仅进日志
  }

  private finishTurn(session: PiSession, status: string, error: string | null): void {
    const turnId = session.turnId
    if (!turnId) return
    const ctx = { threadId: session.meta.id, turnId, cwd: session.meta.cwd }
    if (session.compacting && status === 'interrupted') {
      const item = session.state.items[`${turnId}-compact`]
      if (item) {
        item.status = 'interrupted'
        this.notify({ method: 'item/completed', params: { threadId: session.meta.id, turnId, item } })
      }
    }
    this.dismissDialogs((open) => open.session === session && open.turnId === turnId, true)
    for (const note of finishTurnNotifications(ctx, session.state, status, error)) this.notify(note)
    session.turnId = null
    delete session.pendingUserItem
    session.compacting = false
    this.historyPages.clear(session.meta.id)
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
      this.hub.log(`pi 会话目录读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
      return []
    }
  }

  private sessionFor(threadId: string, meta: PiSessionMeta): PiSession {
    const existing = this.sessions.get(threadId)
    if (existing) return existing
    const session = this.makeSession(meta)
    this.sessions.set(threadId, session)
    return session
  }

  private makeSession(meta: PiSessionMeta): PiSession {
    return {
      meta,
      rpc: null,
      starting: null,
      preparingTurn: false,
      compacting: false,
      turnId: null,
      runActive: false,
      pendingSteers: new Map(),
      userItemIds: meta.ephemeral ? new Map() : this.steerHistory.read(meta.id),
      state: emptyMapState(),
      idleTimer: null,
    }
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
      extraArgs: session.meta.ephemeral ? ['--no-session', '--no-tools', '--no-extensions'] : [],
      log: (message) => this.hub.log(message),
    }
    const rpc = this.options.createRpc
      ? this.options.createRpc(rpcOptions)
      : new PiRpcProcess(rpcOptions)
    session.rpc = rpc
    delete session.model
    delete session.thinkingLevel
    // 已关闭的进程收尾时仍可能发事件，不能让它再开轮次。
    rpc.onEvent((event) => { if (session.rpc === rpc) this.onPiEvent(session, event) })
    rpc.onDialog((record) => this.onPiDialog(session, rpc, record))
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
      if (!session.meta.ephemeral && !session.meta.id.startsWith(PENDING_PREFIX) && this.sessions.get(session.meta.id) === session) {
        void this.readModels(rpc, true)
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
    this.dismissDialogs((open) => open.rpc === rpc, true)
    session.rpc = null
    session.runActive = false
    session.pendingSteers.clear()
    rpc.close()
  }

  private onPiDialog(session: PiSession, rpc: PiRpcProcess, record: RpcRecord): void {
    const dialog = parsePiDialog(record)
    if (!dialog) return
    // 尚未建好或仅用于分叉的临时进程没有可展示问题的会话，只能取消。
    if (session.rpc !== rpc || this.sessions.get(session.meta.id) !== session || session.meta.id.startsWith(PENDING_PREFIX)) {
      this.hub.log('pi 扩展对话框发生在会话就绪之前，已取消') // i18n-ignore: 仅进日志
      rpc.respondDialog({ type: 'extension_ui_response', id: dialog.id, cancelled: true })
      return
    }
    const requestId = `qn-pi-ui-${++this.counter}`
    const timer = dialog.timeoutMs === null ? null : setTimeout(() => this.closeDialog(requestId, null), dialog.timeoutMs)
    timer?.unref?.()
    this.dialogs.set(requestId, { session, rpc, dialog, turnId: session.turnId, timer })
    this.emit({
      id: requestId,
      method: 'item/tool/requestUserInput',
      params: { threadId: session.meta.id, turnId: session.turnId, questions: piDialogQuestions(dialog) },
    })
  }

  /** response 为 null 表示 pi 已按 timeout 收场，只撤卡片不回写。 */
  private closeDialog(requestId: JsonRpcId, response: unknown): void {
    const open = this.dialogs.get(requestId)
    if (!open) return
    this.dialogs.delete(requestId)
    if (open.timer) clearTimeout(open.timer)
    if (response === null) open.rpc.releaseDialog(open.dialog.id)
    else open.rpc.respondDialog(piDialogResponse(open.dialog, response))
    this.notify({ method: 'serverRequest/resolved', params: { threadId: open.session.meta.id, requestId } })
  }

  private dismissDialogs(match: (open: OpenDialog) => boolean, reply: boolean): void {
    for (const [requestId, open] of this.dialogs) {
      if (match(open)) this.closeDialog(requestId, reply ? {} : null)
    }
  }

  private forgetTemporary(threadId: string): void {
    this.historyPages.clear(threadId)
    this.sessions.delete(threadId)
    this.metas.delete(threadId)
    this.notify({ method: 'thread/closed', params: { threadId } })
  }

  private touch(session: PiSession): void {
    if (!this.opened || session.meta.ephemeral) return
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.turnId || session.preparingTurn || session.runActive) return
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

/**
 * 会话的模型与思考档位：本进程已切换过的值最新，其次读会话文件里最后一次的记录。
 * 临时会话没有文件，返回空值由客户端沿用默认选择。
 */
function sessionConfig(session: PiSession): PiSessionConfig {
  const saved = session.meta.sessionFile && !session.meta.ephemeral
    ? readPiSessionConfig(session.meta.sessionFile)
    : { model: null, thinkingLevel: null }
  return { model: session.model ?? saved.model, thinkingLevel: session.thinkingLevel ?? saved.thinkingLevel }
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

/** 等任务结束（成败都算），超时就不再等。 */
async function settledWithin(task: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!task) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  const done = task.then(() => undefined, () => undefined)
  await Promise.race([done, timeout])
  clearTimeout(timer)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
