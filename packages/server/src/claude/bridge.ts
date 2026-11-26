/**
 * Claude Agent SDK → codex app-server v2 的桥：会话表、异步输入队列、turn 生命周期、
 * 审批、中断、空闲关闭与错误恢复。只发 v2 JSON-RPC，与客户端的渲染链路完全复用。
 */
import { randomUUID } from 'node:crypto'
import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { classifyJsonRpc, type JsonRpcId } from '@qn/protocol'
import {
  AgentHostError,
  JsonRpcAgentHost,
  type AgentHost,
  type AgentHostHub,
  type AgentOpenOptions,
} from '../codexHost'
import { redact } from '../log'
import { VERSION } from '../version'
import { buildApprovalRequest, permissionResult } from './approval'
import { sessionInfoToMeta, sessionMessagesToThread, threadListResponse } from './history'
import {
  emptyMapState,
  mapSdkMessage,
  turnInputText,
  type MapState,
} from './items'
import { resolveClaudeExecutable, type ClaudeExecutable } from './resolve'
import {
  asRecord,
  buildThread,
  buildTurn,
  emptyRateLimitsResponse,
  isRecord,
  rateLimitSnapshot,
  scalarText,
  userMessageItem,
  type Json,
  type SessionMeta,
  type V2Notification,
} from './v2'

export interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>
  close(): void
}

/** 可注入的 SDK 门面：真机走动态 import，测试注入假的 query 工厂。 */
export interface ClaudeDeps {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): QueryLike
  listSessions(options?: { dir?: string }): Promise<unknown[]>
  getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<unknown[]>
}

export interface ClaudeBridgeOptions {
  deps?: ClaudeDeps
  resolve?: (claudePath?: string) => ClaudeExecutable
  idleTimeoutMs?: number
}

interface BridgeSession {
  meta: SessionMeta
  query: QueryLike | null
  input: AsyncQueue<SDKUserMessage> | null
  turnId: string | null
  state: MapState
  queryCreated: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

interface PendingApproval {
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
      getSessionMessages: (sessionId, options) => sdk.getSessionMessages(sessionId, options),
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

class BridgeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeRpcError'
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
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly metas = new Map<string, SessionMeta>()
  private readonly approvals = new Map<JsonRpcId, PendingApproval>()
  private readonly idleTimeoutMs: number
  private rateLimits: Json = emptyRateLimitsResponse()
  private requestCounter = 0

  constructor(
    hub: AgentHostHub,
    version: string = VERSION,
    private readonly options: ClaudeBridgeOptions = {},
  ) {
    super(hub, version, 'claude-bridge', 'claude')
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  protected async openAgent(options: AgentOpenOptions): Promise<{
    initialize: unknown
    agentVersion?: string
  }> {
    if (this.opened) return { initialize: this.initializeResult, agentVersion: this.claude?.version }
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
    for (const session of this.sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer)
      try {
        session.query?.close()
      } catch {
        // 查询可能已结束。
      }
      session.input?.close()
      session.query = null
      session.input = null
    }
    for (const pending of this.approvals.values()) {
      pending.resolve({ behavior: 'deny', message: 'server 正在退出' })
    }
    this.approvals.clear()
    this.sessions.clear()
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
      const result = await this.handleRequest(method, params)
      this.emit({ id, result })
    } catch (err) {
      const code = err instanceof BridgeRpcError ? err.code : -32603
      const message = describe(err)
      this.hub.log(`claude ${method} 失败: ${redact(message)}`)
      this.emit({ id, error: { code, message } })
    }
  }

  private async handleRequest(method: string, params: Json): Promise<unknown> {
    const deps = this.requireDeps()
    switch (method) {
      case 'initialize':
        return this.initializeResult
      case 'account/read':
        return { account: null }
      case 'account/rateLimits/read':
        return this.rateLimits
      case 'model/list':
        return { data: [], nextCursor: null }
      case 'thread/list': {
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined
        const infos = await deps.listSessions(cwd ? { dir: cwd } : {})
        const fallback = cwd ?? process.cwd()
        for (const info of infos) {
          const meta = sessionInfoToMeta(info, fallback)
          if (meta.id) this.metas.set(meta.id, meta)
        }
        return threadListResponse(infos, fallback)
      }
      case 'thread/start': {
        const id = randomUUID()
        const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd()
        const ephemeral = params.ephemeral === true
        const meta: SessionMeta = { id, cwd, preview: '', ephemeral }
        this.sessions.set(id, makeSession(meta, false))
        this.metas.set(id, meta)
        return threadStartResult(meta)
      }
      case 'thread/resume':
      case 'thread/read': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        const session = await this.sessionFor(threadId, deps, typeof params.cwd === 'string' ? params.cwd : undefined)
        const messages = await deps.getSessionMessages(threadId, { dir: session.meta.cwd })
        const history = sessionMessagesToThread(session.meta, messages)
        return { thread: history.thread }
      }
      case 'turn/start': {
        const threadId = scalarText(params.threadId)
        if (!threadId) throw new BridgeRpcError(-32602, 'threadId 不能为空')
        const text = turnInputText(params.input)
        if (!text) throw new BridgeRpcError(-32602, 'turn/start 需要文本输入')
        const session = await this.sessionFor(threadId, deps, typeof params.cwd === 'string' ? params.cwd : undefined)
        return this.startTurn(session, text)
      }
      case 'turn/interrupt': {
        const threadId = scalarText(params.threadId)
        const session = this.sessions.get(threadId)
        if (!session?.query) throw new BridgeRpcError(-32602, '没有运行中的 turn')
        await session.query.interrupt()
        this.hub.log(`claude turn 已请求中断 (thread=${threadId})`)
        return {}
      }
      default:
        throw new BridgeRpcError(-32601, `不支持的 v2 方法: ${method}`)
    }
  }

  private async startTurn(session: BridgeSession, text: string): Promise<Json> {
    if (session.turnId) {
      // 同一会话已有进行中的 turn 时，输入直接推入同一 query 的队列，由 Claude 自行排队。
      this.pushInput(session, text)
      return { turn: buildTurn(session.turnId, [], 'inProgress') }
    }
    const turnId = randomUUID()
    session.turnId = turnId
    session.state = emptyMapState()
    const userItem = userMessageItem(`${turnId}-user`, text)
    session.state.items[scalarText(userItem.id)] = userItem
    session.state.order.push(scalarText(userItem.id))
    const turn = buildTurn(turnId, [userItem], 'inProgress')
    this.notify({ method: 'turn/started', params: { threadId: session.meta.id, turn } })
    if (!this.claude) throw new AgentHostError('agent_unavailable', 'claude 尚未就绪')
    try {
      this.ensureQuery(session)
      this.pushInput(session, text)
    } catch (err) {
      // 已经广播了 turn/started，失败也必须补 turn/completed，否则界面会一直显示运行中。
      session.turnId = null
      this.notify({
        method: 'turn/completed',
        params: {
          threadId: session.meta.id,
          turn: buildTurn(turnId, [userItem], 'failed', describe(err)),
        },
      })
      throw err
    }
    this.touch(session)
    return { turn }
  }

  private pushInput(session: BridgeSession, text: string): void {
    if (!session.input) throw new BridgeRpcError(-32603, 'claude 输入队列不可用')
    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: session.meta.id,
      uuid: randomUUID(),
    } as unknown as SDKUserMessage
    session.input.push(message)
  }

  private ensureQuery(session: BridgeSession): void {
    if (session.query && session.input) return
    const deps = this.requireDeps()
    const input = new AsyncQueue<SDKUserMessage>()
    const options: Options = {
      cwd: session.meta.cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      persistSession: !session.meta.ephemeral,
      canUseTool: (toolName, toolInput, extra) =>
        this.onCanUseTool(session, toolName, toolInput, {
          suggestions: extra.suggestions,
          toolUseID: extra.toolUseID,
          signal: extra.signal,
          decisionReason: extra.decisionReason,
        }),
      pathToClaudeCodeExecutable: this.claude?.path ?? '',
      env: envStrings(),
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
    void this.consume(session, query)
  }

  private async consume(session: BridgeSession, query: QueryLike): Promise<void> {
    try {
      for await (const message of query) this.onSdkMessage(session, message)
    } catch (err) {
      this.hub.log(`claude query 异常: ${redact(describe(err))}`)
      this.finishTurn(session, 'failed', describe(err))
    } finally {
      if (session.query === query) {
        session.query = null
        session.input = null
      }
      // CLI 提前退出且没有 result 消息时兜底结束 turn，避免 activeTurns 永远不归零。
      if (session.turnId) this.finishTurn(session, 'failed', 'claude 进程提前结束')
    }
  }

  private onSdkMessage(session: BridgeSession, message: unknown): void {
    const record = asRecord(message)
    // 新 SDK 是顶层 rate_limit_event；旧 CLI 也可能把它塞进 system 消息。
    if (record?.type === 'rate_limit_event' || record?.subtype === 'rate_limit_event') {
      const snapshot = rateLimitSnapshot(record.rate_limit_info)
      this.rateLimits = {
        ...emptyRateLimitsResponse(),
        rateLimits: snapshot,
        rateLimitsByLimitId: { claude: snapshot },
      }
    }
    const ctx = {
      threadId: session.meta.id,
      turnId: session.turnId ?? '',
      cwd: session.meta.cwd,
    }
    const mapped = mapSdkMessage(message, ctx, session.state)
    session.state = mapped.state
    for (const note of mapped.notifications) this.notify(note)
    if (record?.type === 'result') {
      session.turnId = null
      this.touch(session)
    }
  }

  /** 消费循环异常（如 CLI 崩溃）时兜底结束当前 turn，下次 turn/start 会重建 query。 */
  private finishTurn(session: BridgeSession, status: string, error: string): void {
    const turnId = session.turnId
    if (!turnId) return
    session.turnId = null
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
      this.approvals.set(requestId, { resolve, suggestions: extra.suggestions })
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
    threadId: string,
    deps: ClaudeDeps,
    cwdHint?: string,
  ): Promise<BridgeSession> {
    const existing = this.sessions.get(threadId)
    if (existing) return existing
    if (!this.metas.has(threadId)) {
      const infos = await deps.listSessions(cwdHint ? { dir: cwdHint } : {})
      const fallback = cwdHint ?? process.cwd()
      for (const info of infos) {
        const meta = sessionInfoToMeta(info, fallback)
        if (meta.id) this.metas.set(meta.id, meta)
      }
    }
    const meta: SessionMeta = this.metas.get(threadId) ?? {
      id: threadId,
      cwd: cwdHint ?? process.cwd(),
      preview: '',
    }
    const session = makeSession(meta, true)
    this.sessions.set(threadId, session)
    return session
  }

  private touch(session: BridgeSession): void {
    // ephemeral 会话不落盘，关闭后无法 resume，因此不做空闲关闭。
    if (!this.opened || session.meta.ephemeral) return
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.turnId) return
      try {
        session.query?.close()
      } catch {
        // 查询可能已结束。
      }
      session.input?.close()
      session.query = null
      session.input = null
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

function makeSession(meta: SessionMeta, queryCreated: boolean): BridgeSession {
  return {
    meta,
    query: null,
    input: null,
    turnId: null,
    state: emptyMapState(),
    queryCreated,
    idleTimer: null,
  }
}

function threadStartResult(meta: SessionMeta): Json {
  return {
    thread: buildThread(meta),
    model: 'claude',
    modelProvider: 'anthropic',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: meta.cwd,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: null,
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
