// 手机端全局状态：连接、目标、项目、会话（按目标 + Agent）、对话、模型、文件查看、额度与事件流。IO 全部经 Gateway 注入。
import {
  applyNotification,
  applyRateLimitsUpdate,
  applyServerRequest,
  approvalResponse,
  CodexRpc,
  emptyState,
  interruptTurn,
  listModels,
  listThreads,
  loadThread,
  pickAccount,
  pickSnapshot,
  readThread,
  resolveServerRequest,
  resumeThread,
  sendText,
  startThread,
  type AccountSummary,
  type ApprovalDecision,
  type ConversationState,
  type RateLimitSnapshot,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
} from '@qn/codex-client'
import { create } from 'zustand'
import {
  agentLabel,
  DEFAULT_AGENT,
  enabledAgents,
  exitedAgent,
  mergeThreadSummaries,
  parseMobileAgents,
  pickDefaultAgent,
  recvSessionKey,
  sessionKey,
  type MobileAgentSettings,
} from './agents'
import { getGateway, isMockGateway } from './client'
import { isImagePath, type FileLocation } from './fileLinks'
import {
  draftFromInfo,
  isValidPairingCode,
  normalizeFingerprint,
  parseAddress,
  parsePairingLink,
  parsePort,
} from './link'
import {
  EMPTY_PREFS,
  overridesFor,
  parsePrefs,
  toModelOptions,
  type ModelList,
  type ModelPrefs,
} from './models'
import {
  applyTargetState,
  formatQuotedMessage,
  friendlyError,
  HOST_KEY_HINT,
  hostKeyMessage,
  isHostKeyError,
  makeId,
  parentPath,
  parseConnections,
  parseProjects,
  parseTargets,
  serializeConnections,
  toThreadSummaries,
  type Annotation,
  type ThreadSummary,
} from './state'
import {
  attachResult,
  EventStreamController,
  isHeartbeat,
  maxSeq,
  MobileCodexTransport,
  openSeq,
} from './transport'
import type {
  AgentKind,
  Connection,
  ConnectionDraft,
  ConnectionStatus,
  Credentials,
  FsEntry,
  FsListResult,
  GatewayEvent,
  ProbeResult,
  Project,
  Target,
  TargetStateEvent,
} from './types'
import { appendRead, nextOffset, parseFsRead, READ_CHUNK_BYTES, viewerError, type FsReadView } from './viewer'

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STORAGE_CONNECTIONS = 'connections'
const STORAGE_ACTIVE = 'active'
const STORAGE_MODEL_PREFS = 'modelPrefs'
const REFRESH_INTERVAL_MS = 60_000
// pi 等 Agent 在会话进程启动前返回空模型列表，空列表隔一段时间允许重取。
const EMPTY_MODELS_RETRY_MS = 15_000
const DEVICE_NAME = 'QingCode Next 手机'
const FINGERPRINT_MISMATCH_HINT =
  '地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息'

export type Page = 'connections' | 'form' | 'targets' | 'projects' | 'threads' | 'chat'

export type FormState = {
  mode: 'add' | 'edit'
  editId: string | null
  returnPage: 'connections' | 'targets'
  draft: Omit<ConnectionDraft, 'port'> & { port: string }
  paste: string
  error: string | null
  testing: boolean
  saving: boolean
  probe: ProbeResult | null
  fpMismatch: string | null
}

export type CredentialPrompt = { targetId: string; name: string }

export type DirectoryState = {
  path: string
  entries: FsEntry[]
  parent: string | null
  loading: boolean
  error: string | null
  saving: boolean
}

export type RateLimitEntry = {
  snapshot: RateLimitSnapshot | null
  account: AccountSummary | null
  updatedAt: number | null
  loading: boolean
  error: string | null
}

/** 一个目标上一个 Agent 的会话通道（键 = sessionKey(targetId, agent)）。 */
export type AgentSession = {
  key: string
  targetId: string
  agent: AgentKind
  rpc: CodexRpc
  transport: MobileCodexTransport
  state: ConversationState
  opened: boolean
  opening: boolean
  openError: string | null
  lastSeq: number | null
  lastTurnId: string | null
}

/** 只读查看页：文件（fs.read）或差异（git.diff，失败回退到改动卡片自带 diff）。 */
export type ViewerState = {
  mode: 'file' | 'diff'
  targetId: string
  path: string
  cwd: string
  line: number | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  file: FsReadView | null
  diff: string | null
  diffSource: 'git' | 'card' | null
  diffTruncated: boolean
  notice: string | null
}

export type DiffRequest = { path: string; diff?: string | null }

type AppState = {
  page: Page
  booting: boolean
  mock: boolean
  connections: Connection[]
  activeId: string | null
  connectionStatus: Record<string, ConnectionStatus>
  form: FormState | null
  credential: CredentialPrompt | null
  directory: DirectoryState | null
  eventsConnected: boolean
  eventsError: string | null
  targets: Target[]
  targetStates: Record<string, TargetStateEvent>
  targetErrors: Record<string, string>
  connectingId: string | null
  projects: Project[]
  projectsLoading: boolean
  selectedTargetId: string | null
  selectedProjectId: string | null
  /** null = 桌面不支持 mobile.agents（旧版本），只用 Codex。 */
  agentSettings: MobileAgentSettings | null
  threads: ThreadSummary[]
  threadsLoading: boolean
  threadsError: string | null
  /** 单个 Agent 打开或列会话失败的提示，不影响其他 Agent。 */
  agentErrors: Partial<Record<AgentKind, string>>
  selectedThreadId: string | null
  /** 当前对话（或待建会话）所属 Agent。 */
  selectedAgent: AgentKind
  sessions: Record<string, AgentSession>
  models: Record<string, ModelList>
  modelPrefs: Record<string, ModelPrefs>
  rateLimits: Record<string, RateLimitEntry>
  viewer: ViewerState | null
  annotations: Annotation[]
  sending: boolean
  error: string | null
  notice: string | null

  init: () => () => void
  refreshStatuses: () => Promise<void>
  openAddForm: () => void
  openEditForm: (id: string) => void
  setFormPaste: (text: string) => void
  parsePaste: () => void
  pasteFromClipboard: () => Promise<void>
  updateDraft: (field: Exclude<keyof ConnectionDraft, 'fp'>, value: string) => void
  testConnection: () => Promise<void>
  pairAndSave: () => Promise<void>
  saveEdit: () => Promise<void>
  closeForm: () => void
  removeConnection: (id: string) => Promise<void>
  activate: (id: string) => Promise<void>
  deactivate: () => void
  loadTargets: () => Promise<void>
  loadAgentSettings: () => Promise<void>
  requestConnect: (id: string) => void
  submitCredentials: (password: string, remember: boolean) => Promise<void>
  cancelCredentials: () => void
  connect: (id: string, credentials: Credentials) => Promise<void>
  disconnectTarget: (id: string) => Promise<void>
  selectTarget: (id: string) => Promise<void>
  selectProject: (id: string) => Promise<void>
  openDirectory: () => Promise<void>
  browseDirectory: (path: string) => Promise<void>
  closeDirectory: () => void
  chooseDirectory: () => Promise<void>
  ensureOpen: (targetId: string, agent?: AgentKind) => Promise<boolean>
  attachOpened: () => Promise<void>
  /** skipFailed：后台刷新（如 turn 完成后）不重试已确认打不开的 Agent，避免反复拉起。 */
  refreshThreads: (options?: { skipFailed?: boolean }) => Promise<void>
  newThread: (agent?: AgentKind) => Promise<void>
  openThread: (id: string, agent?: AgentKind) => Promise<void>
  send: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  respondApproval: (requestId: RequestId, decision: ApprovalDecision) => void
  loadModels: (targetId: string, agent: AgentKind, force?: boolean) => Promise<void>
  setModelPrefs: (targetId: string, agent: AgentKind, prefs: ModelPrefs) => void
  refreshRateLimits: (targetId: string) => Promise<void>
  openFile: (location: FileLocation) => Promise<void>
  loadMoreFile: () => Promise<void>
  openDiff: (request: DiffRequest) => Promise<void>
  closeViewer: () => void
  addAnnotation: (quote: string, comment?: string) => void
  updateAnnotation: (id: string, comment: string) => void
  removeAnnotation: (id: string) => void
  handleGatewayEvent: (event: GatewayEvent) => void
  goBack: () => boolean
  clearError: () => void
  clearNotice: () => void
}

const emptyRateLimit = (): RateLimitEntry => ({
  snapshot: null,
  account: null,
  updatedAt: null,
  loading: false,
  error: null,
})

const emptyForm = (
  mode: 'add' | 'edit', editId: string | null, returnPage: FormState['returnPage'], draft: ConnectionDraft,
): FormState => ({
  mode,
  editId,
  returnPage,
  draft: { ...draft, port: String(draft.port) },
  paste: '',
  error: null,
  testing: false,
  saving: false,
  probe: null,
  fpMismatch: null,
})

function draftEndpoint(draft: FormState['draft']): { host: string; port: number } | null {
  const address = parseAddress(draft.host)
  const port = address?.port ?? parsePort(draft.port)
  return address && port !== null ? { host: address.host, port } : null
}

const activeConnection = (state: AppState): Connection | null =>
  state.connections.find((item) => item.id === state.activeId) ?? null

/** 当前项目目录：相对路径解析、新建会话、git.diff 的 cwd 都以它为准。 */
export const currentCwd = (state: Pick<AppState, 'projects' | 'selectedProjectId'>): string =>
  state.projects.find((item) => item.id === state.selectedProjectId)?.path ?? ''

/** 当前目标上启用的 Agent（旧桌面只有 Codex）。 */
export const targetAgents = (state: Pick<AppState, 'agentSettings'>, targetId: string | null): AgentKind[] =>
  targetId ? enabledAgents(state.agentSettings, targetId) : [DEFAULT_AGENT]

/** 已确认打开失败的 Agent；新建会话的默认选择会跳过它们。 */
export const unavailableAgents = (
  state: Pick<AppState, 'sessions'>,
  targetId: string,
  agents: readonly AgentKind[],
): Set<AgentKind> =>
  new Set(
    agents.filter((agent) => {
      const session = state.sessions[sessionKey(targetId, agent)]
      return Boolean(session && !session.opened && !session.opening && session.openError)
    }),
  )

export const defaultAgentFor = (
  state: Pick<AppState, 'agentSettings' | 'sessions'>,
  targetId: string,
): AgentKind => {
  const agents = targetAgents(state, targetId)
  return pickDefaultAgent(state.agentSettings?.defaultAgent ?? DEFAULT_AGENT, agents, unavailableAgents(state, targetId, agents))
}

const openFailureMessage = (agent: AgentKind, err: unknown): string =>
  friendlyError(
    err,
    agent === 'codex' ? 'Codex 未就绪，请确认目标已连接' : `${agentLabel(agent)} 打开失败，请确认目标机已安装并登录`,
  )

let initialized = false
let controller: EventStreamController | null = null
let refreshToken = 0
let viewerToken = 0
const opening = new Map<string, Promise<boolean>>()
const rateRefresh = new Map<string, Promise<void>>()

export const useApp = create<AppState>((set, get) => {
  const persist = async (connections: Connection[], activeId: string | null): Promise<void> => {
    try {
      await getGateway().storageSet(STORAGE_CONNECTIONS, serializeConnections(connections))
      await getGateway().storageSet(STORAGE_ACTIVE, activeId)
    } catch (err) {
      set({ error: friendlyError(err, '保存连接失败') })
    }
  }

  const patchSession = (key: string, update: (session: AgentSession) => AgentSession): void => {
    set((state) => {
      const session = state.sessions[key]
      if (!session) return state
      const next = update(session)
      return next === session ? state : { sessions: { ...state.sessions, [key]: next } }
    })
  }

  const patchRate = (targetId: string, changes: Partial<RateLimitEntry>): void => {
    set((state) => ({
      rateLimits: {
        ...state.rateLimits,
        [targetId]: { ...(state.rateLimits[targetId] ?? emptyRateLimit()), ...changes },
      },
    }))
  }

  const patchViewer = (token: number, changes: Partial<ViewerState>): void => {
    if (token !== viewerToken) return
    set((state) => (state.viewer ? { viewer: { ...state.viewer, ...changes } } : state))
  }

  const resetSessions = (): void => {
    for (const session of Object.values(get().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
    opening.clear()
    rateRefresh.clear()
  }

  const serverReq = <T>(targetId: string, method: string, params: unknown): Promise<T> => {
    const conn = activeConnection(get())
    if (!conn) return Promise.reject(new Error('尚未选择电脑'))
    return getGateway().rpc<T>(conn, 'server.req', { targetId, method, params })
  }

  const handleRateLimitNotification = (targetId: string, msg: unknown): void => {
    const record = isRecord(msg) ? msg : null
    if (!record) return
    if (record.method === 'account/rateLimits/updated') {
      const current = get().rateLimits[targetId]?.snapshot ?? null
      patchRate(targetId, {
        snapshot: applyRateLimitsUpdate(current, msg),
        updatedAt: Date.now(),
        error: null,
      })
    } else if (record.method === 'turn/completed') {
      void get().refreshRateLimits(targetId)
    }
  }

  const sessionFor = (targetId: string, agent: AgentKind): AgentSession => {
    const key = sessionKey(targetId, agent)
    const existing = get().sessions[key]
    if (existing) return existing

    const transport = new MobileCodexTransport(
      targetId,
      (msg) => {
        const conn = activeConnection(get())
        if (!conn) return Promise.reject(new Error('尚未选择电脑'))
        // agent 直接放进 params：网关与 backend 都按 params.agent 路由，旧桌面会忽略它。
        return getGateway().rpc(conn, 'codex.send', { targetId, agent, msg })
      },
      agent,
    )
    const rpc = new CodexRpc(transport, { timeoutMs: 30_000 })
    const session: AgentSession = {
      key,
      targetId,
      agent,
      rpc,
      transport,
      state: emptyState(),
      opened: false,
      opening: false,
      openError: null,
      lastSeq: null,
      lastTurnId: null,
    }
    set((state) => ({ sessions: { ...state.sessions, [key]: session } }))

    rpc.onNotification((notification: ServerNotification) => {
      patchSession(key, (current) => ({
        ...current,
        state: applyNotification(current.state, notification),
      }))
      // 额度面板只展示 Codex 账号（mvp §10），其他 Agent 的限额事件不混进来。
      if (agent === 'codex') handleRateLimitNotification(targetId, notification)
      const method = (notification as unknown as JsonRecord).method
      if (method === 'turn/completed' || method === 'thread/started') {
        if (get().selectedTargetId === targetId) void get().refreshThreads({ skipFailed: true })
      }
    })
    rpc.onServerRequest((request: ServerRequest) => {
      // 审批只入队等用户点；手机端任何路径都不自动应答（docs/agent-adapters.md R7）。
      patchSession(key, (current) => ({
        ...current,
        state: applyServerRequest(current.state, request),
      }))
    })
    return session
  }

  const persistModelPrefs = (prefs: Record<string, ModelPrefs>): void => {
    void getGateway()
      .storageSet(STORAGE_MODEL_PREFS, JSON.stringify(prefs))
      .catch(() => undefined)
  }

  /** 确认会话通道可用后执行；失败把原因写到 error。 */
  const withSession = async (targetId: string, agent: AgentKind): Promise<AgentSession | null> => {
    if (!(await get().ensureOpen(targetId, agent))) {
      const key = sessionKey(targetId, agent)
      set({ error: get().sessions[key]?.openError ?? `${agentLabel(agent)} 未就绪` })
      return null
    }
    return get().sessions[sessionKey(targetId, agent)] ?? null
  }

  return {
    page: 'connections',
    booting: true,
    mock: false,
    connections: [],
    activeId: null,
    connectionStatus: {},
    form: null,
    credential: null,
    directory: null,
    eventsConnected: false,
    eventsError: null,
    targets: [],
    targetStates: {},
    targetErrors: {},
    connectingId: null,
    projects: [],
    projectsLoading: false,
    selectedTargetId: null,
    selectedProjectId: null,
    agentSettings: null,
    threads: [],
    threadsLoading: false,
    threadsError: null,
    agentErrors: {},
    selectedThreadId: null,
    selectedAgent: DEFAULT_AGENT,
    sessions: {},
    models: {},
    modelPrefs: {},
    rateLimits: {},
    viewer: null,
    annotations: [],
    sending: false,
    error: null,
    notice: null,

    init: () => {
      if (initialized) return () => undefined
      initialized = true
      const gateway = getGateway()
      set({ mock: isMockGateway() })
      if (typeof window !== 'undefined') {
        window.__qnBack = () => get().goBack()
      }
      controller = new EventStreamController(gateway, () => activeConnection(get()), {
        onEvent: (event) => get().handleGatewayEvent(event),
        onOpen: (reconnected) => {
          set({ eventsConnected: true, eventsError: null })
          if (reconnected) void get().attachOpened()
        },
        onClose: (error) => set({ eventsConnected: false, eventsError: error }),
      })
      void (async () => {
        try {
          const [raw, active, prefs] = await Promise.all([
            gateway.storageGet(STORAGE_CONNECTIONS),
            gateway.storageGet(STORAGE_ACTIVE),
            gateway.storageGet(STORAGE_MODEL_PREFS).catch(() => null),
          ])
          const connections = parseConnections(raw)
          const activeId = active && connections.some((item) => item.id === active) ? active : null
          set({ connections, activeId, booting: false, modelPrefs: parsePrefs(prefs) })
          if (activeId) await get().activate(activeId)
          else void get().refreshStatuses()
        } catch (err) {
          set({ booting: false, error: friendlyError(err, '读取本地连接失败') })
        }
      })()
      setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        for (const session of Object.values(get().sessions)) {
          if (session.opened && session.agent === 'codex') void get().refreshRateLimits(session.targetId)
        }
      }, REFRESH_INTERVAL_MS)
      // WebView 生命周期内不拆除事件流，避免 React 开发态重复挂载造成重连风暴。
      return () => undefined
    },

    refreshStatuses: async () => {
      const connections = get().connections
      if (connections.length === 0) return
      set({
        connectionStatus: Object.fromEntries(
          connections.map((item) => [item.id, 'checking' as ConnectionStatus]),
        ),
      })
      await Promise.all(
        connections.map(async (item) => {
          let status: ConnectionStatus = 'offline'
          try {
            const probe = await getGateway().probe(item.host, item.port)
            status = normalizeFingerprint(probe.fingerprint) === item.fp ? 'online' : 'mismatch'
          } catch {
            status = 'offline'
          }
          set((state) => ({ connectionStatus: { ...state.connectionStatus, [item.id]: status } }))
        }),
      )
    },

    openAddForm: () => {
      set({
        page: 'form',
        form: emptyForm('add', null, 'connections', { name: '', host: '', port: 38500, fp: '', code: '' }),
        error: null,
      })
    },

    openEditForm: (id) => {
      const conn = get().connections.find((item) => item.id === id)
      if (!conn) return
      const returnPage = get().page === 'targets' ? 'targets' : 'connections'
      set({
        page: 'form',
        form: emptyForm('edit', id, returnPage, {
          name: conn.name,
          host: conn.host,
          port: conn.port,
          fp: conn.fp,
          code: '',
        }),
        error: null,
      })
    },

    setFormPaste: (text) => {
      const form = get().form
      if (!form || form.saving) return
      set({ form: { ...form, paste: text, testing: false, error: null } })
    },

    parsePaste: () => {
      const form = get().form
      if (!form || form.saving) return
      const info = parsePairingLink(form.paste)
      if (!info) {
        set({ form: { ...form, testing: false, error: '未找到有效的连接信息，请粘贴包含 qingcode-next://pair? 的文本' } })
        return
      }
      if (form.mode === 'edit' && info.fp !== normalizeFingerprint(form.draft.fp)) {
        set({ form: { ...form, testing: false, error: '这份连接信息的证书指纹不同，请作为新连接导入' } })
        return
      }
      const { name, host, port, fp, code } = draftFromInfo(info)
      set({
        form: {
          ...form,
          draft: form.mode === 'edit'
            ? { ...form.draft, host, port: String(port) }
            : { name, host, port: String(port), fp, code },
          paste: '',
          testing: false,
          error: null,
          probe: null,
          fpMismatch: null,
        },
      })
    },

    pasteFromClipboard: async () => {
      const form = get().form
      if (!form || form.saving) return
      try {
        const text = await getGateway().readClipboard()
        if (get().form !== form) return
        get().setFormPaste(text)
        get().parsePaste()
      } catch (err) {
        if (get().form === form) {
          set({ form: { ...form, testing: false, error: friendlyError(err, '读取剪贴板失败') } })
        }
      }
    },

    updateDraft: (field, value) => {
      const form = get().form
      if (!form || form.saving) return
      const draft = { ...form.draft, [field]: value }
      set({ form: { ...form, draft, testing: false, error: null, probe: null, fpMismatch: null } })
    },

    testConnection: async () => {
      const form = get().form
      if (!form || form.saving || form.testing) return
      const endpoint = draftEndpoint(form.draft)
      const fp = normalizeFingerprint(form.draft.fp)
      if (!endpoint || !fp) {
        set({ form: { ...form, error: '请先填写有效的主机、端口与 64 位证书指纹' } })
        return
      }
      const pending = { ...form, testing: true, error: null, fpMismatch: null, probe: null }
      set({ form: pending })
      try {
        const result = await getGateway().probe(endpoint.host, endpoint.port)
        const actual = normalizeFingerprint(result.fingerprint)
        if (get().form !== pending) return
        if (actual === null) {
          set({ form: { ...pending, testing: false, error: '电脑未返回有效的证书指纹' } })
        } else if (actual !== fp) {
          set({ form: { ...pending, testing: false, fpMismatch: FINGERPRINT_MISMATCH_HINT } })
        } else {
          set({ form: { ...pending, testing: false, probe: result } })
        }
      } catch (err) {
        if (get().form === pending) {
          set({ form: { ...pending, testing: false, error: friendlyError(err, '测试连接失败，请检查地址与电脑是否在线') } })
        }
      }
    },

    pairAndSave: async () => {
      const form = get().form
      if (!form || form.mode !== 'add' || form.saving || form.testing) return
      const endpoint = draftEndpoint(form.draft)
      const fp = normalizeFingerprint(form.draft.fp)
      if (!endpoint || !fp) {
        set({ form: { ...form, error: '连接信息不完整，请重新粘贴或填写' } })
        return
      }
      const draft: ConnectionDraft = { ...form.draft, ...endpoint, fp }
      if (!isValidPairingCode(draft.code)) {
        set({ form: { ...form, error: '配对密码需为 6–20 位且不含空白字符' } })
        return
      }
      if (form.fpMismatch) {
        set({ form: { ...form, error: FINGERPRINT_MISMATCH_HINT } })
        return
      }
      set({ form: { ...form, saving: true, error: null } })
      try {
        const result = await getGateway().pair(
          draft,
          get().mock ? '浏览器调试' : DEVICE_NAME,
        )
        const conn: Connection = {
          id: makeId(),
          name: draft.name.trim() || '未命名电脑',
          host: draft.host,
          port: draft.port,
          fp,
          token: result.token,
          desktopName: result.desktopName || draft.name,
          createdAt: Date.now(),
        }
        const connections = [...get().connections, conn]
        set({ connections, form: null, page: 'connections' })
        await persist(connections, get().activeId)
        void get().refreshStatuses()
        await get().activate(conn.id)
      } catch (err) {
        const current = get().form
        if (current) {
          set({ form: { ...current, saving: false, error: friendlyError(err, '配对失败') } })
        }
      }
    },

    saveEdit: async () => {
      const form = get().form
      if (!form || form.mode !== 'edit' || !form.editId || form.saving || form.testing) return
      const endpoint = draftEndpoint(form.draft)
      if (!endpoint) {
        set({ form: { ...form, error: '主机或端口格式不正确' } })
        return
      }
      if (form.fpMismatch) return
      const previous = get().connections.find((item) => item.id === form.editId)
      if (!previous) return
      const updated: Connection = { ...previous, ...endpoint, name: form.draft.name.trim() || previous.name }
      const connections = get().connections.map((item) => (item.id === form.editId ? updated : item))
      set({ form: { ...form, saving: true, error: null } })
      try {
        await getGateway().storageSet(STORAGE_CONNECTIONS, serializeConnections(connections))
      } catch (err) {
        set({ form: { ...form, error: friendlyError(err, '保存修改失败') } })
        return
      }
      set({ connections, form: null, page: form.returnPage })
      const changedEndpoint = updated.host !== previous.host || updated.port !== previous.port
      if (get().activeId === previous.id && changedEndpoint) {
        set({ eventsConnected: false, eventsError: null, targets: [], error: null })
        controller?.stop()
        controller?.start(true)
        await get().loadTargets()
      }
      void get().refreshStatuses()
    },

    closeForm: () => {
      const form = get().form
      if (form && !form.saving) set({ form: null, page: form.returnPage })
    },

    removeConnection: async (id) => {
      const wasActive = get().activeId === id
      const connections = get().connections.filter((item) => item.id !== id)
      const activeId = wasActive ? null : get().activeId
      if (wasActive) {
        controller?.stop()
        resetSessions()
        viewerToken += 1
        set({
          sessions: {},
          models: {},
          rateLimits: {},
          targets: [],
          projects: [],
          threads: [],
          agentErrors: {},
          agentSettings: null,
          viewer: null,
          targetStates: {},
          selectedTargetId: null,
          selectedProjectId: null,
          selectedThreadId: null,
          eventsConnected: false,
        })
      }
      set({ connections, activeId, page: wasActive ? 'connections' : get().page })
      await persist(connections, activeId)
      void get().refreshStatuses()
    },

    activate: async (id) => {
      const conn = get().connections.find((item) => item.id === id)
      if (!conn) return
      set({
        activeId: id,
        page: 'targets',
        targets: [],
        targetStates: {},
        targetErrors: {},
        projects: [],
        selectedTargetId: null,
        selectedProjectId: null,
        selectedThreadId: null,
        threads: [],
        agentErrors: {},
        agentSettings: null,
        viewer: null,
        error: null,
        notice: null,
      })
      void persist(get().connections, id)
      controller?.stop()
      controller?.start()
      await Promise.all([get().loadTargets(), get().loadAgentSettings()])
    },

    deactivate: () => set({ page: 'connections' }),

    loadTargets: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      try {
        const result = await getGateway().rpc<unknown>(conn, 'targets.list', {})
        set({ targets: parseTargets(result), connectionStatus: { ...get().connectionStatus, [conn.id]: 'online' } })
      } catch (err) {
        set({ error: friendlyError(err, '读取目标列表失败') })
      }
    },

    loadAgentSettings: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      try {
        const result = await getGateway().rpc<unknown>(conn, 'mobile.agents', {})
        if (activeConnection(get())?.id === conn.id) set({ agentSettings: parseMobileAgents(result) })
      } catch {
        // 旧桌面版本没有 mobile.agents：只用 Codex。
        if (activeConnection(get())?.id === conn.id) set({ agentSettings: null })
      }
    },

    requestConnect: (id) => {
      const target = get().targets.find((item) => item.id === id)
      if (!target) return
      if (target.kind === 'ssh' && target.auth.kind === 'password') {
        set({ credential: { targetId: id, name: target.name } })
        return
      }
      void get().connect(id, {})
    },

    submitCredentials: async (password, remember) => {
      const prompt = get().credential
      if (!prompt) return
      await get().connect(prompt.targetId, {
        ...(password ? { password } : {}),
        ...(remember ? { remember: true } : {}),
      })
    },

    cancelCredentials: () => set({ credential: null }),

    connect: async (id, credentials) => {
      const conn = activeConnection(get())
      if (!conn) {
        set({ error: '尚未选择电脑' })
        return
      }
      set((state) => {
        const errors = { ...state.targetErrors }
        delete errors[id]
        return {
          connectingId: id,
          credential: null,
          targetErrors: errors,
          targetStates: applyTargetState(state.targetStates, { id, state: 'connecting' }),
        }
      })
      try {
        // SSH 部署 + 电脑端指纹确认可能超过默认 40s，单独放宽等待。
        await getGateway().rpc(conn, 'target.connect', { id, ...credentials }, undefined, 120_000)
      } catch (err) {
        const message = hostKeyMessage(err, '连接失败')
        set((state) => ({
          targetErrors: { ...state.targetErrors, [id]: message },
          targetStates: applyTargetState(state.targetStates, { id, state: 'error', detail: message }),
          notice: isHostKeyError(err) ? HOST_KEY_HINT : null,
        }))
      } finally {
        set({ connectingId: null })
      }
    },

    disconnectTarget: async (id) => {
      const conn = activeConnection(get())
      if (!conn) return
      try {
        await getGateway().rpc(conn, 'target.disconnect', { id })
        set((state) => ({ targetStates: applyTargetState(state.targetStates, { id, state: 'idle' }) }))
      } catch (err) {
        set({ notice: friendlyError(err, '断开失败') })
      }
    },

    selectTarget: async (id) => {
      const conn = activeConnection(get())
      if (!conn) return
      set({
        selectedTargetId: id,
        selectedProjectId: null,
        selectedThreadId: null,
        projects: [],
        projectsLoading: true,
        threads: [],
        agentErrors: {},
        page: 'projects',
      })
      // 启用状态可能在电脑上刚改过，每次进入目标都重新取一次（失败不阻断）。
      void get().loadAgentSettings()
      try {
        const result = await getGateway().rpc<unknown>(conn, 'projects.list', { targetId: id })
        set({ projects: parseProjects(result), projectsLoading: false })
      } catch (err) {
        set({ projectsLoading: false, error: friendlyError(err, '读取项目列表失败') })
      }
    },

    selectProject: async (id) => {
      const conn = activeConnection(get())
      const project = get().projects.find((item) => item.id === id)
      if (!conn || !project) return
      // 打开项目时刷新 lastOpenedAt（与电脑端一致）。
      try {
        await getGateway().rpc(conn, 'projects.save', {
          id: project.id,
          targetId: project.targetId,
          name: project.name,
          path: project.path,
        })
      } catch {
        // 刷新失败不阻断打开会话。
      }
      set({
        selectedProjectId: id,
        selectedThreadId: null,
        threads: [],
        threadsError: null,
        agentErrors: {},
        page: 'threads',
      })
      await get().refreshThreads()
    },

    openDirectory: async () => {
      const conn = activeConnection(get())
      const targetId = get().selectedTargetId
      if (!conn || !targetId) return
      set({ directory: { path: '', entries: [], parent: null, loading: true, error: null, saving: false } })
      try {
        const home = await getGateway().rpc<{ path: string }>(conn, 'server.req', {
          targetId,
          method: 'fs.home',
          params: {},
        })
        await get().browseDirectory(home.path)
      } catch (err) {
        const current = get().directory
        if (current) set({ directory: { ...current, loading: false, error: friendlyError(err, '读取主目录失败') } })
      }
    },

    browseDirectory: async (path) => {
      const conn = activeConnection(get())
      const targetId = get().selectedTargetId
      if (!conn || !targetId) return
      const current = get().directory
      set({ directory: { path, entries: current?.entries ?? [], parent: parentPath(path), loading: true, error: null, saving: false } })
      try {
        const result = await getGateway().rpc<FsListResult>(conn, 'server.req', {
          targetId,
          method: 'fs.list',
          params: { path, dirsOnly: true },
        })
        const entries = Array.isArray(result.entries) ? result.entries : []
        set({
          directory: {
            path: typeof result.path === 'string' && result.path ? result.path : path,
            entries: entries.filter((entry) => entry.kind === 'dir' || entry.kind === 'symlink'),
            parent: parentPath(path),
            loading: false,
            error: null,
            saving: false,
          },
        })
      } catch (err) {
        set({
          directory: {
            path,
            entries: [],
            parent: parentPath(path),
            loading: false,
            error: friendlyError(err, '读取目录失败'),
            saving: false,
          },
        })
      }
    },

    closeDirectory: () => set({ directory: null }),

    chooseDirectory: async () => {
      const conn = activeConnection(get())
      const dir = get().directory
      const targetId = get().selectedTargetId
      if (!conn || !dir || !targetId || !dir.path) return
      set({ directory: { ...dir, saving: true, error: null } })
      try {
        const saved = await getGateway().rpc<unknown>(conn, 'projects.save', { targetId, path: dir.path })
        const parsed = parseProjects([saved])
        const project =
          parsed[0] ??
          ({
            id: makeId(),
            targetId,
            name: dir.path.split(/[\\/]/).filter(Boolean).pop() ?? dir.path,
            path: dir.path,
            lastOpenedAt: Date.now(),
          } satisfies Project)
        set((state) => ({
          projects: [...state.projects.filter((item) => item.id !== project.id), project],
          directory: null,
          selectedProjectId: project.id,
          threads: [],
          agentErrors: {},
          page: 'threads',
        }))
        await get().refreshThreads()
      } catch (err) {
        const current = get().directory
        if (current) set({ directory: { ...current, saving: false, error: friendlyError(err, '添加项目失败') } })
      }
    },

    ensureOpen: async (targetId, agent = DEFAULT_AGENT) => {
      const key = sessionKey(targetId, agent)
      const existing = get().sessions[key]
      if (existing?.opened) return true
      const busy = opening.get(key)
      if (busy) return busy
      const conn = activeConnection(get())
      if (!conn) {
        set({ error: '尚未选择电脑' })
        return false
      }
      const session = sessionFor(targetId, agent)
      patchSession(key, (value) => ({ ...value, opening: true, openError: null }))
      const task = (async () => {
        try {
          // 可执行文件路径由网关按电脑设置补上，手机不传路径。
          const opened = await getGateway().rpc<unknown>(conn, 'server.req', {
            targetId,
            method: 'codex.open',
            params: { agent },
          })
          let lastSeq = maxSeq(openSeq(opened), session.transport.getLastSeq())
          try {
            // 每个 agent 有独立的回放缓冲，attach 必须带上 agent。
            const attached = await getGateway().rpc<unknown>(conn, 'server.req', {
              targetId,
              method: 'codex.attach',
              params: { agent, sinceSeq: lastSeq ?? 0 },
            })
            const info = attachResult(attached)
            lastSeq = maxSeq(lastSeq, info.lastSeq)
            if (info.truncated) {
              set({ notice: `${agentLabel(agent)} 历史缓冲已裁剪，请重新打开会话加载完整记录` })
            }
          } catch {
            // 旧版 daemon 没有 attach 时仍能正常对话。
          }
          session.transport.setLastSeq(lastSeq)
          patchSession(key, (value) => ({
            ...value,
            opened: true,
            opening: false,
            openError: null,
            lastSeq,
          }))
          if (agent === 'codex') void get().refreshRateLimits(targetId)
          return true
        } catch (err) {
          patchSession(key, (value) => ({
            ...value,
            opened: false,
            opening: false,
            openError: openFailureMessage(agent, err),
          }))
          return false
        } finally {
          opening.delete(key)
          patchSession(key, (value) => ({ ...value, opening: false }))
        }
      })()
      opening.set(key, task)
      return task
    },

    attachOpened: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      for (const [key, session] of Object.entries(get().sessions)) {
        if (!session.opened) continue
        try {
          const result = await getGateway().rpc<unknown>(conn, 'server.req', {
            targetId: session.targetId,
            method: 'codex.attach',
            params: { agent: session.agent, sinceSeq: session.transport.getLastSeq() ?? 0 },
          })
          const info = attachResult(result)
          session.transport.setLastSeq(info.lastSeq)
          patchSession(key, (value) => ({ ...value, lastSeq: maxSeq(value.lastSeq, info.lastSeq) }))
          if (info.truncated) set({ notice: '事件流重连后有历史消息被裁剪，请重新打开会话' })
        } catch {
          // 下次操作会再尝试，不打断页面。
        }
      }
    },

    refreshThreads: async (options) => {
      const token = ++refreshToken
      const targetId = get().selectedTargetId
      if (!targetId) {
        set({ threads: [], threadsLoading: false, threadsError: null, agentErrors: {} })
        return
      }
      const cwd = currentCwd(get()) || undefined
      const all = targetAgents(get(), targetId)
      const skipped = options?.skipFailed ? unavailableAgents(get(), targetId, all) : new Set<AgentKind>()
      const agents = all.filter((agent) => !skipped.has(agent))
      const previousErrors = get().agentErrors
      set({ threadsLoading: true, threadsError: null })
      // 各 Agent 并行打开、各自列会话；某个失败只记在它自己名下。
      const results = await Promise.all(
        agents.map(async (agent): Promise<{ agent: AgentKind; threads: ThreadSummary[]; error: string | null }> => {
          if (!(await get().ensureOpen(targetId, agent))) {
            const message = get().sessions[sessionKey(targetId, agent)]?.openError ?? `${agentLabel(agent)} 未就绪`
            return { agent, threads: [], error: message }
          }
          const session = get().sessions[sessionKey(targetId, agent)]
          if (!session) return { agent, threads: [], error: `${agentLabel(agent)} 未就绪` }
          try {
            return { agent, threads: toThreadSummaries(await listThreads(session.rpc, cwd), agent), error: null }
          } catch (err) {
            return { agent, threads: [], error: friendlyError(err, '加载会话列表失败') }
          }
        }),
      )
      if (token !== refreshToken || get().selectedTargetId !== targetId) return
      const agentErrors: Partial<Record<AgentKind, string>> = {}
      for (const agent of skipped) {
        const previous = previousErrors[agent]
        if (previous) agentErrors[agent] = previous
      }
      for (const result of results) if (result.error) agentErrors[result.agent] = result.error
      const allFailed = skipped.size === 0 && results.length > 0 && results.every((result) => result.error !== null)
      set({
        threads: mergeThreadSummaries(results.map((result) => result.threads)),
        threadsLoading: false,
        agentErrors,
        threadsError: allFailed
          ? results.map((result) => `${agentLabel(result.agent)}：${result.error}`).join('\n')
          : null,
      })
    },

    newThread: async (agent) => {
      const targetId = get().selectedTargetId
      if (!targetId) return
      const picked = agent ?? defaultAgentFor(get(), targetId)
      if (!targetAgents(get(), targetId).includes(picked)) {
        set({ error: `${agentLabel(picked)} 已在电脑设置中关闭` })
        return
      }
      const session = await withSession(targetId, picked)
      if (!session) return
      const cwd = currentCwd(get())
      try {
        const result = await startThread(session.rpc, cwd ? { cwd } : {})
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, result.thread) }))
        set({
          selectedThreadId: result.thread.id,
          selectedAgent: picked,
          page: 'chat',
          error: null,
          annotations: [],
        })
        void get().refreshThreads({ skipFailed: true })
      } catch (err) {
        set({ error: friendlyError(err, '新建会话失败') })
      }
    },

    openThread: async (id, agent) => {
      const targetId = get().selectedTargetId
      if (!targetId) return
      const picked = agent ?? get().threads.find((item) => item.id === id)?.agent ?? DEFAULT_AGENT
      const session = await withSession(targetId, picked)
      if (!session) return
      try {
        let result: { thread: Parameters<typeof loadThread>[1] }
        try {
          result = await resumeThread(session.rpc, id)
        } catch {
          result = await readThread(session.rpc, id)
        }
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, result.thread) }))
        set({ selectedThreadId: id, selectedAgent: picked, page: 'chat', error: null, annotations: [] })
      } catch (err) {
        set({ error: friendlyError(err, '打开会话失败') })
      }
    },

    send: async (text) => {
      const annotations = get().annotations
      const finalText = formatQuotedMessage(annotations, text)
      if (!finalText.trim() || get().sending) return
      const targetId = get().selectedTargetId
      if (!targetId) {
        set({ error: '请先选择目标' })
        return
      }
      const agent = get().selectedAgent
      const session = await withSession(targetId, agent)
      if (!session) return
      set({ sending: true, error: null })
      try {
        let threadId = get().selectedThreadId
        if (!threadId) {
          const cwd = currentCwd(get())
          const created = await startThread(session.rpc, cwd ? { cwd } : {})
          patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, created.thread) }))
          threadId = created.thread.id
          set({ selectedThreadId: threadId })
          void get().refreshThreads({ skipFailed: true })
        }
        const models = get().models[session.key]?.models ?? []
        const prefs = get().modelPrefs[session.key] ?? EMPTY_PREFS
        const started = await sendText(session.rpc, threadId, finalText, overridesFor(agent, models, prefs))
        // turn/started 通知可能晚于响应，先按返回值把状态置为运行中，保证中断按钮可用。
        const synthetic = {
          method: 'turn/started',
          params: { threadId, turnId: started.turn.id, turn: started.turn },
        } as unknown as ServerNotification
        patchSession(session.key, (value) => ({
          ...value,
          lastTurnId: started.turn.id || value.lastTurnId,
          state: applyNotification(value.state, synthetic),
        }))
        set({ sending: false, annotations: [], page: 'chat' })
      } catch (err) {
        set({ sending: false, error: friendlyError(err, '发送消息失败') })
      }
    },

    interrupt: async () => {
      const { selectedTargetId, selectedThreadId, selectedAgent, sessions } = get()
      if (!selectedTargetId || !selectedThreadId) {
        set({ notice: '当前没有运行中的 turn' })
        return
      }
      const session = sessions[sessionKey(selectedTargetId, selectedAgent)]
      if (!session) return
      const view = session.state.threads[selectedThreadId]
      const turnId = view?.activeTurnId ?? session.lastTurnId
      if (!turnId) {
        set({ notice: '当前没有运行中的 turn' })
        return
      }
      try {
        await interruptTurn(session.rpc, selectedThreadId, turnId)
        set({ notice: '已请求中断当前 turn' })
      } catch (err) {
        set({ error: friendlyError(err, '中断失败') })
      }
    },

    respondApproval: (requestId, decision) => {
      const targetId = get().selectedTargetId
      if (!targetId) return
      // 先找当前 Agent，再找同目标的其他 Agent；只响应用户点过的这一条。
      const preferred = sessionKey(targetId, get().selectedAgent)
      const candidates = Object.values(get().sessions)
        .filter((session) => session.targetId === targetId)
        .sort((a, b) => (a.key === preferred ? -1 : b.key === preferred ? 1 : 0))
      for (const session of candidates) {
        const approval = Object.values(session.state.threads)
          .flatMap((thread) => thread.pendingApprovals)
          .find((item) => item.requestId === requestId)
        if (!approval) continue
        try {
          session.rpc.respond(approval.requestId, approvalResponse(approval, decision))
          patchSession(session.key, (value) => ({
            ...value,
            state: resolveServerRequest(value.state, approval.requestId),
          }))
          set({ error: null })
        } catch (err) {
          set({ error: friendlyError(err, '提交审批失败') })
        }
        return
      }
      set({ error: '该审批请求已失效' })
    },

    loadModels: async (targetId, agent, force = false) => {
      const key = sessionKey(targetId, agent)
      const current = get().models[key]
      const staleEmpty =
        current !== undefined &&
        current.models.length === 0 &&
        Date.now() - (current.loadedAt ?? 0) > EMPTY_MODELS_RETRY_MS
      if (current?.loading || (current && !current.error && !force && !staleEmpty)) return
      const session = get().sessions[key]
      if (!session?.opened) return
      set((state) => ({
        models: { ...state.models, [key]: { models: current?.models ?? [], loading: true, error: null } },
      }))
      try {
        const models = toModelOptions(await listModels(session.rpc))
        set((state) => ({
          models: { ...state.models, [key]: { models, loading: false, error: null, loadedAt: Date.now() } },
        }))
      } catch (err) {
        // 不支持 model/list 的 Agent 视为没有可选模型，界面不显示选择器。
        set((state) => ({
          models: {
            ...state.models,
            [key]: { models: current?.models ?? [], loading: false, error: friendlyError(err, '加载模型列表失败'), loadedAt: Date.now() },
          },
        }))
      }
    },

    setModelPrefs: (targetId, agent, prefs) => {
      const next = { ...get().modelPrefs, [sessionKey(targetId, agent)]: prefs }
      set({ modelPrefs: next })
      persistModelPrefs(next)
    },

    refreshRateLimits: async (targetId) => {
      const busy = rateRefresh.get(targetId)
      if (busy) return busy
      const session = get().sessions[sessionKey(targetId, 'codex')]
      if (!session?.opened) return
      patchRate(targetId, { loading: true })
      const task = (async () => {
        try {
          // 账号读取失败不应挡住额度显示，两个请求彼此独立。
          const [limits, account] = await Promise.allSettled([
            session.rpc.request('account/rateLimits/read', {}),
            session.rpc.request('account/read', {}),
          ])
          const snapshot = limits.status === 'fulfilled' ? pickSnapshot(limits.value) : null
          const accountInfo = account.status === 'fulfilled' ? pickAccount(account.value) : null
          const changes: Partial<RateLimitEntry> = {
            loading: false,
            error: limits.status === 'rejected' ? friendlyError(limits.reason, '读取额度失败') : null,
          }
          if (snapshot) changes.snapshot = snapshot
          if (accountInfo) changes.account = accountInfo
          if (snapshot || accountInfo) changes.updatedAt = Date.now()
          patchRate(targetId, changes)
        } catch (err) {
          patchRate(targetId, { loading: false, error: friendlyError(err, '读取额度失败') })
        } finally {
          rateRefresh.delete(targetId)
        }
      })()
      rateRefresh.set(targetId, task)
      return task
    },

    openFile: async (location) => {
      const targetId = get().selectedTargetId
      if (!targetId || !location.path) return
      const token = ++viewerToken
      set({
        viewer: {
          mode: 'file',
          targetId,
          path: location.path,
          cwd: currentCwd(get()),
          line: location.line ?? null,
          loading: true,
          loadingMore: false,
          error: null,
          file: null,
          diff: null,
          diffSource: null,
          diffTruncated: false,
          notice: null,
        },
      })
      try {
        // 图片直接按 base64 读（server 上限 10 MiB），其他文件按块读文本。
        const params = isImagePath(location.path)
          ? { path: location.path, encoding: 'base64' }
          : { path: location.path, length: READ_CHUNK_BYTES }
        const result = parseFsRead(await serverReq<unknown>(targetId, 'fs.read', params), location.path)
        if (!result) throw new Error('电脑返回的文件内容格式不正确')
        patchViewer(token, { loading: false, file: result })
      } catch (err) {
        patchViewer(token, { loading: false, error: viewerError(err, '读取文件失败') })
      }
    },

    loadMoreFile: async () => {
      const viewer = get().viewer
      const file = viewer?.file
      if (!viewer || viewer.mode !== 'file' || !file || !file.truncated || viewer.loadingMore) return
      const token = viewerToken
      patchViewer(token, { loadingMore: true, error: null })
      try {
        const raw = await serverReq<unknown>(viewer.targetId, 'fs.read', {
          path: viewer.path,
          offset: nextOffset(file),
          length: READ_CHUNK_BYTES,
        })
        const next = parseFsRead(raw, viewer.path)
        if (!next) throw new Error('电脑返回的文件内容格式不正确')
        const current = token === viewerToken ? get().viewer?.file : null
        patchViewer(token, { loadingMore: false, file: current ? appendRead(current, next) : next })
      } catch (err) {
        patchViewer(token, { loadingMore: false, error: viewerError(err, '加载更多失败') })
      }
    },

    openDiff: async (request) => {
      const targetId = get().selectedTargetId
      if (!targetId || !request.path) return
      const cwd = currentCwd(get())
      const fallback = typeof request.diff === 'string' && request.diff.trim() ? request.diff : null
      const token = ++viewerToken
      set({
        viewer: {
          mode: 'diff',
          targetId,
          path: request.path,
          cwd,
          line: null,
          loading: true,
          loadingMore: false,
          error: null,
          file: null,
          diff: null,
          diffSource: null,
          diffTruncated: false,
          notice: null,
        },
      })
      const useFallback = (notice: string | null, error: string | null) =>
        patchViewer(token, fallback
          ? { loading: false, diff: fallback, diffSource: 'card', notice }
          : { loading: false, error })
      if (!cwd) {
        useFallback('没有项目目录，显示改动卡片自带的差异', '没有项目目录，无法读取 Git 差异')
        return
      }
      try {
        const raw = await serverReq<unknown>(targetId, 'git.diff', { cwd, path: request.path })
        const diff = isRecord(raw) && typeof raw.diff === 'string' ? raw.diff : ''
        if (diff.trim()) {
          patchViewer(token, {
            loading: false,
            diff,
            diffSource: 'git',
            diffTruncated: isRecord(raw) && raw.truncated === true,
          })
        } else {
          // 已提交或已被还原的改动在工作区里没有差异，回退到 Agent 当时给出的 diff。
          useFallback('Git 工作区中没有该文件的未提交差异，显示改动卡片自带的差异', 'Git 工作区中没有该文件的未提交差异')
        }
      } catch (err) {
        const message = viewerError(err, '读取 Git 差异失败')
        useFallback(`${message}，显示改动卡片自带的差异`, message)
      }
    },

    closeViewer: () => {
      viewerToken += 1
      set({ viewer: null })
    },

    addAnnotation: (quote, comment = '') => {
      const value = quote.trim()
      if (!value) return
      set((state) => ({
        annotations: [...state.annotations, { id: makeId(), quote: value, comment }],
      }))
    },

    updateAnnotation: (id, comment) => {
      set((state) => ({
        annotations: state.annotations.map((item) => (item.id === id ? { ...item, comment } : item)),
      }))
    },

    removeAnnotation: (id) => {
      set((state) => ({ annotations: state.annotations.filter((item) => item.id !== id) }))
    },

    handleGatewayEvent: (event) => {
      if (isHeartbeat(event)) return
      switch (event.name) {
        case 'target.state': {
          const payload = event.payload
          set((state) => ({ targetStates: applyTargetState(state.targetStates, payload) }))
          const record = isRecord(payload) ? payload : null
          const id = typeof record?.id === 'string' ? record.id : ''
          if (!id) return
          if (record?.state !== 'ready') {
            // 链路断过之后 agent 进程可能已经换了，下次操作必须重新 codex.open。
            for (const session of Object.values(get().sessions)) {
              if (session.targetId === id && session.opened) {
                patchSession(session.key, (value) => ({ ...value, opened: false }))
              }
            }
          }
          if (record?.state === 'error') {
            const detail = typeof record.detail === 'string' ? record.detail : '连接失败'
            const message = hostKeyMessage({ message: detail }, '连接失败')
            set((state) => ({
              targetErrors: { ...state.targetErrors, [id]: message },
              notice: isHostKeyError({ message: detail }) ? HOST_KEY_HINT : state.notice,
            }))
          } else if (record?.state === 'ready') {
            set((state) => {
              const errors = { ...state.targetErrors }
              delete errors[id]
              return { targetErrors: errors }
            })
            const state = get()
            if (state.selectedTargetId === id && state.selectedProjectId) {
              void get().refreshThreads()
            }
          }
          return
        }
        case 'codex.recv': {
          const key = recvSessionKey(event.payload)
          if (key) get().sessions[key]?.transport.handleRecv(event.payload)
          return
        }
        case 'server.evt': {
          const payload = isRecord(event.payload) ? event.payload : null
          const targetId = typeof payload?.targetId === 'string' ? payload.targetId : ''
          if (payload?.name === 'codex.exited' && targetId) {
            const agent = exitedAgent(payload)
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== targetId || (agent !== null && session.agent !== agent)) continue
              patchSession(session.key, (value) => ({
                ...value,
                opened: false,
                openError: `${agentLabel(value.agent)} 进程已退出，下次操作将重新启动`,
              }))
            }
            if (agent === null || agent === 'codex') patchRate(targetId, emptyRateLimit())
          }
          return
        }
        case 'hostKey.prompt': {
          set({ notice: HOST_KEY_HINT })
          return
        }
        case 'mobile.notice': {
          // 网关把 hostKey.prompt 转成不含 promptId 的提示，手机端只能引导用户在电脑上确认。
          const payload = isRecord(event.payload) ? event.payload : null
          const message =
            (typeof payload?.message === 'string' ? payload.message : null) ??
            (payload?.kind === 'hostKey' ? HOST_KEY_HINT : null)
          if (message) set({ notice: message })
          return
        }
        default:
          return
      }
    },

    goBack: () => {
      if (get().viewer) {
        get().closeViewer()
        return true
      }
      const page = get().page
      if (page === 'form') {
        get().closeForm()
        return true
      }
      if (page === 'chat') {
        set({ page: 'threads', selectedThreadId: null, annotations: [] })
        return true
      }
      if (page === 'threads') {
        set({ page: 'projects', selectedProjectId: null, selectedThreadId: null })
        return true
      }
      if (page === 'projects') {
        set({ page: 'targets', selectedTargetId: null, directory: null })
        return true
      }
      if (page === 'targets') {
        get().deactivate()
        void get().refreshStatuses()
        return true
      }
      return false
    },

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  }
})
