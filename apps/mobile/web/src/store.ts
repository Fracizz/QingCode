// 手机端全局状态：连接、目标、项目、会话、对话、额度与事件流。IO 全部经 Gateway 注入。
import {
  applyNotification,
  applyRateLimitsUpdate,
  applyServerRequest,
  approvalResponse,
  CodexRpc,
  emptyState,
  interruptTurn,
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
import { getGateway, isMockGateway } from './client'
import {
  draftFromInfo,
  isValidHost,
  isValidPairingCode,
  normalizeFingerprint,
  parseAddress,
  parsePairingLink,
  parsePort,
} from './link'
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

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STORAGE_CONNECTIONS = 'connections'
const STORAGE_ACTIVE = 'active'
const REFRESH_INTERVAL_MS = 60_000
const DEVICE_NAME = 'QingCode Next 手机'
const FINGERPRINT_MISMATCH_HINT =
  '地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息'

export type Page = 'connections' | 'form' | 'targets' | 'projects' | 'threads' | 'chat'

export type FormState = {
  mode: 'add' | 'edit'
  editId: string | null
  draft: ConnectionDraft
  paste: string
  error: string | null
  testing: boolean
  pairing: boolean
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

export type TargetSession = {
  rpc: CodexRpc
  transport: MobileCodexTransport
  state: ConversationState
  opened: boolean
  opening: boolean
  openError: string | null
  lastSeq: number | null
  lastTurnId: string | null
}

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
  threads: ThreadSummary[]
  threadsLoading: boolean
  threadsError: string | null
  selectedThreadId: string | null
  sessions: Record<string, TargetSession>
  rateLimits: Record<string, RateLimitEntry>
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
  updateDraft: (field: keyof ConnectionDraft, value: string) => void
  testConnection: () => Promise<void>
  pairAndSave: () => Promise<void>
  saveEdit: () => Promise<void>
  closeForm: () => void
  removeConnection: (id: string) => Promise<void>
  activate: (id: string) => Promise<void>
  deactivate: () => void
  loadTargets: () => Promise<void>
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
  ensureOpen: (targetId: string) => Promise<boolean>
  attachOpened: () => Promise<void>
  refreshThreads: () => Promise<void>
  newThread: () => Promise<void>
  openThread: (id: string) => Promise<void>
  send: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  respondApproval: (requestId: RequestId, decision: ApprovalDecision) => void
  refreshRateLimits: (targetId: string) => Promise<void>
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

const emptyForm = (mode: 'add' | 'edit', editId: string | null, draft: ConnectionDraft): FormState => ({
  mode,
  editId,
  draft,
  paste: '',
  error: null,
  testing: false,
  pairing: false,
  probe: null,
  fpMismatch: null,
})

const activeConnection = (state: AppState): Connection | null =>
  state.connections.find((item) => item.id === state.activeId) ?? null

let initialized = false
let controller: EventStreamController | null = null
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

  const patchSession = (
    targetId: string,
    update: (session: TargetSession) => TargetSession,
  ): void => {
    set((state) => {
      const session = state.sessions[targetId]
      if (!session) return state
      const next = update(session)
      return next === session ? state : { sessions: { ...state.sessions, [targetId]: next } }
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

  const resetSessions = (): void => {
    for (const session of Object.values(get().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
    opening.clear()
    rateRefresh.clear()
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

  const sessionFor = (targetId: string): TargetSession => {
    const existing = get().sessions[targetId]
    if (existing) return existing

    const transport = new MobileCodexTransport(
      targetId,
      (msg) => {
        const conn = activeConnection(get())
        if (!conn) return Promise.reject(new Error('尚未选择电脑'))
        return getGateway().rpc(conn, 'codex.send', { targetId, msg })
      },
      'codex' as AgentKind,
    )
    const rpc = new CodexRpc(transport, { timeoutMs: 30_000 })
    const session: TargetSession = {
      rpc,
      transport,
      state: emptyState(),
      opened: false,
      opening: false,
      openError: null,
      lastSeq: null,
      lastTurnId: null,
    }
    set((state) => ({ sessions: { ...state.sessions, [targetId]: session } }))

    rpc.onNotification((notification: ServerNotification) => {
      patchSession(targetId, (current) => ({
        ...current,
        state: applyNotification(current.state, notification),
      }))
      handleRateLimitNotification(targetId, notification)
      const method = (notification as unknown as JsonRecord).method
      if (method === 'turn/completed' || method === 'thread/started') {
        if (get().selectedTargetId === targetId) void get().refreshThreads()
      }
    })
    rpc.onServerRequest((request: ServerRequest) => {
      patchSession(targetId, (current) => ({
        ...current,
        state: applyServerRequest(current.state, request),
      }))
    })
    return session
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
    threads: [],
    threadsLoading: false,
    threadsError: null,
    selectedThreadId: null,
    sessions: {},
    rateLimits: {},
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
          const [raw, active] = await Promise.all([
            gateway.storageGet(STORAGE_CONNECTIONS),
            gateway.storageGet(STORAGE_ACTIVE),
          ])
          const connections = parseConnections(raw)
          const activeId = active && connections.some((item) => item.id === active) ? active : null
          set({ connections, activeId, booting: false })
          if (activeId) await get().activate(activeId)
          else void get().refreshStatuses()
        } catch (err) {
          set({ booting: false, error: friendlyError(err, '读取本地连接失败') })
        }
      })()
      setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        for (const [targetId, session] of Object.entries(get().sessions)) {
          if (session.opened) void get().refreshRateLimits(targetId)
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
        form: emptyForm('add', null, { name: '', host: '', port: 38500, fp: '', code: '' }),
        error: null,
      })
    },

    openEditForm: (id) => {
      const conn = get().connections.find((item) => item.id === id)
      if (!conn) return
      set({
        page: 'form',
        form: emptyForm('edit', id, {
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
      if (!form) return
      set({ form: { ...form, paste: text } })
    },

    parsePaste: () => {
      const form = get().form
      if (!form) return
      const info = parsePairingLink(form.paste)
      if (!info) {
        set({ form: { ...form, error: '未找到有效的连接信息，请粘贴包含 qingcode-next://pair? 的文本' } })
        return
      }
      const draft = draftFromInfo(info)
      set({
        form: {
          ...form,
          // 编辑已有连接时指纹与 token 不变，只导入可编辑的地址信息。
          draft: form.mode === 'edit' ? { ...form.draft, name: draft.name, host: draft.host, port: draft.port } : draft,
          error: null,
          probe: null,
          fpMismatch: null,
        },
      })
    },

    pasteFromClipboard: async () => {
      try {
        const text = await getGateway().readClipboard()
        const form = get().form
        if (!form) return
        set({ form: { ...form, paste: text, error: null } })
        get().parsePaste()
      } catch (err) {
        const form = get().form
        if (form) set({ form: { ...form, error: friendlyError(err, '读取剪贴板失败') } })
      }
    },

    updateDraft: (field, value) => {
      const form = get().form
      if (!form) return
      const draft: ConnectionDraft = { ...form.draft, [field]: field === 'port' ? parsePort(value) ?? 0 : value }
      set({ form: { ...form, draft, error: null, probe: null, fpMismatch: null } })
    },

    testConnection: async () => {
      const form = get().form
      if (!form) return
      const { host, port, fp } = form.draft
      if (!isValidHost(host) || parsePort(port) === null || !normalizeFingerprint(fp)) {
        set({ form: { ...form, error: '请先填写有效的主机、端口与 64 位证书指纹' } })
        return
      }
      set({ form: { ...form, testing: true, error: null, fpMismatch: null, probe: null } })
      try {
        const result = await getGateway().probe(host.trim(), port)
        const actual = normalizeFingerprint(result.fingerprint)
        const current = get().form
        if (!current) return
        if (actual === null) {
          set({ form: { ...current, testing: false, error: '电脑未返回有效的证书指纹' } })
        } else if (actual !== normalizeFingerprint(fp)) {
          set({ form: { ...current, testing: false, fpMismatch: FINGERPRINT_MISMATCH_HINT } })
        } else {
          set({ form: { ...current, testing: false, probe: result, error: null } })
        }
      } catch (err) {
        const current = get().form
        if (current) {
          set({ form: { ...current, testing: false, error: friendlyError(err, '测试连接失败，请检查地址与电脑是否在线') } })
        }
      }
    },

    pairAndSave: async () => {
      const form = get().form
      if (!form || form.mode !== 'add') return
      const { draft } = form
      if (!isValidHost(draft.host) || parsePort(draft.port) === null || !normalizeFingerprint(draft.fp)) {
        set({ form: { ...form, error: '连接信息不完整，请重新粘贴或填写' } })
        return
      }
      if (!isValidPairingCode(draft.code)) {
        set({ form: { ...form, error: '配对密码需为 6–20 位且不含空白字符' } })
        return
      }
      if (form.fpMismatch) {
        set({ form: { ...form, error: FINGERPRINT_MISMATCH_HINT } })
        return
      }
      set({ form: { ...form, pairing: true, error: null } })
      try {
        const result = await getGateway().pair(
          draft,
          get().mock ? '浏览器调试' : DEVICE_NAME,
        )
        const conn: Connection = {
          id: makeId(),
          name: draft.name.trim() || '未命名电脑',
          host: draft.host.trim(),
          port: draft.port,
          fp: normalizeFingerprint(draft.fp) ?? draft.fp,
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
          set({ form: { ...current, pairing: false, error: friendlyError(err, '配对失败') } })
        }
      }
    },

    saveEdit: async () => {
      const form = get().form
      if (!form || form.mode !== 'edit' || !form.editId) return
      const { name, host, port } = form.draft
      if (!isValidHost(host) || parsePort(port) === null) {
        set({ form: { ...form, error: '主机或端口格式不正确' } })
        return
      }
      const previous = get().connections.find((item) => item.id === form.editId)
      if (!previous) return
      const updated: Connection = { ...previous, name: name.trim() || previous.name, host: host.trim(), port }
      const connections = get().connections.map((item) => (item.id === form.editId ? updated : item))
      const wasActive = get().activeId === form.editId
      set({ connections, form: null, page: wasActive ? 'targets' : 'connections' })
      await persist(connections, get().activeId)
      if (wasActive) {
        controller?.stop()
        controller?.start()
        await get().loadTargets()
      }
      void get().refreshStatuses()
    },

    closeForm: () => set({ form: null, page: 'connections' }),

    removeConnection: async (id) => {
      const wasActive = get().activeId === id
      const connections = get().connections.filter((item) => item.id !== id)
      const activeId = wasActive ? null : get().activeId
      if (wasActive) {
        controller?.stop()
        resetSessions()
        set({
          sessions: {},
          rateLimits: {},
          targets: [],
          projects: [],
          threads: [],
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
        error: null,
        notice: null,
      })
      void persist(get().connections, id)
      controller?.stop()
      controller?.start()
      await get().loadTargets()
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
        page: 'projects',
      })
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
      set({ selectedProjectId: id, selectedThreadId: null, threads: [], threadsError: null, page: 'threads' })
      if (!(await get().ensureOpen(project.targetId))) {
        set({ threadsError: get().sessions[project.targetId]?.openError ?? 'Codex 未就绪' })
        return
      }
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
          page: 'threads',
        }))
        if (await get().ensureOpen(targetId)) await get().refreshThreads()
      } catch (err) {
        const current = get().directory
        if (current) set({ directory: { ...current, saving: false, error: friendlyError(err, '添加项目失败') } })
      }
    },

    ensureOpen: async (targetId) => {
      const existing = get().sessions[targetId]
      if (existing?.opened) return true
      const busy = opening.get(targetId)
      if (busy) return busy
      const conn = activeConnection(get())
      if (!conn) {
        set({ error: '尚未选择电脑' })
        return false
      }
      const session = sessionFor(targetId)
      patchSession(targetId, (value) => ({ ...value, opening: true, openError: null }))
      const task = (async () => {
        try {
          const opened = await getGateway().rpc<unknown>(conn, 'server.req', {
            targetId,
            method: 'codex.open',
            params: {},
          })
          let lastSeq = maxSeq(openSeq(opened), session.transport.getLastSeq())
          try {
            const attached = await getGateway().rpc<unknown>(conn, 'server.req', {
              targetId,
              method: 'codex.attach',
              params: { sinceSeq: lastSeq ?? 0 },
            })
            const info = attachResult(attached)
            lastSeq = maxSeq(lastSeq, info.lastSeq)
            if (info.truncated) set({ notice: '服务端历史缓冲已裁剪，请重新打开会话加载完整记录' })
          } catch {
            // 旧版 daemon 没有 attach 时仍能正常对话。
          }
          session.transport.setLastSeq(lastSeq)
          patchSession(targetId, (value) => ({
            ...value,
            opened: true,
            opening: false,
            openError: null,
            lastSeq,
          }))
          void get().refreshRateLimits(targetId)
          return true
        } catch (err) {
          patchSession(targetId, (value) => ({
            ...value,
            opened: false,
            opening: false,
            openError: friendlyError(err, 'Codex 未就绪，请确认目标已连接'),
          }))
          return false
        } finally {
          opening.delete(targetId)
          patchSession(targetId, (value) => ({ ...value, opening: false }))
        }
      })()
      opening.set(targetId, task)
      return task
    },

    attachOpened: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      for (const [targetId, session] of Object.entries(get().sessions)) {
        if (!session.opened) continue
        try {
          const result = await getGateway().rpc<unknown>(conn, 'server.req', {
            targetId,
            method: 'codex.attach',
            params: { sinceSeq: session.transport.getLastSeq() ?? 0 },
          })
          const info = attachResult(result)
          session.transport.setLastSeq(info.lastSeq)
          patchSession(targetId, (value) => ({ ...value, lastSeq: maxSeq(value.lastSeq, info.lastSeq) }))
          if (info.truncated) set({ notice: '事件流重连后有历史消息被裁剪，请重新打开会话' })
        } catch {
          // 下次操作会再尝试，不打断页面。
        }
      }
    },

    refreshThreads: async () => {
      const targetId = get().selectedTargetId
      if (!targetId) {
        set({ threads: [], threadsLoading: false, threadsError: null })
        return
      }
      if (!(await get().ensureOpen(targetId))) {
        set({ threadsLoading: false, threadsError: get().sessions[targetId]?.openError ?? 'Codex 未就绪' })
        return
      }
      const session = get().sessions[targetId]
      if (!session) return
      const cwd = get().projects.find((item) => item.id === get().selectedProjectId)?.path
      set({ threadsLoading: true, threadsError: null })
      try {
        const result = await listThreads(session.rpc, cwd)
        set({ threads: toThreadSummaries(result), threadsLoading: false })
      } catch (err) {
        set({ threadsLoading: false, threadsError: friendlyError(err, '加载会话列表失败') })
      }
    },

    newThread: async () => {
      const targetId = get().selectedTargetId
      if (!targetId) return
      if (!(await get().ensureOpen(targetId))) {
        set({ error: get().sessions[targetId]?.openError ?? 'Codex 未就绪' })
        return
      }
      const session = get().sessions[targetId]
      if (!session) return
      const cwd = get().projects.find((item) => item.id === get().selectedProjectId)?.path
      try {
        const result = await startThread(session.rpc, cwd ? { cwd } : {})
        patchSession(targetId, (value) => ({ ...value, state: loadThread(value.state, result.thread) }))
        set({ selectedThreadId: result.thread.id, page: 'chat', error: null })
        void get().refreshThreads()
      } catch (err) {
        set({ error: friendlyError(err, '新建会话失败') })
      }
    },

    openThread: async (id) => {
      const targetId = get().selectedTargetId
      if (!targetId) return
      if (!(await get().ensureOpen(targetId))) {
        set({ error: get().sessions[targetId]?.openError ?? 'Codex 未就绪' })
        return
      }
      const session = get().sessions[targetId]
      if (!session) return
      try {
        let result: { thread: Parameters<typeof loadThread>[1] }
        try {
          result = await resumeThread(session.rpc, id)
        } catch {
          result = await readThread(session.rpc, id)
        }
        patchSession(targetId, (value) => ({ ...value, state: loadThread(value.state, result.thread) }))
        set({ selectedThreadId: id, page: 'chat', error: null })
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
      if (!(await get().ensureOpen(targetId))) {
        set({ error: get().sessions[targetId]?.openError ?? 'Codex 未就绪' })
        return
      }
      const session = get().sessions[targetId]
      if (!session) return
      set({ sending: true, error: null })
      try {
        let threadId = get().selectedThreadId
        if (!threadId) {
          const cwd = get().projects.find((item) => item.id === get().selectedProjectId)?.path
          const created = await startThread(session.rpc, cwd ? { cwd } : {})
          patchSession(targetId, (value) => ({ ...value, state: loadThread(value.state, created.thread) }))
          threadId = created.thread.id
          set({ selectedThreadId: threadId })
          void get().refreshThreads()
        }
        const started = await sendText(session.rpc, threadId, finalText)
        // turn/started 通知可能晚于响应，先按返回值把状态置为运行中，保证中断按钮可用。
        const synthetic = {
          method: 'turn/started',
          params: { threadId, turnId: started.turn.id, turn: started.turn },
        } as unknown as ServerNotification
        patchSession(targetId, (value) => ({
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
      const { selectedTargetId, selectedThreadId, sessions } = get()
      if (!selectedTargetId || !selectedThreadId) {
        set({ notice: '当前没有运行中的 turn' })
        return
      }
      const session = sessions[selectedTargetId]
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
      const session = get().sessions[targetId]
      if (!session) return
      const approval = Object.values(session.state.threads)
        .flatMap((thread) => thread.pendingApprovals)
        .find((item) => item.requestId === requestId)
      if (!approval) {
        set({ error: '该审批请求已失效' })
        return
      }
      try {
        session.rpc.respond(approval.requestId, approvalResponse(approval, decision))
        patchSession(targetId, (value) => ({
          ...value,
          state: resolveServerRequest(value.state, approval.requestId),
        }))
        set({ error: null })
      } catch (err) {
        set({ error: friendlyError(err, '提交审批失败') })
      }
    },

    refreshRateLimits: async (targetId) => {
      const busy = rateRefresh.get(targetId)
      if (busy) return busy
      const session = get().sessions[targetId]
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
            const session = state.sessions[id]
            if (
              state.selectedTargetId === id &&
              state.selectedProjectId &&
              session &&
              !session.opened &&
              !session.opening
            ) {
              void get().ensureOpen(id).then(() => void get().refreshThreads())
            }
          }
          return
        }
        case 'codex.recv': {
          for (const session of Object.values(get().sessions)) session.transport.handleRecv(event.payload)
          return
        }
        case 'server.evt': {
          const payload = isRecord(event.payload) ? event.payload : null
          const targetId = typeof payload?.targetId === 'string' ? payload.targetId : ''
          if (payload?.name === 'codex.exited' && targetId) {
            patchSession(targetId, (session) => ({
              ...session,
              opened: false,
              openError: 'Codex 进程已退出，下次操作将重新启动',
            }))
            patchRate(targetId, emptyRateLimit())
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


