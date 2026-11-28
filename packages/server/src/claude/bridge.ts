/**
 * Claude Agent SDK → codex app-server v2 的桥：会话表、异步输入队列、turn 生命周期、
 * 审批、中断、空闲关闭与错误恢复。只发 v2 JSON-RPC，与客户端的渲染链路完全复用。
 */
import { randomUUID } from 'node:crypto'
import type { ElicitationRequest, ElicitationResult, Options, PermissionMode, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ThreadStatus } from '../../../../vendor/codex-protocol/ts/v2/ThreadStatus'
import { classifyJsonRpc, type JsonRpcId } from '@qn/protocol'
import {
  AgentHostError,
  agentConfigEnv,
  JsonRpcAgentHost,
  parseAgentConfigDir,
  type AgentHost,
  type AgentHostHub,
  type AgentOpenOptions,
} from '../codexHost'
import { redact } from '../log'
import { ArchiveStore } from '../archiveStore'
import { SteerHistoryStore } from '../steerHistory'
import { VERSION } from '../version'
import { nativeAgentCwd } from '../workspace/paths'
import { buildApprovalRequest, permissionResult } from './approval'
import { ContextWindowStore, resultModelWindow } from './contextWindows'
import { lastContextUsage, lastReplyModel, parseClaudeSteer, sessionInfoToMeta, sessionMessagesToThread, threadListResponse, type ClaudeSteerHistory } from './history'
import { backgroundTaskList, rewindResponse, slashCommandList, type BackgroundTask, type RewindResponse } from './controls'
import { HistoryPageCache, listHistoryItems, listHistoryTurns } from './historyPages'
import { BridgeRpcError } from './errors'
import { emptyMapState, finishPendingItems, mapSdkMessage, nextTurnState, type MapState } from './items'
import { sidechainItemId, withActivity } from './sidechain'
import { withdrawMessages } from './withdraw'
import {
  DEFAULT_MODEL,
  NO_OVERRIDES,
  parseOverrides,
  queryOverrides,
  settingsDiff,
  staticModelList,
  supportedModelList,
  threadModelConfig,
  type ClaudeSettings,
} from './models'
import { commandMetadata, SkillsCatalog } from './skills'
import { isolatedClaudeSessionReader, type ClaudeSessionReader } from './sessionReader'
import { ClaudeStatusLine, statusLineProfile } from './statusLine'
import { resolveTurnInput, type ContentBlock, type TurnContent } from './userInput'
import { ASK_USER_TOOL, askUserResult, buildUserInputRequest } from './askUser'
import { buildElicitationRequest, elicitationResult } from './elicitation'
import { resolveClaudeExecutable, type ClaudeExecutable } from './resolve'
import { readVersionAsync } from '../versionProbe'
import {
  activeSdkWindows,
  asRecord,
  buildThread,
  CLAUDE_SDK_WINDOWS_LIMIT_ID,
  buildTurn,
  emptyRateLimitsResponse,
  finite,
  isRecord,
  itemCompleted,
  nextSdkWindowReset,
  rateLimitSnapshot,
  scalarText,
  userMessageContentItem,
  type Json,
  type SessionMeta,
  type V2Item,
  type V2Notification,
} from './v2'

export interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>
  close(): void
  // 以下为流式输入模式下的控制接口；测试替身可以不实现。
  supportedModels?(): Promise<unknown[]>
  supportedCommands?(): Promise<unknown[]>
  setModel?(model?: string): Promise<void>
  setPermissionMode?(mode: PermissionMode): Promise<void>
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>
  getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>
  stopTask?(taskId: string): Promise<void>
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>
}

/** 可注入的 SDK 门面：真机走动态 import，测试注入假的 query 工厂。 */
export interface ClaudeDeps extends ClaudeSessionReader {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): QueryLike
}

export interface ClaudeBridgeOptions {
  deps?: ClaudeDeps
  sessionReader?: (directory: string) => ClaudeSessionReader
  resolve?: (claudePath?: string) => ClaudeExecutable
  idleTimeoutMs?: number
  stateDir?: string
}

interface BridgeSession {
  scope: ClaudeScope
  meta: SessionMeta
  query: QueryLike | null
  input: AsyncQueue<SDKUserMessage> | null
  turnId: string | null
  turnMessageIds: Map<string, string>
  /** 轮次 → 开启它的用户消息 UUID，即该轮开始前的文件检查点。 */
  turnStartIds: Map<string, string>
  pendingSteers: Map<string, { item: V2Item; turnId: string }>
  /** 轮次进行中经 turn/start 追加、SDK 尚未确认处理的消息 UUID。 */
  queuedAppends: Set<string>
  /** 用户按停止时尚未处理的消息 UUID → 当时被停止的轮次。 */
  stoppedSteers: Map<string, string | null>
  /** Claude 自行开始且没有并入用户输入的轮次；只有它能由会话空闲状态收尾。 */
  agentTurnId: string | null
  /** 为排队引导预先开启、还没有任何输出的轮次。 */
  queuedTurnId: string | null
  /** 用户请求停止过的轮次。 */
  interruptedTurnId: string | null
  /** 当前 CLI 进程里仍在运行的后台任务，不含 ambient 监听任务。 */
  backgroundTasks: BackgroundTask[]
  rewinding: boolean
  steerHistory: Map<string, ClaudeSteerHistory>
  compaction: boolean
  preparingTurn: boolean
  state: MapState
  queryCreated: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 当前 query 已生效的模型/推理强度；null 表示沿用 Claude 自身配置。 */
  settings: ClaudeSettings
  /** 历史里最近一次回复的模型；读过历史后才有，用于没有显式覆盖时回报会话模型。 */
  historyModel?: string | null
  permissionMode: PermissionMode
  allowsBypass: boolean
  /** 已向 SDK 查询过上下文窗口；每个会话只查一次，失败也不重试。 */
  contextWindowProbed?: boolean
}

interface ClaudeScope {
  directory: string | undefined
  sessions: Map<string, BridgeSession>
  metas: Map<string, SessionMeta>
  historyPages: HistoryPageCache
  sdkRateLimits: Json
  sdkObservedAt: number | null
  sdkResetsAt: number | null
  sdkResetTimer?: ReturnType<typeof setTimeout>
  statusLine: ClaudeStatusLine
  realModels: Json | null
  modelListRequest: Promise<Json> | null
}

interface PendingApproval {
  session: BridgeSession
  resolve(result: PermissionResult): void
  suggestions: unknown
  /** 提问类请求（AskUserQuestion）把回答转换成 canUseTool 结果；普通审批为空。 */
  toResult?: (response: unknown) => PermissionResult
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

let sdkPromise: Promise<ClaudeDeps> | null = null

/**
 * SDK 的 JS 由 esbuild 打进 qn-server.cjs；动态 import 让只用 Codex 的 daemon
 * 不在启动时加载这份大模块（CJS 产物里的 import.meta.url 由 build.mjs 的 define 补齐）。
 */
async function loadSdk(): Promise<ClaudeDeps> {
  sdkPromise ??= (async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    return {
      query: (params) => sdk.query(params) as QueryLike,
      listSessions: (options) => sdk.listSessions(options),
      getSessionInfo: (sessionId) => sdk.getSessionInfo(sessionId),
      getSessionMessages: (sessionId, options) => sdk.getSessionMessages(sessionId, options),
      forkSession: (sessionId, options) => sdk.forkSession(sessionId, options),
      deleteSession: (sessionId, options) => sdk.deleteSession(sessionId, options),
      renameSession: (sessionId, title, options) => sdk.renameSession(sessionId, title, options),
    }
  })()
  return sdkPromise
}

/** 一个可等待的流式输入队列；SDK 的 query 以 AsyncIterable<SDKUserMessage> 为 prompt。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

export function createClaudeHost(
  hub: AgentHostHub,
  version: string = VERSION,
  options: ClaudeBridgeOptions = {},
): AgentHost {
  return new ClaudeBridge(hub, version, options)
}

export class ClaudeBridge extends JsonRpcAgentHost {
  private opened = false
  private initializeResult: Json = {}
  private claude: ClaudeExecutable | null = null
  private deps: ClaudeDeps | null = null
  private configDir: string | undefined
  private readonly scopes = new Map<string | undefined, ClaudeScope>()
  private readonly statusLines = new Map<string, ClaudeStatusLine>()
  private readonly approvals = new Map<JsonRpcId, PendingApproval>()
  private readonly elicitations = new Map<JsonRpcId, { session: BridgeSession; resolve(result: ElicitationResult): void }>()
  private readonly idleTimeoutMs: number
  private readonly steerHistory: SteerHistoryStore<ClaudeSteerHistory>
  private readonly archives: ArchiveStore
  private readonly contextWindows: ContextWindowStore
  private requestCounter = 0
  private readonly skills = new SkillsCatalog()

  constructor(
    hub: AgentHostHub,
    version: string = VERSION,
    private readonly options: ClaudeBridgeOptions = {},
  ) {
    super(hub, version, 'claude-bridge', 'claude')
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.steerHistory = new SteerHistoryStore(options.stateDir, 'claude', parseClaudeSteer, (msg) => this.hub.log(msg))
    this.archives = new ArchiveStore(options.stateDir, 'claude', (msg) => this.hub.log(msg))
    this.contextWindows = new ContextWindowStore(options.stateDir, (msg) => this.hub.log(msg))
  }

  protected async openAgent(options: AgentOpenOptions): Promise<{
    initialize: unknown
    agentVersion?: string
  }> {
    const directory = parseAgentConfigDir(options.claudeConfigDir, 'CLAUDE_CONFIG_DIR')
    const previous = this.opened ? this.currentScope() : undefined
    this.configDir = directory
    if (this.opened) {
      const current = this.currentScope()
      if (previous && previous !== current) {
        for (const session of previous.sessions.values()) {
          if (session.meta.ephemeral) this.touch(session)
        }
        this.notifyRateLimits(current)
      }
      return { initialize: this.initializeResult, agentVersion: this.claude?.version }
    }
    const explicit =
      typeof options.claudePath === 'string' && options.claudePath.trim()
        ? options.claudePath.trim()
        : undefined
    // 默认路径下版本号异步读取并与 SDK 加载并行，不用 spawnSync 阻塞 daemon。
    const resolved = this.options.resolve
      ? this.options.resolve(explicit)
      : resolveClaudeExecutable(explicit, { versionOf: () => 'unknown' })
    const version = this.options.resolve ? Promise.resolve(resolved.version) : readVersionAsync({ command: resolved.path })
    try {
      const [deps, detected] = await Promise.all([this.options.deps ?? loadSdk(), version])
      this.deps = deps
      resolved.version = detected
    } catch (err) {
      throw new AgentHostError('agent_unavailable', `Claude SDK 加载失败: ${describe(err)}`)
    }
    this.claude = resolved
    this.initializeResult = { userAgent: `claude-bridge/${resolved.version}` }
    this.opened = true
    this.hub.log(`claude 桥已就绪 ${resolved.version}`) // i18n-ignore: 仅进日志
    return { initialize: this.initializeResult, agentVersion: resolved.version }
  }

  get backgroundTasks(): number {
    let count = 0
    for (const scope of this.scopes.values()) {
      for (const session of scope.sessions.values()) count += session.backgroundTasks.length
    }
    return count
  }

  protected agentStatus(): { running: boolean; pid?: number } {
    return { running: this.opened }
  }

  protected sendToAgent(msg: Json): void {
    void this.dispatch(msg).catch((err: unknown) => {
      this.hub.log(`claude 消息处理失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
    })
  }

  protected detachAgent(_clientId: number): void {}

  protected closeAgent(): void {
    this.opened = false
    for (const feed of this.statusLines.values()) feed.close()
    this.statusLines.clear()
    for (const scope of this.scopes.values()) {
      clearTimeout(scope.sdkResetTimer)
      scope.historyPages.clear()
      for (const session of scope.sessions.values()) {
        if (session.idleTimer) clearTimeout(session.idleTimer)
        this.closeQuery(session)
      }
    }
    for (const pending of this.approvals.values()) {
      pending.resolve({ behavior: 'deny', message: 'server 正在退出' }) // i18n-ignore: 回给模型的拒绝原因
    }
    this.approvals.clear()
    for (const pending of this.elicitations.values()) pending.resolve({ action: 'cancel' })
    this.elicitations.clear()
    this.scopes.clear()
  }

  private currentScope(): ClaudeScope {
    const directory = (this.configDir ?? process.env.CLAUDE_CONFIG_DIR) || undefined
    return this.scopeFor(directory)
  }

  private scopeFor(directory: string | undefined): ClaudeScope {
    let scope = this.scopes.get(directory)
    if (!scope) {
      const created: ClaudeScope = {
        directory,
        sessions: new Map(),
        metas: new Map(),
        historyPages: new HistoryPageCache(),
        sdkRateLimits: rateLimitSnapshot(),
        sdkObservedAt: null,
        sdkResetsAt: null,
        statusLine: this.statusLineFor(statusLineProfile(directory)),
        realModels: null,
        modelListRequest: null,
      }
      this.scopes.set(directory, created)
      scope = created
    }
    return scope
  }

  ingestStatusLine(directory: string, windows: unknown): void {
    this.statusLineFor(statusLineProfile(directory)).ingest(windows)
  }

  private statusLineFor(profile: string): ClaudeStatusLine {
    const existing = this.statusLines.get(profile)
    if (existing) return existing
    const feed = new ClaudeStatusLine(() => {
      if (!this.opened) return
      const scope = this.currentScope()
      if (scope.statusLine === feed) this.notifyRateLimits(scope)
    })
    this.statusLines.set(profile, feed)
    return feed
  }

  private quotaSnapshot(scope: ClaudeScope): Json {
    const rejected = scope.sdkRateLimits.rateLimitReachedType
    const active = scope.sdkResetsAt === null || scope.sdkResetsAt * 1000 > Date.now()
    if (rejected && active) {
      return { ...scope.sdkRateLimits, observedAt: scope.sdkObservedAt, rejectionResetsAt: scope.sdkResetsAt }
    }
    const sdkWindows = scope.sdkRateLimits.limitId === CLAUDE_SDK_WINDOWS_LIMIT_ID
      ? activeSdkWindows(scope.sdkRateLimits)
      : null
    const { primary, secondary, observedAt } = scope.statusLine.snapshot()
    // 两个来源都是官方 CLI 的读数，取较新的一份。
    if ((primary || secondary) && (!sdkWindows || (observedAt ?? 0) > (scope.sdkObservedAt ?? 0))) {
      return {
        ...rateLimitSnapshot(),
        limitId: 'claude-statusline',
        limitName: 'Claude CLI 状态栏',
        primary,
        secondary,
        observedAt,
      }
    }
    if (sdkWindows) return { ...sdkWindows, observedAt: scope.sdkObservedAt }
    return active && scope.sdkRateLimits.primary
      ? { ...scope.sdkRateLimits, observedAt: scope.sdkObservedAt }
      : rateLimitSnapshot()
  }

  private notifyRateLimits(scope: ClaudeScope): void {
    if (!this.opened || scope !== this.currentScope()) return
    this.notify({ method: 'account/rateLimits/updated', params: { rateLimits: this.quotaSnapshot(scope) } })
  }

  private onRateLimitEvent(scope: ClaudeScope, info: unknown): void {
    const reset = finite(asRecord(info)?.resetsAt)
    scope.sdkRateLimits = rateLimitSnapshot(info)
    scope.sdkObservedAt = Date.now()
    scope.sdkResetsAt = reset === null ? null : Math.abs(reset) > 1e11 ? reset / 1000 : reset
    this.scheduleSdkReset(scope)
    this.notifyRateLimits(scope)
  }

  /** 到达拒绝或窗口的重置时间时重新推送，让界面移除过期读数。 */
  private scheduleSdkReset(scope: ClaudeScope): void {
    clearTimeout(scope.sdkResetTimer)
    const limits = scope.sdkRateLimits
    const now = Date.now()
    const candidates: number[] = []
    if (limits.limitId === CLAUDE_SDK_WINDOWS_LIMIT_ID) {
      const next = nextSdkWindowReset(limits, now)
      if (next !== null) candidates.push(next)
    }
    if (scope.sdkResetsAt !== null && (limits.rateLimitReachedType || limits.primary)) candidates.push(scope.sdkResetsAt)
    const delay = Math.min(...candidates.map((at) => at * 1000 - now).filter((ms) => ms > 0))
    if (!Number.isFinite(delay) || delay > 2_147_483_647) return
    scope.sdkResetTimer = setTimeout(() => {
      this.notifyRateLimits(scope)
      this.scheduleSdkReset(scope)
    }, Math.ceil(delay))
    scope.sdkResetTimer.unref()
  }

  private sessionReader(scope: ClaudeScope): ClaudeSessionReader {
    const deps = this.requireDeps()
    const directory = scope.directory
    if (!directory || directory === process.env.CLAUDE_CONFIG_DIR) return deps
    return this.options.sessionReader?.(directory) ?? (this.options.deps ? deps : isolatedClaudeSessionReader(directory))
  }

  private async dispatch(msg: Json): Promise<void> {
    const kind = classifyJsonRpc(msg)
    if (kind === 'response') {
      this.resolveApproval(msg)
      return
    }
    if (kind !== 'request') return
    const id = msg.id as JsonRpcId
    const method = scalarText(msg.method)
    const params = asRecord(msg.params) ?? {}
    try {
      const result = await this.handleRequest(method, params, this.currentScope())
      this.emit({ id, result })
    } catch (err) {
      const code = err instanceof BridgeRpcError ? err.code : -32603
      const message = describe(err)
      this.hub.log(`claude ${method} 失败: ${redact(message)}`) // i18n-ignore: 仅进日志
      this.emit({ id, error: { code, message } })
    }
  }

  private async handleRequest(method: string, params: Json, scope: ClaudeScope): Promise<unknown> {
    // 模型列表不依赖 SDK 会话：无活动会话时也要能给出别名列表（R9 禁止为探测开会话）。
    if (method === 'model/list') return this.listModels(scope)
    const cwd = typeof params.cwd === 'string' ? nativeAgentCwd(params.cwd) : undefined
    switch (method) {
      case 'initialize':
        return this.initializeResult
      case 'account/read':
        return { account: null }
      case 'account/rateLimits/read': {
        const snapshot = this.quotaSnapshot(scope)
        return { ...emptyRateLimitsResponse(), rateLimits: snapshot, rateLimitsByLimitId: { claude: snapshot } }
      }
      case 'thread/unsubscribe': {
        const threadId = scalarText(params.threadId)
        const session = scope.sessions.get(threadId)
        if (!session) return { status: 'notLoaded' }
        if (!session.meta.ephemeral) throw new BridgeRpcError(-32602, '仅可结束临时会话')
        if (session.turnId || session.preparingTurn) throw new BridgeRpcError(-32602, '请先停止当前轮次')
        this.closeQuery(session)
        this.forgetTemporary(session)
        return { status: 'unsubscribed' }
      }
      case 'thread/list': {
        const limit = typeof params.limit === 'number' && Number.isSafeInteger(params.limit) && params.limit > 0
          ? params.limit : undefined
        const dirs = Array.isArray(params.cwd)
          ? [...new Set(params.cwd.filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
            .map((dir) => nativeAgentCwd(dir)))]
          : [cwd || undefined]
        const metas = new Map<string, SessionMeta>()
        const reader = this.sessionReader(scope)
        // 与 Codex 的 thread/list 一致：archived=true 只列归档，否则排除归档。
        const archived = params.archived === true
        for (const dir of dirs) {
          const infos = await reader.listSessions({ dir, limit, ...(Array.isArray(params.cwd) ? { includeWorktrees: false } : {}) })
          for (const info of infos) {
            const meta = sessionInfoToMeta(info, dir ?? process.cwd())
            if (!meta.id || metas.has(meta.id)) continue
            scope.metas.set(meta.id, meta)
            if (this.archives.has(meta.id) !== archived) continue
            metas.set(meta.id, meta)
          }
        }
        return threadListResponse([...metas.values()], limit, (id) => this.threadStatus(scope, id))
      }
      case 'thread/archive':
      case 'thread/unarchive': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        const archive = method === 'thread/archive'
        // 广播与 Codex 同名的通知，同一目标上的电脑和手机都据此移出或恢复列表。
        if (this.archives.set(threadId, archive)) {
          this.notify({ method: archive ? 'thread/archived' : 'thread/unarchived', params: { threadId } })
        }
        return {}
      }
      case 'thread/delete':
        return this.deleteThread(scope, params)
      case 'thread/name/set':
        return this.renameThread(scope, params)
      case 'thread/start': {
        const id = randomUUID()
        const ephemeral = params.ephemeral === true
        const settings = parseOverrides(params, NO_OVERRIDES)
        const meta: SessionMeta = { id, cwd: cwd || process.cwd(), preview: '', ephemeral }
        const thread = buildThread(meta, [], threadModelConfig(settings))
        scope.sessions.set(id, makeSession(scope, meta, false, settings))
        scope.metas.set(id, meta)
        this.notify({ method: 'thread/started', params: { thread } })
        return threadStartResult(meta, settings, thread)
      }
      case 'thread/fork':
        return this.forkThread(scope, params)
      case 'thread/resume':
      case 'thread/read':
      case 'thread/turns/list':
      case 'thread/items/list': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        const session = await this.sessionFor(scope, threadId, cwd)
        const metadataOnly = (method === 'thread/resume' && params.excludeTurns === true)
          || (method === 'thread/read' && params.includeTurns === false)
        const paged = method === 'thread/turns/list' || method === 'thread/items/list'
        const load = async () => {
          const messages = await this.sessionReader(scope).getSessionMessages(threadId, { dir: session.meta.cwd })
          session.historyModel = lastReplyModel(messages)
          const history = sessionMessagesToThread(session.meta,
            messages.filter((message) => !session.pendingSteers.has(scalarText(asRecord(message)?.uuid))),
            {}, session.state.taskNotifications.deliveryIds, session.steerHistory)
          // 续用的会话从历史认回已有任务，之后只带 ID 的 TaskUpdate 才能对上。
          if (!session.turnId && session.state.plan.tasks.size === 0) session.state = { ...session.state, plan: history.plan }
          // 历史轮次 ID 按下标生成，压缩后会错位；记下发给客户端时对应的消息，回滚按它定位。
          for (const point of history.forkPoints) {
            if (point.promptMessageId) session.turnStartIds.set(point.turnId, point.promptMessageId)
          }
          // 用量只在轮次进行中推送，打开历史会话时用最近一次回复的 usage 补上占用读数。
          const last = session.turnId ? null : lastContextUsage(messages)
          const lastTurnId = scalarText(asRecord(history.turns.at(-1))?.id)
          if (last && lastTurnId) {
            this.notify({ method: 'thread/tokenUsage/updated', params: {
              threadId,
              turnId: lastTurnId,
              tokenUsage: { total: last, last, estimated: true,
                modelContextWindow: session.state.contextWindow ?? this.contextWindows.lookup(threadId, session.historyModel, last.totalTokens) },
            } })
          }
          return withActivity(history.turns, session.state.sidechains)
        }
        // 没有本进程的显式覆盖时，回报历史里最近一次回复的模型，客户端据此恢复该会话的选择。
        const configOf = () => {
          const config = threadModelConfig(session.settings)
          return config.model ? config : { ...config, model: session.historyModel ?? null }
        }
        if (metadataOnly) {
          if (!session.settings.model && session.historyModel === undefined && !session.meta.ephemeral) {
            await scope.historyPages.read(threadId, false, load, true).catch(() => undefined)
          }
          return { thread: { ...buildThread(session.meta, [], configOf()), status: this.threadStatus(scope, threadId), historyMode: 'paginated' } }
        }
        const saved = await (paged
          ? scope.historyPages.read(threadId, params.cursor != null || method === 'thread/items/list', load)
          : load())
        // 正在运行的条目由事件流补齐，避免和 SDK 已经写入历史的内容重复。
        const active = session.turnId
        const plan = session.state.turnPlan
        const turns = active ? [...saved, {
          ...buildTurn(active, [], 'inProgress'),
          ...(plan ? { plan: { explanation: null, plan } } : {}),
        }] : saved
        if (method === 'thread/turns/list') return listHistoryTurns(threadId, turns, params)
        if (method === 'thread/items/list') return listHistoryItems(threadId, turns, params)
        return { thread: { ...buildThread(session.meta, turns, configOf()), status: this.threadStatus(scope, threadId) } }
      }
      case 'thread/compact/start': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        const session = await this.sessionFor(scope, threadId, cwd)
        // Agent SDK 通过普通输入接收原生 /compact。沿用会话已有设置与权限。
        await this.startTurn(session, { blocks: [{ type: 'text', text: '/compact' }], echo: [], text: '/compact' },
          session.settings, session.permissionMode, null, true)
        return {}
      }
      case 'turn/start': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        const permissionMode = parsePermissionMode(params.claudePermissionMode)
        const content = await resolveTurnInput(params.input)
        const session = await this.sessionFor(scope, threadId, cwd)
        // SDK 将输入 UUID 持久化到 SessionMessage.uuid，历史与实时回显因此可以共用同一个条目 ID。
        return this.startTurn(session, content, parseOverrides(params, session.settings), permissionMode,
          clientMessageId(params.clientUserMessageId))
      }
      case 'turn/steer': {
        const session = scope.sessions.get(scalarText(params.threadId))
        const turnId = scalarText(params.expectedTurnId)
        if (!session?.turnId || session.turnId !== turnId || session.compaction) {
          throw new BridgeRpcError(-32602, '当前轮次已结束或切换，请重新发送')
        }
        const content = await resolveTurnInput(params.input)
        if (session.turnId !== turnId || !session.input) {
          throw new BridgeRpcError(-32602, '当前轮次已结束或切换，请重新发送')
        }
        const clientId = clientMessageId(params.clientUserMessageId)
        const messageId = clientId ?? randomUUID()
        if (!session.pendingSteers.has(messageId) && !session.state.items[messageId]) {
          this.pushInput(session, content.blocks, messageId, true)
          session.pendingSteers.set(messageId, { item: userMessageContentItem(messageId, content.echo, clientId), turnId })
        }
        return { turnId }
      }
      case 'skills/list': {
        const requested = Array.isArray(params.cwds)
          ? params.cwds.filter((c): c is string => typeof c === 'string' && c.length > 0)
          : []
        const cwds = requested.length > 0 ? requested : [scope.sessions.values().next().value?.meta.cwd ?? process.cwd()]
        return this.listSkills(scope, cwds, params.forceReload === true)
      }
      case 'turn/interrupt': {
        const threadId = scalarText(params.threadId)
        const session = scope.sessions.get(threadId)
        if (!session?.query) throw new BridgeRpcError(-32602, '没有运行中的 turn')
        await this.interrupt(session, session.query)
        this.hub.log(`claude turn 已请求中断 (thread=${threadId})`) // i18n-ignore: 仅进日志
        return {}
      }
      case 'qingcode/backgroundTasks/list': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        // 只读本进程的记录，不为此读历史或启动会话（R9）。
        return { tasks: scope.sessions.get(threadId)?.backgroundTasks ?? [] }
      }
      case 'qingcode/backgroundTasks/stop': {
        const threadId = scalarText(params.threadId)
        const taskId = scalarText(params.taskId)
        if (!threadId || !taskId) throw new BridgeRpcError(-32602, 'threadId 与 taskId 不能为空')
        const query = scope.sessions.get(threadId)?.query
        if (!query?.stopTask) throw new BridgeRpcError(-32602, '该会话没有运行中的后台任务')
        await query.stopTask(taskId)
        return {}
      }
      case 'qingcode/commands/list': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        return this.listCommands(scope.sessions.get(threadId)?.query ?? null)
      }
      case 'qingcode/files/rewind':
        return this.rewindFiles(scope, params, cwd)
      default:
        throw new BridgeRpcError(-32601, `不支持的 v2 方法: ${method}`)
    }
  }

  /**
   * 只从用户自己已开启的 query 读真实模型表；没有活动会话时返回官方别名静态列表，
   * 绝不为列模型创建 query 或发送 prompt（R9）。真实表按配置目录缓存。
   */
  private async listModels(scope: ClaudeScope): Promise<Json> {
    if (scope.realModels) return scope.realModels
    const query = this.activeModelQuery(scope)
    const read = query?.supportedModels
    if (!query || !read) return staticModelList()
    scope.modelListRequest ??= this.fetchModels(scope, read.bind(query)).finally(() => {
      scope.modelListRequest = null
    })
    return scope.modelListRequest
  }

  private activeModelQuery(scope: ClaudeScope): QueryLike | null {
    for (const session of scope.sessions.values()) {
      if (session.query?.supportedModels) return session.query
    }
    return null
  }

  private async fetchModels(scope: ClaudeScope, read: () => Promise<unknown[]>): Promise<Json> {
    try {
      const list = supportedModelList(await read())
      if (!list) return staticModelList()
      this.storeModels(scope, list)
      return list
    } catch (err) {
      this.hub.log(`claude 模型表读取失败，回退别名列表: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
      return staticModelList()
    }
  }

  /**
   * 缓存真实模型表并广播：客户端在会话开启前拿到的是别名静态表，收到后重拉 model/list，
   * 否则界面会一直停在别名列表上。
   */
  private storeModels(scope: ClaudeScope, list: Json): void {
    if (scope.realModels) return
    scope.realModels = list
    if (this.opened && scope === this.currentScope()) this.notify({ method: 'qingcode/models/updated', params: {} })
  }

  /** 会话已开启后顺手取一次真实表；不等待、不阻断 turn，失败时下次 model/list 会重试。 */
  private cacheModels(scope: ClaudeScope, query: QueryLike): void {
    const read = query.supportedModels
    if (scope.realModels || !read) return
    void read
      .call(query)
      .then((infos) => {
        const list = supportedModelList(infos)
        if (this.opened && list && !scope.realModels) this.storeModels(scope, list)
      })
      .catch((err: unknown) => {
        this.hub.log(`claude 模型表读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
      })
  }

  private async listSkills(scope: ClaudeScope, cwds: string[], force: boolean): Promise<Json> {
    if (!scope.directory) return this.skills.list(cwds, force)
    // 自定义配置的技能通过用户已打开的 query 枚举，避免直接读配置目录或后台启动会话。
    const data = await Promise.all(cwds.map(async (cwd) => {
      const query = [...scope.sessions.values()].find((session) =>
        session.meta.cwd === cwd && !session.meta.ephemeral && session.query?.supportedCommands)?.query
      try {
        const commands = await query?.supportedCommands?.() ?? []
        return { cwd, skills: commands.flatMap(commandMetadata), errors: [] }
      } catch (err) {
        this.hub.log(`claude 技能列表读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
        return { cwd, skills: [], errors: [] }
      }
    }))
    return { data }
  }

  /** 只读用户已开启的会话进程，没有则为空，不为列命令启动会话（R9）。 */
  private async listCommands(query: QueryLike | null): Promise<Json> {
    try {
      return { commands: slashCommandList(await query?.supportedCommands?.() ?? []) }
    } catch (err) {
      this.hub.log(`claude 命令列表读取失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
      return { commands: [] }
    }
  }

  /**
   * 把文件回到某一轮开始前。会话进程不在时按原会话恢复，只发控制请求，不推送任何输入。
   * dryRun 为 false 会改写工作区文件，须由客户端在用户确认后传入。
   */
  private async rewindFiles(scope: ClaudeScope, params: Json, cwd?: string): Promise<RewindResponse> {
    const threadId = scalarText(params.threadId)
    const turnId = scalarText(params.turnId)
    const dryRun = params.dryRun
    if (!threadId || !turnId || typeof dryRun !== 'boolean') {
      throw new BridgeRpcError(-32602, 'threadId、turnId 与 dryRun 不能为空')
    }
    const session = await this.sessionFor(scope, threadId, cwd)
    if (session.meta.ephemeral) throw new BridgeRpcError(-32602, '临时会话不支持回滚文件')
    const assertIdle = () => {
      if (session.turnId || session.preparingTurn) throw new BridgeRpcError(-32602, '请先停止当前轮次')
    }
    assertIdle()
    if (session.rewinding) throw new BridgeRpcError(-32602, '正在回滚文件，请稍后重试')
    session.rewinding = true
    try {
      let messageId = session.turnStartIds.get(turnId)
      if (!messageId) {
        const messages = await this.sessionReader(scope).getSessionMessages(threadId, { dir: session.meta.cwd })
        // 过滤条件与历史读取一致，轮次 ID 才能对上。
        const point = sessionMessagesToThread(session.meta,
          messages.filter((message) => !session.pendingSteers.has(scalarText(asRecord(message)?.uuid))), {},
          session.state.taskNotifications.deliveryIds, session.steerHistory)
          .forkPoints.find((candidate) => candidate.turnId === turnId)
        if (!point) throw new BridgeRpcError(-32602, '在 Claude 历史中找不到所选轮次')
        messageId = point.promptMessageId
        if (!messageId) return rewindResponse({ canRewind: false, error: '该轮没有可回滚的用户消息' })
      }
      // 读历史期间 Claude 可能自行开始了一轮。
      assertIdle()
      this.ensureQuery(session, session.settings, session.permissionMode)
      const query = session.query
      if (!query?.rewindFiles) throw new BridgeRpcError(-32603, 'Claude SDK 不支持回滚文件')
      try {
        return rewindResponse(await query.rewindFiles(messageId, { dryRun }))
      } catch (err) {
        this.hub.log(`claude 回滚文件失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
        return rewindResponse({ canRewind: false, error: describe(err) })
      }
    } finally {
      session.rewinding = false
      this.touch(session)
    }
  }

  private async applySettings(session: BridgeSession, next: ClaudeSettings): Promise<void> {
    const query = session.query
    if (!query) return
    const diff = settingsDiff(session.settings, next)
    if (!diff) return
    const changesModel = 'model' in diff
    const changesEffort = 'effort' in diff
    if ((changesModel && !query.setModel) || (changesEffort && !query.applyFlagSettings)) {
      throw new BridgeRpcError(-32603, '当前 Claude SDK 不支持在线切换所选模型或推理强度')
    }
    let setting = '模型' // i18n-ignore: 按实际取值在词典登记整句
    try {
      if (changesModel) {
        await query.setModel?.(next.model ?? undefined)
        // 模型与强度是两个独立调用，记下已成功的部分供下次重试或恢复默认。
        session.settings.model = next.model
      }
      setting = '推理强度' // i18n-ignore: 按实际取值在词典登记整句
      if (changesEffort) {
        await query.applyFlagSettings?.({ effortLevel: next.effort })
        session.settings.effort = next.effort
      }
    } catch (err) {
      this.hub.log(`claude 切换${setting}失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
      throw new BridgeRpcError(-32603, `Claude 切换${setting}失败，消息未发送`) // i18n-ignore: 按实际取值在词典登记整句
    }
  }

  private async setPermissionMode(session: BridgeSession, mode: PermissionMode): Promise<void> {
    const query = session.query
    if (!query || mode === session.permissionMode) return
    if (mode === 'bypassPermissions' && !session.allowsBypass) {
      // SDK 要求启动时显式允许 bypass，保留默认启动行为并按用户选择恢复历史会话。
      if (session.meta.ephemeral) throw new BridgeRpcError(-32602, '临时会话启动后无法启用跳过审批')
      this.closeQuery(session)
      return
    }
    if (!query.setPermissionMode) throw new BridgeRpcError(-32603, 'Claude SDK 不支持在线切换权限模式')
    await query.setPermissionMode(mode)
    session.permissionMode = mode
  }

  private async deleteThread(scope: ClaudeScope, params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
    const session = await this.sessionFor(scope, threadId)
    if (session.meta.ephemeral) throw new BridgeRpcError(-32602, '临时会话不能删除')
    if (session.turnId || session.preparingTurn) throw new BridgeRpcError(-32602, '请先停止当前轮次')
    const reader = this.sessionReader(scope)
    if (!reader.deleteSession) throw new BridgeRpcError(-32601, 'Claude 不支持删除会话')
    // 先关掉仍在运行的 query，避免删除后又把会话写回磁盘。
    if (session.idleTimer) clearTimeout(session.idleTimer)
    this.closeQuery(session)
    await reader.deleteSession(threadId, { dir: session.meta.cwd })
    scope.historyPages.clear(threadId)
    scope.sessions.delete(threadId)
    scope.metas.delete(threadId)
    this.archives.set(threadId, false)
    this.notify({ method: 'thread/deleted', params: { threadId } })
    return {}
  }

  private async renameThread(scope: ClaudeScope, params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    const name = scalarText(params.name).trim()
    if (!threadId || !name) throw new BridgeRpcError(-32602, 'threadId 与会话名称不能为空')
    const session = await this.sessionFor(scope, threadId)
    if (session.meta.ephemeral) throw new BridgeRpcError(-32602, '临时会话不能重命名')
    const reader = this.sessionReader(scope)
    if (!reader.renameSession) throw new BridgeRpcError(-32601, 'Claude 不支持重命名会话')
    await reader.renameSession(threadId, name, { dir: session.meta.cwd })
    session.meta.name = name
    const meta = scope.metas.get(threadId)
    if (meta) meta.name = name
    this.notify({ method: 'thread/name/updated', params: { threadId, threadName: name } })
    return {}
  }

  private async forkThread(scope: ClaudeScope, params: Json): Promise<Json> {
    const threadId = scalarText(params.threadId)
    if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
    const source = await this.sessionFor(scope, threadId)
    const lastTurnId = scalarText(params.lastTurnId)
    if (source.meta.ephemeral || (source.turnId && (!lastTurnId || source.turnId === lastTurnId))) {
      throw new BridgeRpcError(-32602, '请选择已结束的会话轮次')
    }
    const reader = this.sessionReader(scope)
    if (!reader.forkSession) throw new BridgeRpcError(-32601, 'Claude 不支持创建会话分支')
    const dir = source.meta.cwd
    let boundary: string | undefined
    if (lastTurnId) {
      const history = sessionMessagesToThread(source.meta, await reader.getSessionMessages(threadId, { dir }),
        {}, source.state.taskNotifications.deliveryIds, source.steerHistory)
      const messageId = source.turnMessageIds.get(lastTurnId)
      boundary = history.forkPoints.find((point) =>
        point.turnId === lastTurnId || (messageId && point.firstMessageId === messageId))?.lastMessageId
      if (!boundary) throw new BridgeRpcError(-32602, '在 Claude 历史中找不到所选轮次')
    }
    const { sessionId } = await reader.forkSession(threadId, { dir, upToMessageId: boundary })
    const meta: SessionMeta = { id: sessionId, cwd: dir, preview: source.meta.preview }
    const settings = source.settings
    const branch = makeSession(scope, meta, true, settings)
    branch.steerHistory = new Map(source.steerHistory)
    if (branch.steerHistory.size > 0) this.steerHistory.write(sessionId, branch.steerHistory, scope.directory)
    scope.sessions.set(sessionId, branch)
    scope.metas.set(sessionId, meta)
    const messages = params.excludeTurns === true ? [] : await reader.getSessionMessages(sessionId, { dir })
    const thread = sessionMessagesToThread(meta, messages, threadModelConfig(settings), undefined, branch.steerHistory).thread
    this.notify({ method: 'thread/started', params: { thread } })
    return threadStartResult(meta, settings, thread)
  }

  private async startTurn(
    session: BridgeSession,
    content: TurnContent,
    next: ClaudeSettings,
    permissionMode: PermissionMode,
    clientId: string | null,
    compact = false,
  ): Promise<Json> {
    if (session.preparingTurn) throw new BridgeRpcError(-32602, '正在准备一轮对话，请稍后重试')
    if (session.rewinding) throw new BridgeRpcError(-32602, '正在回滚文件，请稍后重试')
    const messageId = clientId ?? randomUUID()
    const userItem = userMessageContentItem(messageId, content.echo, clientId)
    // v2 规定追加输入到进行中的 turn 时忽略覆盖项，输入直接推入同一 query 的队列。
    const appendTo = (activeTurnId: string): Json => {
      if (compact || session.compaction) throw new BridgeRpcError(-32602, '请先等待当前一轮结束')
      this.pushInput(session, content.blocks, messageId)
      session.queuedAppends.add(messageId)
      if (session.agentTurnId === activeTurnId) session.agentTurnId = null
      session.state.items[messageId] = userItem
      session.state.order.push(messageId)
      this.notify(itemCompleted({ threadId: session.meta.id, turnId: activeTurnId, cwd: session.meta.cwd }, userItem))
      return { turn: buildTurn(activeTurnId, [], 'inProgress') }
    }
    if (session.turnId) return appendTo(session.turnId)
    const turnId = randomUUID()
    const items = compact ? [] : [userItem]
    const turn = buildTurn(turnId, items, 'inProgress')
    if (!this.claude) throw new AgentHostError('agent_unavailable', 'claude 尚未就绪')
    session.preparingTurn = true
    let started = false
    try {
      await this.setPermissionMode(session, permissionMode)
      if (session.query && session.input) await this.applySettings(session, next)
      // 上面等待期间 Claude 可能已自行开始一轮，覆盖它会让那一轮永远不结束。
      const agentTurnId = session.turnId as string | null
      if (agentTurnId) return appendTo(agentTurnId)
      session.turnId = turnId
      if (!compact) {
        session.turnMessageIds.set(turnId, messageId)
        session.turnStartIds.set(turnId, messageId)
      }
      session.compaction = compact
      session.state = nextTurnState(session.state)
      for (const item of items) {
        session.state.items[scalarText(item.id)] = item
        session.state.order.push(scalarText(item.id))
      }
      this.ensureQuery(session, next, permissionMode)
      if (compact) {
        const query = session.query
        const commands = await query?.supportedCommands?.()
        if (session.query !== query || !commands?.some((command) => asRecord(command)?.name === 'compact')) {
          throw new BridgeRpcError(-32601, '当前 Claude 会话未提供 /compact')
        }
      }
      // 通知里带上本轮真正生效的配置；客户端会忽略 v2 形状之外的字段。
      this.notify({
        method: 'turn/started',
        params: { threadId: session.meta.id, turn, ...threadModelConfig(session.settings) },
      })
      started = true
      this.pushInput(session, content.blocks, messageId)
    } catch (err) {
      // 准备阶段失败时，session.turnId 可能属于 Claude 自行开始的轮次，只清自己的。
      if (session.turnId === turnId) session.turnId = null
      // 没有发出开始通知时，完成通知会影响其他并行轮次的计数。
      if (started) {
        this.notify({
          method: 'turn/completed',
          params: {
            threadId: session.meta.id,
            turn: buildTurn(turnId, items, 'failed', describe(err)),
          },
        })
      }
      throw err
    } finally {
      session.preparingTurn = false
      this.touch(session)
    }
    return { turn }
  }

  private pushInput(session: BridgeSession, content: ContentBlock[], uuid: string, steer = false): void {
    if (!session.input) throw new BridgeRpcError(-32603, 'claude 输入队列不可用')
    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.meta.id,
      uuid,
      ...(steer ? { priority: 'next', origin: { kind: 'human' } } : {}),
    } as unknown as SDKUserMessage
    session.input.push(message)
  }

  private ensureQuery(session: BridgeSession, settings: ClaudeSettings, permissionMode: PermissionMode): void {
    if (session.query && session.input) return
    const deps = this.requireDeps()
    const input = new AsyncQueue<SDKUserMessage>()
    const options: Options = {
      ...queryOverrides(settings),
      cwd: session.meta.cwd,
      includePartialMessages: true,
      // SDK 省略 systemPrompt 时发送空系统提示，须显式选预设才能与用户终端里的 claude 行为一致。
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // 修改前备份文件，供 qingcode/files/rewind 使用；临时会话不落盘，也不建检查点。
      ...(session.meta.ephemeral ? {} : { enableFileCheckpointing: true }),
      // SDK 约定：声明后停止只中断当前轮，保留后台任务，客户端须能逐个停止（qingcode/backgroundTasks/stop）。
      // 临时会话（侧聊）没有任务列表界面，不声明，停止时一并结束后台任务。
      ...(session.meta.ephemeral ? {} : { perTaskStopAffordance: true }),
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      persistSession: !session.meta.ephemeral,
      canUseTool: (toolName, toolInput, extra) =>
        this.onCanUseTool(session, toolName, toolInput, {
          suggestions: extra.suggestions,
          toolUseID: extra.toolUseID,
          signal: extra.signal,
          decisionReason: extra.decisionReason,
        }),
      onElicitation: (request, extra) => this.onElicitation(session, request, extra.signal),
      pathToClaudeCodeExecutable: this.claude?.path ?? '',
      env: {
        ...agentConfigEnv(envStrings(), 'CLAUDE_CONFIG_DIR', session.scope.directory),
        // 官方环境变量（code.claude.com/docs/en/env-vars）：推送 session_state_changed，用于收尾自发轮次。
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      },
      stderr: (data: string) => this.hub.log(`claude stderr: ${redact(data)}`),
      // 首次用 sessionId 固定 UUID；空闲关闭后用 resume 重新拉起，保留会话历史。
      ...(session.queryCreated
        ? { resume: session.meta.id }
        : { sessionId: session.meta.id }),
    }
    const query = deps.query({ prompt: input, options })
    session.query = query
    session.input = input
    session.queryCreated = true
    session.settings = { ...settings }
    session.permissionMode = permissionMode
    session.allowsBypass = permissionMode === 'bypassPermissions'
    this.cacheModels(session.scope, query)
    void this.consume(session, query)
  }

  private async consume(session: BridgeSession, query: QueryLike): Promise<void> {
    try {
      for await (const message of query) {
        if (session.query !== query) break
        this.onSdkMessage(session, message)
      }
    } catch (err) {
      if (session.query === query) {
        this.hub.log(`claude query 异常: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
        this.finishTurn(session, 'failed', describe(err))
      }
    } finally {
      if (session.query === query) {
        session.input?.close()
        session.query = null
        session.input = null
        this.resetProcessState(session)
        // CLI 提前退出且没有 result 消息时兜底结束 turn，避免 activeTurns 永远不归零。
        if (session.turnId) this.finishTurn(session, 'failed', 'claude 进程提前结束')
        if (session.meta.ephemeral) this.forgetTemporary(session)
      }
    }
  }

  private onSdkMessage(session: BridgeSession, message: unknown): void {
    const record = asRecord(message)
    // 新 SDK 是顶层 rate_limit_event；旧 CLI 也可能把它塞进 system 消息。
    if (record?.type === 'rate_limit_event' || record?.subtype === 'rate_limit_event') {
      this.onRateLimitEvent(session.scope, record.rate_limit_info)
    }
    if (record?.type === 'system' && record.subtype === 'session_state_changed') {
      if (record.state === 'idle') this.finishIdleAgentTurn(session)
      return
    }
    // Claude 自己切换访问模式（如确认计划后退出 plan）时同步，下一轮按用户所选模式重新设置。
    if (record?.type === 'system' && record.subtype === 'status' && typeof record.permissionMode === 'string') {
      session.permissionMode = record.permissionMode as PermissionMode
    }
    if (record && !record.parent_tool_use_id &&
      (record.type === 'assistant' || record.type === 'stream_event' || record.type === 'result')) {
      session.queuedTurnId = null
      if (session.pendingSteers.size > 0 || session.stoppedSteers.size > 0 || session.queuedAppends.size > 0) {
        this.confirmSteers(session, record)
      }
    }
    const backgroundTasks = record ? backgroundTaskList(record) : null
    if (backgroundTasks !== null) {
      this.setBackgroundTasks(session, backgroundTasks)
      this.touch(session)
    }
    if (record?.type === 'result' && !session.turnId) return
    // 后台任务结束后 Claude 会不经用户输入自行续跑，建一个轮次承接输出。
    if (record && !session.turnId && isMainAgentOutput(record)) {
      const turnId = this.startAgentTurn(session)
      if (consumedIds(record).length === 0) session.agentTurnId = turnId
    }
    const ctx = {
      threadId: session.meta.id,
      turnId: session.turnId ?? '',
      cwd: session.meta.cwd,
    }
    const missingCompaction = session.compaction && record?.type === 'result' && record.subtype === 'success'
      && record.is_error !== true && !session.state.order.some((id) =>
        session.state.items[id]?.type === 'contextCompaction' && session.state.items[id]?.status === 'completed')
    const mapped = mapSdkMessage(missingCompaction ? {
      ...record, is_error: true, errors: [scalarText(record.result) || 'Claude 未返回压缩结果'],
    } : message, ctx, session.state)
    session.state = mapped.state
    for (const note of mapped.notifications) {
      if (note.method !== 'account/rateLimits/updated') this.notify(note)
    }
    if (session.state.contextWindow == null && session.state.contextUsage && record?.type !== 'result') {
      this.probeContextWindow(session)
    }
    if (record?.type === 'result') {
      const learned = resultModelWindow(record)
      if (learned) this.contextWindows.record(session.meta.id, learned.model, learned.window)
      const userMessageIds = record.user_message_uuids
      if (session.turnId && Array.isArray(userMessageIds)) {
        const answered = userMessageIds.at(-1)
        if (typeof answered === 'string' && session.turnMessageIds.has(session.turnId) &&
          (session.steerHistory.get(answered)?.startsTurn ?? true)) {
          session.turnMessageIds.set(session.turnId, answered)
        }
      }
      session.turnId = null
      session.scope.historyPages.clear(session.meta.id)
      // Claude 已排好的下一轮优先于客户端自己的发送队列。
      if (session.pendingSteers.size > 0 && (finite(record.queued_turn_count) ?? 0) > 0) {
        session.queuedTurnId = this.startAgentTurn(session)
      }
      this.touch(session)
    }
  }

  /**
   * 窗口大小原本只在每轮结束的 result.modelUsage 里给出，首轮进行中占用环只能空着。
   * 首次拿到用量时用 SDK 的 getContextUsage（summary 模式不额外调用计数接口）补上窗口并重发一次。
   */
  private probeContextWindow(session: BridgeSession): void {
    const query = session.query
    if (session.contextWindowProbed || !query?.getContextUsage) return
    session.contextWindowProbed = true
    void query.getContextUsage({ detail: 'summary' }).then((raw) => {
      const usage = asRecord(raw)
      const window = finite(usage?.rawMaxTokens) ?? finite(usage?.maxTokens)
      if (!window || window <= 0 || session.query !== query || session.state.contextWindow != null) return
      session.state.contextWindow = window
      this.contextWindows.record(session.meta.id, null, window)
      const last = session.state.contextUsage
      if (!session.turnId || !last) return
      this.notify({ method: 'thread/tokenUsage/updated', params: {
        threadId: session.meta.id,
        turnId: session.turnId,
        tokenUsage: { total: last, last, modelContextWindow: window, estimated: true },
      } })
    }, () => undefined)
  }

  /** 开启一个不由 turn/start 发起的轮次：排队的引导，或 Claude 自行续跑。 */
  private startAgentTurn(session: BridgeSession): string {
    const turnId = randomUUID()
    session.turnId = turnId
    session.compaction = false
    session.state = nextTurnState(session.state)
    this.notify({ method: 'turn/started', params: {
      threadId: session.meta.id,
      turn: buildTurn(turnId, [], 'inProgress'),
      ...threadModelConfig(session.settings),
    } })
    return turnId
  }

  private confirmSteers(session: BridgeSession, record: Json): void {
    // SDK 用 UUID 确认实际处理了哪些输入，顺序沿用提交顺序。
    const ids = new Set(consumedIds(record))
    for (const id of ids) session.queuedAppends.delete(id)
    const pendingCount = session.pendingSteers.size
    for (const [id, pending] of session.pendingSteers) {
      if (!ids.has(id)) continue
      const turnId = session.turnId ?? this.startAgentTurn(session)
      const placement = turnId === pending.turnId ? 'currentTurn' : 'nextTurn'
      // 引导进自行续跑的轮次时，该轮没有开场消息，引导也不算开启轮次。
      const startsTurn = placement === 'nextTurn' && !session.turnMessageIds.has(turnId)
      if (startsTurn) {
        session.turnMessageIds.set(turnId, id)
        session.turnStartIds.set(turnId, id)
      }
      if (session.agentTurnId === turnId) session.agentTurnId = null
      session.steerHistory.set(id, { placement, startsTurn })
      const item = { ...pending.item, steering: placement }
      session.pendingSteers.delete(id)
      session.state.items[id] = item
      session.state.order.push(id)
      this.notify(itemCompleted({ threadId: session.meta.id, turnId, cwd: session.meta.cwd }, item))
    }
    if (!session.meta.ephemeral && session.pendingSteers.size < pendingCount) {
      this.steerHistory.write(session.meta.id, session.steerHistory, session.scope.directory)
    }
    this.interruptStoppedSteers(session, record, [...ids])
  }

  /** 先撤回还没开始处理的消息再中断；撤不回的记下来，CLI 开始处理时二次中断。 */
  private async interrupt(session: BridgeSession, query: QueryLike): Promise<void> {
    // 先记录再撤回：排队的下一轮消息可能早于撤回和 interrupt 返回到达。
    const stopped = [...session.pendingSteers.keys(), ...session.queuedAppends]
    for (const id of stopped) session.stoppedSteers.set(id, session.turnId)
    session.interruptedTurnId = session.turnId
    if (stopped.length > 0) {
      const withdrawn = await withdrawMessages(query, stopped, (err) => {
        this.hub.log(`claude 撤回排队消息失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
      })
      for (const id of withdrawn) {
        session.stoppedSteers.delete(id)
        session.pendingSteers.delete(id)
        session.queuedAppends.delete(id)
      }
    }
    try {
      await query.interrupt()
    } catch (err) {
      for (const id of stopped) session.stoppedSteers.delete(id)
      throw err
    }
    // 这一轮只为等排队引导而开，引导全部撤回后不会再有 result。
    if (session.turnId && session.turnId === session.queuedTurnId && session.pendingSteers.size === 0) {
      this.finishTurn(session, 'interrupted')
    }
  }

  /** 会话整体空闲说明自发轮次已经结束。用户发起的轮次不处理：上一轮的空闲状态可能晚于新消息到达。 */
  private finishIdleAgentTurn(session: BridgeSession): void {
    if (!session.turnId || session.turnId !== session.agentTurnId) return
    this.finishTurn(session, session.interruptedTurnId === session.turnId ? 'interrupted' : 'completed')
  }

  /**
   * interrupt 不撤回排队消息，撤回也可能失败，CLI 开始处理它们时再中断一次。
   * 同一批里混有停止后的新消息时放行，避免误停用户的新输入。
   */
  private interruptStoppedSteers(session: BridgeSession, record: Json, ids: unknown[]): void {
    const consumed = ids.filter((id): id is string => typeof id === 'string')
    const late = record.type !== 'result' && consumed.length > 0 && consumed.every((id) =>
      session.stoppedSteers.has(id) && session.stoppedSteers.get(id) !== session.turnId)
    for (const id of consumed) session.stoppedSteers.delete(id)
    if (!late) return
    void session.query?.interrupt().catch((err: unknown) => {
      this.hub.log(`claude 中断排队引导失败: ${redact(describe(err))}`) // i18n-ignore: 仅进日志
    })
  }

  /** 没有 result 消息时兜底结束当前 turn：CLI 崩溃、空闲收尾、撤回后无事可做。 */
  private finishTurn(session: BridgeSession, status: string, error?: string): void {
    const turnId = session.turnId
    if (!turnId) return
    session.turnId = null
    session.scope.historyPages.clear(session.meta.id)
    const ctx = { threadId: session.meta.id, turnId, cwd: session.meta.cwd }
    for (const note of finishPendingItems(ctx, session.state, status === 'failed')) this.notify(note)
    const items = session.state.order.map((id) => session.state.items[id]).filter(isRecord)
    this.notify({
      method: 'turn/completed',
      params: {
        threadId: session.meta.id,
        turn: buildTurn(turnId, items, status, error),
      },
    })
    this.touch(session)
  }

  private threadStatus(scope: ClaudeScope, threadId: string): ThreadStatus {
    const session = scope.sessions.get(threadId)
    if (!session?.turnId) return { type: 'idle' }
    const pending = [...this.approvals.values()].filter((item) => item.session === session)
    const flags: ('waitingOnApproval' | 'waitingOnUserInput')[] = []
    if (pending.some((item) => !item.toResult)) flags.push('waitingOnApproval')
    if (pending.some((item) => item.toResult) || [...this.elicitations.values()].some((item) => item.session === session)) {
      flags.push('waitingOnUserInput')
    }
    return { type: 'active', activeFlags: flags }
  }

  private onCanUseTool(
    session: BridgeSession,
    toolName: string,
    input: Record<string, unknown>,
    extra: {
      suggestions?: unknown
      toolUseID?: string
      signal?: AbortSignal
      decisionReason?: string
    },
  ): Promise<PermissionResult> {
    const requestId = `qn-claude-approval-${++this.requestCounter}`
    const toolItem = extra.toolUseID ? session.state.toolItems[extra.toolUseID] : undefined
    const itemId = scalarText(toolItem?.id)
      || (extra.toolUseID ? sidechainItemId(session.state.sidechains, extra.toolUseID) : '')
      || `${session.turnId ?? 'turn'}-tool`
    // AskUserQuestion 是向用户要答案，不是权限审批：完全访问模式下也必须问，并按问答回填。
    const asking = toolName === ASK_USER_TOOL
    const request = asking
      ? buildUserInputRequest({ requestId, threadId: session.meta.id, turnId: session.turnId ?? '', itemId, input })
      : buildApprovalRequest({
          requestId,
          threadId: session.meta.id,
          turnId: session.turnId ?? '',
          itemId,
          toolName,
          input,
          ...(extra.decisionReason ? { reason: extra.decisionReason } : {}),
        })
    return new Promise<PermissionResult>((resolve) => {
      this.approvals.set(requestId, {
        session,
        resolve,
        suggestions: extra.suggestions,
        ...(asking ? { toResult: (response: unknown) => askUserResult(response, input) } : {}),
      })
      if (extra.signal) {
        extra.signal.addEventListener(
          'abort',
          () => this.settleApproval(requestId, { behavior: 'deny', message: '请求已取消' }), // i18n-ignore: 回给模型的拒绝原因
          { once: true },
        )
      }
      this.emit({ id: requestId, method: request.method, params: request.params })
    })
  }

  private onElicitation(session: BridgeSession, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    const requestId = `qn-claude-elicitation-${++this.requestCounter}`
    return new Promise<ElicitationResult>((resolve) => {
      this.elicitations.set(requestId, { session, resolve })
      signal.addEventListener('abort', () => {
        if (!this.elicitations.delete(requestId)) return
        resolve({ action: 'cancel' })
        this.notify({ method: 'serverRequest/resolved', params: { threadId: session.meta.id, requestId } })
      }, { once: true })
      this.emit(buildElicitationRequest(requestId, session.meta.id, session.turnId, request))
    })
  }

  private resolveApproval(msg: Json): void {
    const id = msg.id as JsonRpcId
    const elicitation = this.elicitations.get(id)
    if (elicitation) {
      this.elicitations.delete(id)
      elicitation.resolve(elicitationResult(msg))
      this.notify({ method: 'serverRequest/resolved', params: { requestId: id } })
      return
    }
    const pending = this.approvals.get(id)
    if (!pending) return
    this.approvals.delete(id)
    pending.resolve(pending.toResult ? pending.toResult(msg) : permissionResult(msg, pending.suggestions))
    this.notify({
      method: 'serverRequest/resolved',
      params: { requestId: id },
    })
  }

  private settleApproval(id: JsonRpcId, result: PermissionResult): void {
    const pending = this.approvals.get(id)
    if (!pending) return
    this.approvals.delete(id)
    pending.resolve(result)
  }

  private async sessionFor(
    scope: ClaudeScope,
    threadId: string,
    cwdHint?: string,
  ): Promise<BridgeSession> {
    const existing = scope.sessions.get(threadId)
    if (existing) return existing
    let meta = scope.metas.get(threadId)
    if (!meta) {
      const reader = this.sessionReader(scope)
      const info = reader.getSessionInfo
        ? await reader.getSessionInfo(threadId)
        : (await reader.listSessions()).find((info) => asRecord(info)?.sessionId === threadId)
      const concurrent = scope.sessions.get(threadId)
      if (concurrent) return concurrent
      if (!info) throw new BridgeRpcError(-32602, '未找到 Claude 会话')
      meta = sessionInfoToMeta(info, cwdHint ?? process.cwd())
      scope.metas.set(threadId, meta)
    }
    const session = makeSession(scope, meta, true)
    session.steerHistory = this.steerHistory.read(threadId, scope.directory)
    scope.sessions.set(threadId, session)
    return session
  }

  private forgetTemporary({ scope, meta: { id: threadId } }: BridgeSession): void {
    scope.historyPages.clear(threadId)
    scope.sessions.delete(threadId)
    scope.metas.delete(threadId)
    this.notify({ method: 'thread/closed', params: { threadId } })
  }

  private touch(session: BridgeSession): void {
    if (!this.opened) return
    if (session.meta.ephemeral) {
      // 侧聊不落盘，当前目录下不做空闲关闭。切换后等旧侧聊结束再释放。
      if (!session.turnId && !session.preparingTurn && !session.backgroundTasks.length
        && session.scope !== this.currentScope()) {
        this.closeQuery(session)
        this.forgetTemporary(session)
      }
      return
    }
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      // 关闭 query 会结束 CLI 进程及其后台任务；任务数变化时会重新计时。
      if (session.turnId || session.preparingTurn || session.rewinding || session.backgroundTasks.length) return
      this.closeQuery(session)
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private requireDeps(): ClaudeDeps {
    if (!this.deps) throw new AgentHostError('agent_unavailable', 'Claude SDK 尚未加载')
    return this.deps
  }

  private setBackgroundTasks(session: BridgeSession, tasks: BackgroundTask[]): void {
    session.backgroundTasks = tasks
    this.notify({ method: 'qingcode/backgroundTasks/updated', params: { threadId: session.meta.id, tasks } })
  }

  private closeQuery(session: BridgeSession): void {
    const query = session.query
    session.query = null
    session.input?.close()
    session.input = null
    this.resetProcessState(session)
    try {
      query?.close()
    } catch {
      // 查询可能已结束。
    }
  }

  /** 随 CLI 进程一起失效的状态。 */
  private resetProcessState(session: BridgeSession): void {
    session.pendingSteers.clear()
    session.queuedAppends.clear()
    session.stoppedSteers.clear()
    if (session.backgroundTasks.length === 0) return
    // 进程内的后台任务随之结束；桥退出时无需再通知客户端。
    if (this.opened) this.setBackgroundTasks(session, [])
    else session.backgroundTasks = []
  }

  private notify(note: V2Notification): void {
    this.emit({ method: note.method, params: note.params })
  }
}

function makeSession(
  scope: ClaudeScope,
  meta: SessionMeta,
  queryCreated: boolean,
  settings: ClaudeSettings = NO_OVERRIDES,
): BridgeSession {
  return {
    scope,
    meta,
    query: null,
    input: null,
    turnId: null,
    turnMessageIds: new Map(),
    turnStartIds: new Map(),
    pendingSteers: new Map(),
    queuedAppends: new Set(),
    stoppedSteers: new Map(),
    agentTurnId: null,
    queuedTurnId: null,
    interruptedTurnId: null,
    backgroundTasks: [],
    rewinding: false,
    steerHistory: new Map(),
    compaction: false,
    preparingTurn: false,
    state: emptyMapState(),
    queryCreated,
    idleTimer: null,
    settings: { ...settings },
    permissionMode: 'default',
    allowsBypass: false,
  }
}

/** 主代理开始回复；子代理消息带 parent_tool_use_id，不会以 result 结束。 */
function isMainAgentOutput(message: Json): boolean {
  if (message.parent_tool_use_id) return false
  return message.type === 'assistant'
    || (message.type === 'stream_event' && asRecord(message.event)?.type === 'message_start')
}

/** SDK 在回复上标注它处理的用户消息 UUID。 */
function consumedIds(record: Json): string[] {
  const ids: unknown[] = Array.isArray(record.user_message_uuids) ? record.user_message_uuids : [record.user_message_uuid]
  return ids.filter((id): id is string => typeof id === 'string')
}

function clientMessageId(value: unknown): string | null {
  const id = scalarText(value)
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id : null
}

function parsePermissionMode(value: unknown): PermissionMode {
  if (value === undefined || value === 'default') return 'default'
  if (value === 'auto' || value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions') return value
  throw new BridgeRpcError(-32602, '不支持的 Claude 访问模式')
}

function threadStartResult(meta: SessionMeta, settings: ClaudeSettings, thread: Json): Json {
  const config = threadModelConfig(settings)
  return {
    thread,
    model: config.model ?? DEFAULT_MODEL,
    modelProvider: 'anthropic',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: meta.cwd,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: config.reasoningEffort,
  }
}

function envStrings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
