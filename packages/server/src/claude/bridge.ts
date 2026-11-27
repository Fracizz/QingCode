/**
 * Claude Agent SDK → codex app-server v2 的桥：会话表、异步输入队列、turn 生命周期、
 * 审批、中断、空闲关闭与错误恢复。只发 v2 JSON-RPC，与客户端的渲染链路完全复用。
 */
import { randomUUID } from 'node:crypto'
import type { Options, PermissionMode, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
import { SteerHistoryStore } from '../steerHistory'
import { VERSION } from '../version'
import { nativeAgentCwd } from '../workspace/paths'
import { buildApprovalRequest, permissionResult } from './approval'
import { parseClaudeSteer, sessionInfoToMeta, sessionMessagesToThread, threadListResponse, type ClaudeSteerHistory } from './history'
import { HistoryPageCache, listHistoryItems, listHistoryTurns } from './historyPages'
import { BridgeRpcError } from './errors'
import { emptyMapState, mapSdkMessage, type MapState } from './items'
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
import { resolveClaudeExecutable, type ClaudeExecutable } from './resolve'
import {
  asRecord,
  buildThread,
  buildTurn,
  emptyRateLimitsResponse,
  finite,
  isRecord,
  itemCompleted,
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
  pendingSteers: Map<string, { item: V2Item; turnId: string }>
  steerHistory: Map<string, ClaudeSteerHistory>
  compaction: boolean
  preparingTurn: boolean
  state: MapState
  queryCreated: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 当前 query 已生效的模型/推理强度；null 表示沿用 Claude 自身配置。 */
  settings: ClaudeSettings
  permissionMode: PermissionMode
  allowsBypass: boolean
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
  private readonly idleTimeoutMs: number
  private readonly steerHistory: SteerHistoryStore<ClaudeSteerHistory>
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
    const resolved = this.options.resolve
      ? this.options.resolve(explicit)
      : resolveClaudeExecutable(explicit)
    try {
      this.deps = this.options.deps ?? (await loadSdk())
    } catch (err) {
      throw new AgentHostError('agent_unavailable', `Claude SDK 加载失败: ${describe(err)}`)
    }
    this.claude = resolved
    this.initializeResult = { userAgent: `claude-bridge/${resolved.version}` }
    this.opened = true
    this.hub.log(`claude 桥已就绪 ${resolved.version}`)
    return { initialize: this.initializeResult, agentVersion: resolved.version }
  }

  protected agentStatus(): { running: boolean; pid?: number } {
    return { running: this.opened }
  }

  protected sendToAgent(msg: Json): void {
    void this.dispatch(msg).catch((err: unknown) => {
      this.hub.log(`claude 消息处理失败: ${redact(describe(err))}`)
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
        closeQuery(session)
      }
    }
    for (const pending of this.approvals.values()) {
      pending.resolve({ behavior: 'deny', message: 'server 正在退出' })
    }
    this.approvals.clear()
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
    const { primary, secondary, observedAt } = scope.statusLine.snapshot()
    if (primary || secondary) {
      return {
        ...rateLimitSnapshot(),
        limitId: 'claude-statusline',
        limitName: 'Claude CLI 状态栏',
        primary,
        secondary,
        observedAt,
      }
    }
    return active && scope.sdkRateLimits.primary
      ? { ...scope.sdkRateLimits, observedAt: scope.sdkObservedAt }
      : rateLimitSnapshot()
  }

  private notifyRateLimits(scope: ClaudeScope): void {
    if (!this.opened || scope !== this.currentScope()) return
    this.notify({ method: 'account/rateLimits/updated', params: { rateLimits: this.quotaSnapshot(scope) } })
  }

  private onRateLimitEvent(scope: ClaudeScope, info: unknown): void {
    clearTimeout(scope.sdkResetTimer)
    const reset = finite(asRecord(info)?.resetsAt)
    scope.sdkRateLimits = rateLimitSnapshot(info)
    scope.sdkObservedAt = Date.now()
    scope.sdkResetsAt = reset === null ? null : Math.abs(reset) > 1e11 ? reset / 1000 : reset
    if (scope.sdkResetsAt !== null && (scope.sdkRateLimits.rateLimitReachedType || scope.sdkRateLimits.primary)) {
      const delay = scope.sdkResetsAt * 1000 - Date.now()
      if (delay > 0 && delay <= 2_147_483_647) {
        scope.sdkResetTimer = setTimeout(() => this.notifyRateLimits(scope), Math.ceil(delay))
        scope.sdkResetTimer.unref()
      }
    }
    this.notifyRateLimits(scope)
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
      this.hub.log(`claude ${method} 失败: ${redact(message)}`)
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
        closeQuery(session)
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
        for (const dir of dirs) {
          const infos = await reader.listSessions({ dir, limit, ...(Array.isArray(params.cwd) ? { includeWorktrees: false } : {}) })
          for (const info of infos) {
            const meta = sessionInfoToMeta(info, dir ?? process.cwd())
            if (!meta.id || metas.has(meta.id)) continue
            metas.set(meta.id, meta)
            scope.metas.set(meta.id, meta)
          }
        }
        return threadListResponse([...metas.values()], limit, (id) => this.threadStatus(scope, id))
      }
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
        const config = threadModelConfig(session.settings)
        if (metadataOnly) {
          return { thread: { ...buildThread(session.meta, [], config), status: this.threadStatus(scope, threadId), historyMode: 'paginated' } }
        }
        const load = async () => {
          const messages = await this.sessionReader(scope).getSessionMessages(threadId, { dir: session.meta.cwd })
          return sessionMessagesToThread(session.meta,
            messages.filter((message) => !session.pendingSteers.has(scalarText(asRecord(message)?.uuid))),
            config, session.state.taskNotifications.deliveryIds, session.steerHistory).turns
        }
        const saved = await (paged
          ? scope.historyPages.read(threadId, params.cursor != null || method === 'thread/items/list', load)
          : load())
        // 正在运行的条目由事件流补齐，避免和 SDK 已经写入历史的内容重复。
        const active = session.turnId
        const turns = active ? [...saved, buildTurn(active, [], 'inProgress')] : saved
        if (method === 'thread/turns/list') return listHistoryTurns(threadId, turns, params)
        if (method === 'thread/items/list') return listHistoryItems(threadId, turns, params)
        return { thread: { ...buildThread(session.meta, turns, config), status: this.threadStatus(scope, threadId) } }
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
        await session.query.interrupt()
        this.hub.log(`claude turn 已请求中断 (thread=${threadId})`)
        return {}
      }
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
      scope.realModels = list
      return list
    } catch (err) {
      this.hub.log(`claude 模型表读取失败，回退别名列表: ${redact(describe(err))}`)
      return staticModelList()
    }
  }

  /** 会话已开启后顺手取一次真实表；不等待、不阻断 turn，失败时下次 model/list 会重试。 */
  private cacheModels(scope: ClaudeScope, query: QueryLike): void {
    const read = query.supportedModels
    if (scope.realModels || !read) return
    void read
      .call(query)
      .then((infos) => {
        const list = supportedModelList(infos)
        if (this.opened && list && !scope.realModels) scope.realModels = list
      })
      .catch((err: unknown) => {
        this.hub.log(`claude 模型表读取失败: ${redact(describe(err))}`)
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
        this.hub.log(`claude 技能列表读取失败: ${redact(describe(err))}`)
        return { cwd, skills: [], errors: [] }
      }
    }))
    return { data }
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
    let setting = '模型'
    try {
      if (changesModel) {
        await query.setModel?.(next.model ?? undefined)
        // 模型与强度是两个独立调用，记下已成功的部分供下次重试或恢复默认。
        session.settings.model = next.model
      }
      setting = '推理强度'
      if (changesEffort) {
        await query.applyFlagSettings?.({ effortLevel: next.effort })
        session.settings.effort = next.effort
      }
    } catch (err) {
      this.hub.log(`claude 切换${setting}失败: ${redact(describe(err))}`)
      throw new BridgeRpcError(-32603, `Claude 切换${setting}失败，消息未发送`)
    }
  }

  private async setPermissionMode(session: BridgeSession, mode: PermissionMode): Promise<void> {
    const query = session.query
    if (!query || mode === session.permissionMode) return
    if (mode === 'bypassPermissions' && !session.allowsBypass) {
      // SDK 要求启动时显式允许 bypass，保留默认启动行为并按用户选择恢复历史会话。
      if (session.meta.ephemeral) throw new BridgeRpcError(-32602, '临时会话启动后无法启用跳过审批')
      closeQuery(session)
      return
    }
    if (!query.setPermissionMode) throw new BridgeRpcError(-32603, 'Claude SDK 不支持在线切换权限模式')
    await query.setPermissionMode(mode)
    session.permissionMode = mode
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
    const messageId = clientId ?? randomUUID()
    const userItem = userMessageContentItem(messageId, content.echo, clientId)
    if (session.turnId) {
      if (compact || session.compaction) throw new BridgeRpcError(-32602, '请先等待当前一轮结束')
      // v2 规定追加输入到进行中的 turn 时忽略覆盖项，输入直接推入同一 query 的队列。
      this.pushInput(session, content.blocks, messageId)
      session.state.items[messageId] = userItem
      session.state.order.push(messageId)
      this.notify(itemCompleted({ threadId: session.meta.id, turnId: session.turnId, cwd: session.meta.cwd }, userItem))
      return { turn: buildTurn(session.turnId, [], 'inProgress') }
    }
    const turnId = randomUUID()
    const items = compact ? [] : [userItem]
    const turn = buildTurn(turnId, items, 'inProgress')
    if (!this.claude) throw new AgentHostError('agent_unavailable', 'claude 尚未就绪')
    session.preparingTurn = true
    let started = false
    try {
      await this.setPermissionMode(session, permissionMode)
      if (session.query && session.input) await this.applySettings(session, next)
      session.turnId = turnId
      if (!compact) session.turnMessageIds.set(turnId, messageId)
      session.compaction = compact
      session.state = emptyMapState(session.state.taskNotifications)
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
      session.turnId = null
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
      pathToClaudeCodeExecutable: this.claude?.path ?? '',
      env: agentConfigEnv(envStrings(), 'CLAUDE_CONFIG_DIR', session.scope.directory),
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
        this.hub.log(`claude query 异常: ${redact(describe(err))}`)
        this.finishTurn(session, 'failed', describe(err))
      }
    } finally {
      if (session.query === query) {
        session.input?.close()
        session.query = null
        session.input = null
        session.pendingSteers.clear()
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
    if (session.pendingSteers.size > 0 && record && !record.parent_tool_use_id &&
      (record.type === 'assistant' || record.type === 'stream_event' || record.type === 'result')) {
      this.confirmSteers(session, record)
    }
    if (record?.type === 'result' && !session.turnId) return
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
    if (record?.type === 'result') {
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
        this.startSteeredTurn(session)
      }
      this.touch(session)
    }
  }

  private startSteeredTurn(session: BridgeSession): string {
    const turnId = randomUUID()
    session.turnId = turnId
    session.compaction = false
    session.state = emptyMapState(session.state.taskNotifications)
    this.notify({ method: 'turn/started', params: {
      threadId: session.meta.id,
      turn: buildTurn(turnId, [], 'inProgress'),
      ...threadModelConfig(session.settings),
    } })
    return turnId
  }

  private confirmSteers(session: BridgeSession, record: Json): void {
    // SDK 用 UUID 确认实际处理了哪些输入，顺序沿用提交顺序。
    const ids = Array.isArray(record.user_message_uuids)
      ? new Set(record.user_message_uuids) : new Set([record.user_message_uuid])
    const pendingCount = session.pendingSteers.size
    for (const [id, pending] of session.pendingSteers) {
      if (!ids.has(id)) continue
      const turnId = session.turnId ?? this.startSteeredTurn(session)
      const startsTurn = !session.turnMessageIds.has(turnId)
      if (startsTurn) session.turnMessageIds.set(turnId, id)
      const placement = turnId === pending.turnId ? 'currentTurn' : 'nextTurn'
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
  }

  /** 消费循环异常（如 CLI 崩溃）时兜底结束当前 turn，下次 turn/start 会重建 query。 */
  private finishTurn(session: BridgeSession, status: string, error: string): void {
    const turnId = session.turnId
    if (!turnId) return
    session.turnId = null
    session.scope.historyPages.clear(session.meta.id)
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
    const waiting = [...this.approvals.values()].some((pending) => pending.session === session)
    return { type: 'active', activeFlags: waiting ? ['waitingOnApproval'] : [] }
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
    const itemId = scalarText(toolItem?.id) || `${session.turnId ?? 'turn'}-tool`
    const request = buildApprovalRequest({
      requestId,
      threadId: session.meta.id,
      turnId: session.turnId ?? '',
      itemId,
      toolName,
      input,
      ...(extra.decisionReason ? { reason: extra.decisionReason } : {}),
    })
    return new Promise<PermissionResult>((resolve) => {
      this.approvals.set(requestId, { session, resolve, suggestions: extra.suggestions })
      if (extra.signal) {
        extra.signal.addEventListener(
          'abort',
          () => this.settleApproval(requestId, { behavior: 'deny', message: '请求已取消' }),
          { once: true },
        )
      }
      this.emit({ id: requestId, method: request.method, params: request.params })
    })
  }

  private resolveApproval(msg: Json): void {
    const id = msg.id as JsonRpcId
    const pending = this.approvals.get(id)
    if (!pending) return
    this.approvals.delete(id)
    pending.resolve(permissionResult(msg, pending.suggestions))
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
      if (!session.turnId && !session.preparingTurn && session.scope !== this.currentScope()) {
        closeQuery(session)
        this.forgetTemporary(session)
      }
      return
    }
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.turnId || session.preparingTurn) return
      closeQuery(session)
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private requireDeps(): ClaudeDeps {
    if (!this.deps) throw new AgentHostError('agent_unavailable', 'Claude SDK 尚未加载')
    return this.deps
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
    pendingSteers: new Map(),
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

function closeQuery(session: BridgeSession): void {
  const query = session.query
  session.query = null
  session.input?.close()
  session.input = null
  session.pendingSteers.clear()
  try {
    query?.close()
  } catch {
    // 查询可能已结束。
  }
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
