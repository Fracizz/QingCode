// 手机端全局状态：连接、目标、项目、会话（按目标 + Agent）、对话、模型、文件查看、额度与事件流。IO 全部经 Gateway 注入。
import {
  applyNotification,
  applyRateLimitsUpdate,
  applyServerRequest,
  archiveThread,
  CodexRpc,
  emptyState,
  failActiveThreads,
  interruptTurn,
  isOversizeHistoryResponse,
  isThreadOutcome,
  listModels,
  listThreads,
  loadThread,
  pickAccount,
  pickSnapshot,
  readThread,
  resolveServerRequest,
  resumeThread,
  sendInput,
  startThread,
  steerTurn,
  type AccountSummary,
  type ConversationState,
  type RateLimitSnapshot,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
  type Thread,
  type TurnOverrides,
  type UserInput,
} from '@qn/codex-client'
import { create } from 'zustand'
import {
  agentLabel,
  archivedThreadKey,
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
import { isImagePath, normalizePath, pathStyle, type FileLocation } from './fileLinks'
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
  resolveSelection,
  toModelOptions,
  type ModelList,
  type ModelPrefs,
} from './models'
import { NativeRequestError } from './native'
import {
  applyTargetState,
  availableApprovalDecisions,
  connectionRepairReason,
  draftKey,
  errorCode,
  formatQuotedMessage,
  agentOpenErrorText,
  friendlyError,
  HOST_KEY_HINT,
  hostKeyMessage,
  isHostKeyError,
  makeId,
  mobileApprovalReply,
  parentPath,
  parseConnections,
  parseDrafts,
  parseProjects,
  parseSavedChats,
  parseStoredRecord,
  parseTargets,
  serializeConnections,
  toThreadSummaries,
  type Annotation,
  type ChatDraft,
  type MobileApprovalDecision,
  type RepairReason,
  type SavedChat,
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
import { mobileTurnFits, queuedInput, QUEUE_STORAGE_KEY, restoreQueues, serializeQueues, UNCONFIRMED_QUEUED_SEND, type QueuedSend } from './queuedSends'
import { deliverTerminalEvent } from './terminalEvents'
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

declare global {
  interface Window {
    __qnResume?: () => void
  }
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STORAGE_CONNECTIONS = 'connections'
const STORAGE_ACTIVE = 'active'
const STORAGE_MODEL_PREFS = 'modelPrefs'
const STORAGE_DESKTOP_MODEL_PREFS = 'desktopModelPrefs'
const STORAGE_DRAFTS = 'chatDrafts'
const STORAGE_SAVED_CHATS = 'savedChats'
const STORAGE_ARCHIVED_THREADS = 'archivedThreads'
const REFRESH_INTERVAL_MS = 60_000
// pi 等 Agent 在会话进程启动前返回空模型列表，空列表隔一段时间允许重取。
const EMPTY_MODELS_RETRY_MS = 15_000
const DEVICE_NAME = 'QingCode Next 手机'
const FINGERPRINT_MISMATCH_HINT =
  '地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息'

export type Page = 'connections' | 'form' | 'workspace' | 'targets' | 'projects' | 'threads' | 'chat'

export type FormState = {
  mode: 'add' | 'edit' | 'repair'
  editId: string | null
  returnPage: Exclude<Page, 'form'>
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
  resumedCodexThreads: Set<string>
  loadedThreads: Set<string>
  state: ConversationState
  opened: boolean
  opening: boolean
  openError: string | null
  openErrorCode?: string
  lastSeq: number | null
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
export type SendMode = 'queue' | 'steer' | 'immediate'
export type QueuedThreadMode = 'start' | 'continue'

type SendAddress = { desktopId: string; targetId: string; agent: AgentKind; threadId: string }

type DiscoveredThread = ThreadSummary & { targetId: string; projectId: string }

type WorkspaceProject = {
  project: Project
  projects: Project[]
  threads: ThreadSummary[]
}

type AppState = {
  page: Page
  targetsReturnPage: 'connections' | 'workspace'
  projectsReturnPage: 'targets' | 'workspace'
  chatReturnPage: 'workspace' | 'threads'
  threadsReturnPage: 'workspace' | 'projects'
  booting: boolean
  mock: boolean
  connections: Connection[]
  activeId: string | null
  connectionStatus: Record<string, ConnectionStatus>
  connectionLatencyMs: Record<string, number | null>
  needsRepair: Record<string, RepairReason>
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
  archivedThreads: Record<string, true>
  threadsLoading: boolean
  threadsError: string | null
  /** 单个 Agent 打开或列会话失败的提示，不影响其他 Agent。 */
  agentErrors: Partial<Record<AgentKind, string>>
  selectedThreadId: string | null
  openingThread: SendAddress | null
  /** 当前对话（或待建会话）所属 Agent。 */
  selectedAgent: AgentKind
  sessions: Record<string, AgentSession>
  models: Record<string, ModelList>
  modelPrefs: Record<string, ModelPrefs>
  rateLimits: Record<string, RateLimitEntry>
  claudeRateLimits: Record<string, RateLimitSnapshot>
  claudeCosts: Record<string, number>
  viewer: ViewerState | null
  annotations: Annotation[]
  draftText: string
  approvalSubmitting: Record<string, boolean>
  sending: boolean
  compactingThreads: Record<string, true>
  queuedSends: Record<string, QueuedSend[]>
  error: string | null
  notice: string | null

  init: () => () => void
  refreshStatuses: () => Promise<void>
  openAddForm: () => void
  openEditForm: (id: string) => void
  beginRepair: (id: string) => void
  setFormPaste: (text: string) => void
  parsePaste: () => void
  pasteFromClipboard: () => Promise<void>
  updateDraft: (field: Exclude<keyof ConnectionDraft, 'fp'>, value: string) => void
  testConnection: () => Promise<void>
  pairAndSave: () => Promise<void>
  saveEdit: () => Promise<void>
  closeForm: () => void
  removeConnection: (id: string) => Promise<void>
  activate: (id: string, page?: 'workspace' | 'targets') => Promise<void>
  deactivate: () => void
  loadTargets: () => Promise<void>
  loadAgentSettings: () => Promise<void>
  requestConnect: (id: string) => void
  submitCredentials: (password: string, remember: boolean) => Promise<void>
  cancelCredentials: () => void
  connect: (id: string, credentials: Credentials) => Promise<void>
  disconnectTarget: (id: string) => Promise<void>
  selectTarget: (id: string) => Promise<void>
  selectProject: (id: string, workspace?: WorkspaceProject) => Promise<void>
  cancelPendingNavigation: () => void
  openDirectory: () => Promise<void>
  browseDirectory: (path: string) => Promise<void>
  closeDirectory: () => void
  chooseDirectory: () => Promise<void>
  ensureOpen: (targetId: string, agent?: AgentKind) => Promise<boolean>
  attachOpened: () => Promise<void>
  /** skipFailed：后台刷新（如 turn 完成后）不重试已确认打不开的 Agent，避免反复拉起。 */
  refreshThreads: (options?: { skipFailed?: boolean }) => Promise<void>
  discoverWorkspaceSessions: (projects: readonly Project[]) => Promise<DiscoveredThread[]>
  newThread: (agent?: AgentKind, workspace?: WorkspaceProject) => Promise<boolean>
  openThread: (id: string, agent?: AgentKind, workspace?: WorkspaceProject) => Promise<boolean>
  archiveConversation: (targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>) => Promise<void>
  compactConversation: () => Promise<boolean>
  setDraftText: (text: string) => void
  send: (text: string, attachments?: UserInput[], delegate?: boolean, mode?: SendMode, options?: { keepDraft?: boolean }) => Promise<boolean>
  removeQueuedSend: (id: string) => void
  beginQueuedEdit: (id: string) => ((resume?: boolean) => void) | null
  editQueuedSend: (id: string, text: string) => Promise<boolean>
  steerQueuedSend: (id: string) => Promise<boolean>
  sendQueuedInNewThread: (id: string, mode: QueuedThreadMode) => Promise<boolean>
  retryQueuedSend: () => Promise<void>
  interrupt: () => Promise<void>
  respondApproval: (requestId: RequestId, decision: MobileApprovalDecision) => Promise<boolean>
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
  mode: FormState['mode'], editId: string | null, returnPage: FormState['returnPage'], draft: ConnectionDraft,
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

const sendKey = ({ desktopId, targetId, agent, threadId }: SendAddress): string =>
  JSON.stringify([desktopId, targetId, agent, threadId])

function selectedSendAddress(state: AppState): SendAddress | null {
  const { activeId, selectedTargetId, selectedAgent, selectedThreadId } = state
  return activeId && selectedTargetId && selectedThreadId
    ? { desktopId: activeId, targetId: selectedTargetId, agent: selectedAgent, threadId: selectedThreadId }
    : null
}

export function selectedQueuedSends(state: AppState): QueuedSend[] | undefined {
  const address = selectedSendAddress(state)
  return address ? state.queuedSends[sendKey(address)] : undefined
}

export function selectedCompactionStarting(state: AppState): boolean {
  const address = selectedSendAddress(state)
  return !!address && !!state.compactingThreads[sendKey(address)]
}

export function selectedCompactionBlockedReason(state: AppState): string | null {
  const address = selectedSendAddress(state)
  if (!address || address.agent !== 'codex') return '仅已创建的 Codex 会话支持压缩'
  if (!state.eventsConnected) return '连接电脑后可压缩会话'
  const session = state.sessions[sessionKey(address.targetId, address.agent)]
  const thread = session?.state.threads[address.threadId]
  if (!session?.opened || !thread) return '请先打开会话'
  if (selectedCompactionStarting(state)) return '正在启动压缩…'
  if (thread.status === 'running' || thread.pendingApprovals.length > 0 || state.sending) return '请先等待当前一轮结束'
  if (selectedQueuedSends(state)?.length) return '请先处理排队的消息'
  const quota = state.rateLimits[address.targetId]?.snapshot
  if (quota?.rateLimitReachedType || quota?.spendControlReached) return '当前额度已用完'
  return null
}

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
  agentOpenErrorText(
    agentLabel(agent),
    err,
    agent === 'codex' ? 'Codex 未就绪，请确认目标已连接' : `${agentLabel(agent)} 打开失败，请确认目标机已安装并登录`,
  )

const isTargetDisconnected = (err: unknown): boolean =>
  errorCode(err) === 'not_connected' || (isRecord(err) && errorCode(err.data) === 'not_connected')

let initialized = false
let controller: EventStreamController | null = null
let refreshToken = 0
let viewerToken = 0
const opening = new Map<string, Promise<boolean>>()
const rateRefresh = new Map<string, Promise<void>>()
const OPEN_THREAD_TIMEOUT_MS = 30_000

export const useApp = create<AppState>((set, get) => {
  let desktopEpoch = 0
  let eventStreamEpoch = 0
  let navigationEpoch = 0
  const beginNavigation = (openingThread: SendAddress | null = null): number => {
    const navigation = ++navigationEpoch
    if (get().openingThread !== openingThread) set({ openingThread })
    return navigation
  }
  let drafts: Record<string, ChatDraft> = {}
  let savedChats: Record<string, SavedChat> = {}
  let pendingRestore: SavedChat | null = null
  let restoreTask: Promise<void> | null = null
  let reconnectTask: Promise<void> | null = null
  let desktopModelPrefs: Record<string, Record<string, ModelPrefs>> = {}
  const claudeCostPerTurn = new Map<string, number>()
  const completedTurns = new WeakMap<MobileCodexTransport, Set<string>>()
  const approvalFlights = new WeakMap<MobileCodexTransport, Map<RequestId, string>>()
  const archiveFlights = new Set<string>()
  const connectionProbes = new Map<Connection, Promise<void>>()
  const storageWrites = new Map<string, Promise<void>>()
  const submitting = new Set<string>()
  const replacing = new Set<string>()
  const editingQueue = new Set<string>()
  const savingQueue = new Set<string>()
  const queueingDrafts = new Set<string>()

  const queueStorageWrite = (key: string, write: () => Promise<void>): Promise<void> => {
    const previous = storageWrites.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(write)
    storageWrites.set(key, task)
    void task.catch(() => undefined).finally(() => {
      if (storageWrites.get(key) === task) storageWrites.delete(key)
    })
    return task
  }

  const saveRecord = (key: string, data: unknown): void => {
    const json = JSON.stringify(data)
    void queueStorageWrite(key, () => getGateway().storageSet(key, json))
  }

  const writeArchives = (archivedThreads: AppState['archivedThreads']): Promise<void> =>
    getGateway().storageSet(STORAGE_ARCHIVED_THREADS, JSON.stringify(archivedThreads))

  const persistArchives = (): void => {
    void queueStorageWrite(STORAGE_ARCHIVED_THREADS, () => writeArchives(get().archivedThreads))
  }

  const currentDraftKey = (state = get()): string | null => {
    const { activeId, selectedTargetId, selectedProjectId, selectedAgent, selectedThreadId, page } = state
    const conn = activeConnection(state)
    return conn && activeId && selectedTargetId && page === 'chat'
      ? draftKey(activeId, selectedTargetId, selectedProjectId, selectedAgent, selectedThreadId, conn.fp)
      : null
  }

  const showDraft = (): void => {
    const state = get()
    const key = currentDraftKey(state)
    const value = key ? drafts[key] : undefined
    const session = state.selectedTargetId && state.sessions[sessionKey(state.selectedTargetId, state.selectedAgent)]
    const flights = session ? approvalFlights.get(session.transport) : undefined
    const approvalSubmitting = Object.fromEntries([...(flights ?? [])]
      .filter(([, threadId]) => threadId === state.selectedThreadId)
      .map(([requestId]) => [String(requestId), true]))
    set({ draftText: value?.text ?? '', annotations: value?.annotations ?? [], approvalSubmitting })
  }

  const saveDraft = (key: string, draft: ChatDraft): void => {
    if (draft.text || draft.annotations.length) drafts[key] = draft
    else delete drafts[key]
    saveRecord(STORAGE_DRAFTS, drafts)
    if (currentDraftKey() === key) set({ draftText: draft.text, annotations: draft.annotations })
  }

  const saveActiveChat = (): void => {
    const { activeId, selectedTargetId, selectedProjectId, selectedThreadId, selectedAgent } = get()
    if (!activeId) return
    if (selectedTargetId && selectedProjectId && selectedThreadId) {
      savedChats[activeId] = { targetId: selectedTargetId, projectId: selectedProjectId, threadId: selectedThreadId, agent: selectedAgent }
    } else {
      delete savedChats[activeId]
    }
    saveRecord(STORAGE_SAVED_CHATS, savedChats)
  }

  const chatReturnPage = (source: AppState): AppState['chatReturnPage'] => {
    if (source.page === 'chat') return source.chatReturnPage
    return source.page === 'workspace' ? 'workspace' : 'threads'
  }

  const leaveChat = (threads = get().threads): void => {
    const page = get().chatReturnPage
    beginNavigation()
    viewerToken += 1
    set({
      page,
      ...(page === 'workspace' ? { selectedTargetId: null, selectedProjectId: null } : {}),
      selectedThreadId: null,
      viewer: null,
      threads,
    })
    showDraft()
    saveActiveChat()
  }

  const isArchived = (desktopId: string, targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>): boolean =>
    get().archivedThreads[archivedThreadKey(desktopId, targetId, thread)] === true

  const workspaceSelection = (desktopId: string, { project, projects, threads }: WorkspaceProject) => ({
    selectedTargetId: project.targetId,
    selectedProjectId: project.id,
    projects,
    projectsLoading: false,
    threads: threads.filter((thread) => !isArchived(desktopId, project.targetId, thread)),
    threadsLoading: false,
    threadsError: null,
    agentErrors: {},
  })

  const recordProjectVisit = async (conn: Connection, { id, targetId, name, path }: Project): Promise<void> => {
    // 最近访问时间写入失败时，仍然可以打开会话。
    await getGateway().rpc(conn, 'projects.save', { id, targetId, name, path }).catch(() => undefined)
  }

  const forgetArchivedChat = (desktopId: string, targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>): void => {
    const matches = (chat: SavedChat | null | undefined) =>
      chat?.targetId === targetId && chat.agent === thread.agent && chat.threadId === thread.id
    const current = get()
    if (current.activeId === desktopId) {
      if (matches(pendingRestore)) pendingRestore = null
      if (current.selectedTargetId === targetId) {
        const threads = current.threads.filter((item) => item.agent !== thread.agent || item.id !== thread.id)
        if (current.page === 'chat' && current.selectedAgent === thread.agent && current.selectedThreadId === thread.id) {
          leaveChat(threads)
        } else if (threads.length !== current.threads.length) {
          set({ threads })
        }
      }
    }
    if (matches(savedChats[desktopId])) {
      delete savedChats[desktopId]
      saveRecord(STORAGE_SAVED_CHATS, savedChats)
    }
  }

  const recordArchive = (desktopId: string, targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>): void => {
    const key = archivedThreadKey(desktopId, targetId, thread)
    if (get().archivedThreads[key]) return
    const archivedThreads: AppState['archivedThreads'] = { ...get().archivedThreads, [key]: true }
    set({ archivedThreads })
    updateQueue(sendKey({ desktopId, targetId, agent: thread.agent, threadId: thread.id }), () => [])
    persistArchives()
    forgetArchivedChat(desktopId, targetId, thread)
  }

  const listVisibleThreads = async (desktopId: string, session: AgentSession, cwd?: string | string[], limit?: number) => {
    const before = get().archivedThreads
    const threads = toThreadSummaries(await listThreads(session.rpc, cwd, limit), session.agent)
    if (session.agent === 'codex' && get().activeId === desktopId && get().sessions[session.key]?.transport === session.transport) {
      // 归档之后发出的查询可以确认用户已在电脑上恢复会话。
      const restored = threads.map((thread) => archivedThreadKey(desktopId, session.targetId, thread))
        .filter((key) => before[key] && get().archivedThreads[key])
      if (restored.length) {
        const archivedThreads = { ...get().archivedThreads }
        for (const key of restored) delete archivedThreads[key]
        set({ archivedThreads })
        persistArchives()
      }
    }
    return threads.filter((thread) => !isArchived(desktopId, session.targetId, thread))
  }

  const clearArchivedThreads = (desktopId: string): void => {
    const prefix = `[${JSON.stringify(desktopId)},`
    const entries = Object.entries(get().archivedThreads)
    const remaining = entries.filter(([key]) => !key.startsWith(prefix))
    if (entries.length === remaining.length) return
    const archivedThreads = Object.fromEntries(remaining)
    set({ archivedThreads })
    persistArchives()
  }

  const removeSavedDesktopState = (id: string): void => {
    delete savedChats[id]
    delete desktopModelPrefs[id]
    for (const key of Object.keys(drafts)) {
      if (key.startsWith(`[${JSON.stringify(id)},`)) delete drafts[key]
    }
    saveRecord(STORAGE_SAVED_CHATS, savedChats)
    saveRecord(STORAGE_DESKTOP_MODEL_PREFS, desktopModelPrefs)
    saveRecord(STORAGE_DRAFTS, drafts)
    clearArchivedThreads(id)
    discardDesktopQueue(id)
  }

  const markRepair = (id: string, reason: RepairReason, message: string): void => {
    set((state) => {
      const active = state.activeId === id
      return {
        needsRepair: { ...state.needsRepair, [id]: reason },
        connectionStatus: { ...state.connectionStatus, [id]: reason === 'fingerprint' ? 'mismatch' : 'offline' },
        connectionLatencyMs: { ...state.connectionLatencyMs, [id]: null },
        ...(active ? { eventsConnected: false, eventsError: message } : {}),
      }
    })
    if (get().activeId === id) {
      eventStreamEpoch += 1
      pauseQueues([id], '电脑需要重新配对，队列已暂停')
      controller?.stop()
    }
  }

  const markRepairError = (conn: Connection, epoch: number, err: unknown): void => {
    if (epoch !== desktopEpoch) return
    const active = activeConnection(get())
    if (active?.host !== conn.host || active.port !== conn.port || active.token !== conn.token) return
    const reason = connectionRepairReason(err)
    if (reason) markRepair(conn.id, reason, friendlyError(err, '请重新配对电脑'))
  }

  const connectSavedTarget = (conn: Connection, targetId: string): Promise<unknown> =>
    getGateway().rpc(conn, 'target.connect', { id: targetId }, undefined, 120_000)

  const restoreSavedChat = async (conn: Connection): Promise<void> => {
    if (restoreTask || !pendingRestore) return
    const chat = pendingRestore
    const epoch = desktopEpoch
    const navigation = navigationEpoch
    const isCurrent = () => epoch === desktopEpoch && navigation === navigationEpoch && get().page === 'workspace'
    const task = (async () => {
      try {
        const [result] = await Promise.all([
          getGateway().rpc<unknown>(conn, 'projects.list', { targetId: chat.targetId }),
          get().loadAgentSettings(),
        ])
        const projects = parseProjects(result)
        if (!isCurrent()) return
        if (isArchived(conn.id, chat.targetId, { id: chat.threadId, agent: chat.agent })
          || !projects.some((project) => project.id === chat.projectId) || !targetAgents(get(), chat.targetId).includes(chat.agent)) {
          pendingRestore = null
          return
        }
        set({ projects, selectedTargetId: chat.targetId, selectedProjectId: chat.projectId })
        await get().openThread(chat.threadId, chat.agent)
        if (epoch === desktopEpoch && get().page === 'chat') pendingRestore = null
      } catch (err) {
        if (isCurrent()) markRepairError(conn, epoch, err)
      }
    })()
    restoreTask = task
    try {
      await task
    } finally {
      if (restoreTask === task) restoreTask = null
    }
  }

  const persist = async (connections: Connection[], activeId: string | null): Promise<void> => {
    try {
      await getGateway().storageSet(STORAGE_CONNECTIONS, serializeConnections(connections))
      await getGateway().storageSet(STORAGE_ACTIVE, activeId)
    } catch (err) {
      set({ error: friendlyError(err, '保存连接失败') })
    }
  }

  const patchSession = (key: string, update: (session: AgentSession) => AgentSession, source?: AgentSession): void => {
    set((state) => {
      const session = state.sessions[key]
      if (!session || (source && session.transport !== source.transport)) return state
      const next = update(session)
      return next === session ? state : { sessions: { ...state.sessions, [key]: next } }
    })
  }

  function updateQueue(key: string, update: (list: QueuedSend[]) => QueuedSend[], persist = true): Promise<void> {
    let snapshot: AppState['queuedSends'] | undefined
    set((state) => {
      const current = state.queuedSends[key] ?? []
      const next = update(current)
      if (next === current || (!next.length && !current.length)) return state
      const queuedSends = { ...state.queuedSends }
      if (next.length) queuedSends[key] = next
      else delete queuedSends[key]
      snapshot = queuedSends
      return { queuedSends }
    })
    if (!snapshot || !persist) return Promise.resolve()
    const json = serializeQueues(snapshot, get().connections)
    const gateway = getGateway()
    const task = queueStorageWrite(QUEUE_STORAGE_KEY, () => gateway.storageSet(QUEUE_STORAGE_KEY, json))
    void task.catch(() => set({ notice: '无法写入本地发送队列，请检查手机存储' }))
    return task
  }

  function dropQueuedSend(key: string, id: string): Promise<void> {
    return updateQueue(key, (list) => {
      const first = list[0]
      const remaining = list.filter((item) => item.id !== id)
      if (first?.id === id && first.error && remaining[0]) {
        remaining[0] = { ...remaining[0], error: remaining[0].error ?? '队列已暂停' }
      }
      return remaining
    })
  }

  function pauseQueue(key: string, message: string): void {
    updateQueue(key, (list) => {
      const index = list.findIndex((item) => !item.sending)
      const item = list[index]
      return item && !item.error ? list.map((value, at) => at === index ? { ...value, error: message } : value) : list
    })
  }

  function pauseQueues(scope: string[], message: string, resetFlights = false): void {
    const prefix = `${JSON.stringify(scope).slice(0, -1)},`
    for (const key of Object.keys(get().queuedSends)) {
      if (!key.startsWith(prefix)) continue
      if (resetFlights) void updateQueue(key, (list) => list.map((item) => item.sending
        ? { ...item, sending: false, error: UNCONFIRMED_QUEUED_SEND } : item))
      pauseQueue(key, message)
    }
  }

  function discardDesktopQueue(desktopId: string): void {
    const prefix = `[${JSON.stringify(desktopId)},`
    for (const key of Object.keys(get().queuedSends)) {
      if (key.startsWith(prefix)) updateQueue(key, () => [])
    }
  }

  function queueLimited(address: SendAddress): boolean {
    const state = get()
    const snapshot = address.agent === 'codex' ? state.rateLimits[address.targetId]?.snapshot
      : address.agent === 'claude' ? state.claudeRateLimits[address.targetId] : null
    return !!(snapshot?.rateLimitReachedType || snapshot?.spendControlReached)
  }

  function pendingQueueAddresses(desktopId: string): SendAddress[] {
    return Object.entries(get().queuedSends).flatMap(([key, items]) => {
      if (!items.length || items[0]?.error) return []
      const [owner, targetId, agent, threadId] = JSON.parse(key) as [string, string, AgentKind, string]
      return owner === desktopId ? [{ desktopId, targetId, agent, threadId }] : []
    })
  }

  async function resumeCodexConversation(session: AgentSession, threadId: string, isCurrent = () => true): Promise<void> {
    const { thread } = await resumeThread(session.rpc, threadId, isCurrent)
    if (!isCurrent()) return
    session.resumedCodexThreads.add(threadId)
    patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, thread) }), session)
  }

  async function startMessageTurn(session: AgentSession, address: SendAddress, input: UserInput[], overrides: TurnOverrides): Promise<void> {
    const { threadId } = address
    const { turn } = await sendInput(session.rpc, threadId, input, overrides)
    const current = get().sessions[session.key]
    if (current?.transport !== session.transport || completedTurns.get(session.transport)?.has(turn.id)) return
    // 极短的一轮可能先完成，轮次响应也可能已是终态。
    if (turn.status === 'inProgress' && current.state.threads[threadId]?.activeTurnId === turn.id) return
    const synthetic = {
      method: turn.status === 'inProgress' ? 'turn/started' : 'turn/completed',
      params: { threadId, turn },
    } as ServerNotification
    patchSession(session.key, (value) => ({ ...value, state: applyNotification(value.state, synthetic) }), session)
    if (turn.status === 'failed' || turn.status === 'interrupted') pauseQueue(sendKey(address), '上一轮未完成，队列已暂停')
  }

  async function flushQueue(address: SendAddress, retry = false): Promise<void> {
    const { desktopId, targetId, agent, threadId } = address
    const state = get()
    const key = sendKey(address)
    const next = state.queuedSends[key]?.[0]
    const session = state.sessions[sessionKey(targetId, agent)]
    const view = session?.state.threads[threadId]
    if (state.activeId !== desktopId || !next || next.sending || next.saving || submitting.has(key) || state.compactingThreads[key]
      || editingQueue.has(next.id) || savingQueue.has(next.id)
      || isArchived(desktopId, targetId, { agent, id: threadId })) return
    if (!session?.opened || !state.eventsConnected || reconnectTask || !view) return
    if (queueLimited(address)) {
      pauseQueue(key, '当前额度已用完，队列已暂停')
      return
    }
    if (view.status === 'running') {
      if (retry) updateQueue(key, (list) => list.map((item) => item.id === next.id ? { ...item, error: undefined } : item))
      return
    }
    if (!retry && (view.status !== 'idle' || next.error)) return

    const epoch = desktopEpoch
    const streamEpoch = eventStreamEpoch
    submitting.add(key)
    let preparing = false
    let submitted = false
    const readyToSend = (): boolean => {
      if (!get().eventsConnected || reconnectTask) return false
      const current = get().sessions[session.key]
      if (!current?.opened || current.transport !== session.transport) throw new Error('目标连接中断，队列已暂停')
      if (queueLimited(address)) throw new Error('当前额度已用完，队列已暂停')
      const thread = current.state.threads[threadId]
      if (thread?.status === 'running') return false
      if (!retry && (thread?.status !== 'idle' || thread.activity === 'interrupted')) {
        throw new Error('上一轮未完成，队列已暂停')
      }
      return true
    }
    const settle = (error?: string) => updateQueue(key, (list) => list.map((item) => item.id === next.id
      ? { ...item, sending: false, error } : item))
    try {
      await updateQueue(key, (list) => list.map((item) => item.id === next.id ? { ...item, sending: true, error: undefined } : item))
      if (epoch !== desktopEpoch) return
      let ready = readyToSend()
      if (ready && agent === 'codex' && !session.resumedCodexThreads.has(threadId)) {
        preparing = true
        await resumeCodexConversation(session, threadId, () => epoch === desktopEpoch && streamEpoch === eventStreamEpoch)
        preparing = false
        if (epoch !== desktopEpoch) return
        ready = streamEpoch === eventStreamEpoch && readyToSend()
      }
      if (!ready) {
        void settle(next.error)
      } else {
        submitted = true
        await startMessageTurn(session, address, queuedInput(agent, next), next.overrides)
        if (epoch === desktopEpoch) void dropQueuedSend(key, next.id)
      }
    } catch (err) {
      if (epoch === desktopEpoch) {
        const streamChanged = streamEpoch !== eventStreamEpoch
        const code = isRecord(err) ? errorCode(err.data) : ''
        const message = friendlyError(err, '排队消息未发送')
        const replyLost = code === 'network' || code === 'timeout' || message.startsWith('Codex request timed out:')
        // turn/start 的回包不参加事件回放，发出后丢失回包可能已经在电脑执行。
        void settle(submitted && (streamChanged || replyLost) ? UNCONFIRMED_QUEUED_SEND
          : preparing && streamChanged && replyLost ? next.error : message)
      }
    } finally {
      if (epoch === desktopEpoch) submitting.delete(key)
    }
    // 快速完成可能已在 RPC 返回前收到结束事件，锁解除后再检查一次。
    if (epoch === desktopEpoch && !get().queuedSends[key]?.[0]?.error) void flushQueue(address)
  }

  async function interruptAndWait(session: AgentSession, threadId: string, turnId: string): Promise<void> {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finished = new Promise<boolean>((resolve) => {
      unsubscribe = session.rpc.onNotification((note) => {
        if (note.method !== 'turn/completed' || note.params?.threadId !== threadId || note.params.turn?.id !== turnId) return
        resolve(note.params.turn.status === 'interrupted' || note.params.turn.status === 'completed')
      })
      timer = setTimeout(() => resolve(false), 30_000)
    })
    try {
      await interruptTurn(session.rpc, threadId, turnId)
      if (!(await finished)) throw new Error('未确认当前一轮已停止，请检查会话后重试')
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
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
    const activeId = get().activeId
    if (activeId) pauseQueues([activeId], '电脑连接已切换，队列已暂停', true)
    for (const session of Object.values(get().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
    opening.clear()
    rateRefresh.clear()
    claudeCostPerTurn.clear()
    reconnectTask = null
    submitting.clear()
    replacing.clear()
    editingQueue.clear()
    set({ compactingThreads: {} })
  }

  const serverReq = async <T>(targetId: string, method: string, params: unknown): Promise<T> => {
    const conn = activeConnection(get())
    if (!conn) throw new Error('尚未选择电脑')
    const epoch = desktopEpoch
    try {
      return await getGateway().rpc<T>(conn, 'server.req', { targetId, method, params })
    } catch (err) {
      markRepairError(conn, epoch, err)
      throw err
    }
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
      const activeId = get().activeId
      const snapshot = get().rateLimits[targetId]?.snapshot
      if (activeId && (snapshot?.rateLimitReachedType || snapshot?.spendControlReached)) {
        pauseQueues([activeId, targetId, 'codex'], '当前额度已用完，队列已暂停')
      }
    } else if (record.method === 'turn/completed') {
      void get().refreshRateLimits(targetId)
    }
  }

  const sessionFor = (targetId: string, agent: AgentKind): AgentSession => {
    const key = sessionKey(targetId, agent)
    const existing = get().sessions[key]
    if (existing) return existing

    const epoch = desktopEpoch
    const conn = activeConnection(get())!
    const transport = new MobileCodexTransport(
      targetId,
      async (msg) => {
        if (epoch !== desktopEpoch) throw new Error('电脑连接已切换')
        // agent 直接放进 params：网关与 backend 都按 params.agent 路由，旧桌面会忽略它。
        const current = activeConnection(get()) ?? conn
        try {
          return await getGateway().rpc(current, 'codex.send', { targetId, agent, msg })
        } catch (err) {
          markRepairError(current, epoch, err)
          throw err
        }
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
      resumedCodexThreads: new Set(),
      loadedThreads: new Set(),
      state: emptyState(),
      opened: false,
      opening: false,
      openError: null,
      lastSeq: null,
    }
    set((state) => ({ sessions: { ...state.sessions, [key]: session } }))

    rpc.onNotification((notification: ServerNotification) => {
      if (epoch !== desktopEpoch) return
      const rawParams: unknown = notification.params
      const params = isRecord(rawParams) ? rawParams : null
      const method = (notification as unknown as JsonRecord).method
      const resolutionId = method === 'serverRequest/resolved' ? params?.requestId ?? params?.id : null
      const resolved = typeof resolutionId === 'string' || typeof resolutionId === 'number' ? resolutionId : null
      if (resolved !== null) approvalFlights.get(transport)?.delete(resolved)
      const selected = get()
      const currentThreadId = selected.selectedThreadId
      const visibleResolution = resolved !== null && currentThreadId !== null
        && selected.selectedTargetId === targetId && selected.selectedAgent === agent
        && selected.sessions[key]?.state.threads[currentThreadId]?.pendingApprovals.some((item) => item.requestId === resolved)
      patchSession(key, (current) => ({
        ...current,
        state: resolved !== null ? resolveServerRequest(current.state, resolved) : applyNotification(current.state, notification),
      }), session)
      if (agent === 'codex') {
        handleRateLimitNotification(targetId, notification)
        if (typeof params?.threadId === 'string') {
          if (method === 'thread/closed' || method === 'thread/deleted') {
            session.resumedCodexThreads.delete(params.threadId)
            session.loadedThreads.delete(params.threadId)
          } else if (method === 'thread/reverted') {
            session.loadedThreads.delete(params.threadId)
          }
        }
        if (method === 'thread/archived' && typeof params?.threadId === 'string') {
          session.resumedCodexThreads.delete(params.threadId)
          session.loadedThreads.delete(params.threadId)
          recordArchive(conn.id, targetId, { id: params.threadId, agent })
        }
        if (method === 'thread/unarchived' && get().selectedTargetId === targetId) {
          void get().refreshThreads({ skipFailed: true })
        }
      }
      if (method === 'turn/completed') {
        const turn = isRecord(params?.turn) ? params.turn : null
        const turnId = turn?.id ?? params?.turnId
        if (typeof turnId === 'string') {
          const turns = completedTurns.get(transport) ?? new Set<string>()
          turns.add(turnId)
          if (turns.size > 1024) {
            const oldest = turns.values().next().value
            if (oldest !== undefined) turns.delete(oldest)
          }
          completedTurns.set(transport, turns)
        }
        if (typeof params?.threadId === 'string' && get().sessions[key]?.state.threads[params.threadId]?.status !== 'running') {
          const address = { desktopId: conn.id, targetId, agent, threadId: params.threadId }
          if (turn?.status === 'completed') void flushQueue(address)
          else if (turn?.status !== 'interrupted' || !replacing.has(sendKey(address))) {
            pauseQueue(sendKey(address), '上一轮未完成，队列已暂停')
          }
        }
      } else if (method === 'error' && typeof params?.threadId === 'string' && params.willRetry !== true
        && get().sessions[key]?.state.threads[params.threadId]?.status !== 'running') {
        pauseQueue(sendKey({ desktopId: conn.id, targetId, agent, threadId: params.threadId }), '上一轮未完成，队列已暂停')
      }
      if (visibleResolution) {
        set((state) => {
          const approvalSubmitting = { ...state.approvalSubmitting }
          delete approvalSubmitting[String(resolved)]
          return { approvalSubmitting, notice: '审批已处理' }
        })
      }
      if (agent === 'claude' && method === 'account/rateLimits/updated') {
        const snapshot = applyRateLimitsUpdate(get().claudeRateLimits[targetId] ?? null, notification)
        if (snapshot) set((state) => ({ claudeRateLimits: { ...state.claudeRateLimits, [targetId]: snapshot } }))
        if (snapshot?.rateLimitReachedType) pauseQueues([conn.id, targetId, agent], '当前额度已用完，队列已暂停')
      } else if (agent === 'claude' && method === 'thread/tokenUsage/updated') {
        const threadId = params?.threadId
        const turnId = params?.turnId
        const cost = isRecord(params?.tokenUsage) ? params.tokenUsage.estimatedCostUsd : null
        if (typeof threadId === 'string' && typeof turnId === 'string' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
          const costKey = JSON.stringify([targetId, threadId])
          const turnKey = JSON.stringify([targetId, threadId, turnId])
          const previous = claudeCostPerTurn.get(turnKey) ?? 0
          claudeCostPerTurn.set(turnKey, cost)
          set((state) => ({
            claudeCosts: { ...state.claudeCosts, [costKey]: (state.claudeCosts[costKey] ?? 0) + cost - previous },
          }))
        }
      }
      if (method === 'turn/completed' || method === 'thread/started') {
        if (get().selectedTargetId === targetId) void get().refreshThreads({ skipFailed: true })
      }
    })
    rpc.onServerRequest((request: ServerRequest) => {
      // 审批只入队等用户点；手机端任何路径都不自动应答（docs/agent-adapters.md R7）。
      patchSession(key, (current) => ({
        ...current,
        state: applyServerRequest(current.state, request),
      }), session)
    })
    return session
  }

  /** 确认会话通道可用后执行；失败把原因写到 error。 */
  const withSession = async (targetId: string, agent: AgentKind, navigation: number): Promise<AgentSession | null> => {
    const epoch = desktopEpoch
    if (!(await get().ensureOpen(targetId, agent))) {
      if (epoch !== desktopEpoch || navigation !== navigationEpoch) return null
      const key = sessionKey(targetId, agent)
      set({ error: get().sessions[key]?.openError ?? `${agentLabel(agent)} 未就绪` })
      return null
    }
    if (epoch !== desktopEpoch || navigation !== navigationEpoch) return null
    return get().sessions[sessionKey(targetId, agent)] ?? null
  }

  const reloadConversation = async (session: AgentSession, threadId: string, isCurrent = () => true): Promise<boolean> => {
    try {
      const result = await readThread(session.rpc, threadId, isCurrent)
      if (!isCurrent() || result?.thread?.id !== threadId || get().sessions[session.key]?.transport !== session.transport) return false
      if (get().eventsConnected && get().sessions[session.key]?.opened) session.loadedThreads.add(threadId)
      patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, result.thread) }), session)
      return true
    } catch (err) {
      if (isCurrent() && showsConversation(session) && get().selectedThreadId === threadId
        && get().sessions[session.key]?.transport === session.transport) {
        set({ notice: friendlyError(err, '暂时无法补齐会话历史，可再次打开会话') })
      }
      return false
    }
  }

  const clearPendingApprovals = (session: AgentSession): void => {
    approvalFlights.get(session.transport)?.clear()
    patchSession(session.key, (value) => ({
      ...value,
      state: {
        threads: Object.fromEntries(
          Object.entries(value.state.threads).map(([id, thread]) => [id, { ...thread, pendingApprovals: [] }]),
        ),
      },
    }), session)
    if (get().selectedTargetId === session.targetId && get().selectedAgent === session.agent) {
      set({ approvalSubmitting: {} })
    }
  }

  const attachSession = (conn: Connection, session: AgentSession, sinceSeq: number) =>
    getGateway().rpc<unknown>(conn, 'server.req', {
      targetId: session.targetId,
      method: 'codex.attach',
      params: { agent: session.agent, sinceSeq },
    })

  const attachExisting = async (conn: Connection, targetId: string, agent: AgentKind, epoch: number): Promise<AgentSession | null> => {
    const status = await getGateway().rpc<unknown>(conn, 'server.req', { targetId, method: 'codex.status', params: { agent } })
    if (epoch !== desktopEpoch || !isRecord(status) || status.running !== true) return null
    const key = sessionKey(targetId, agent)
    const busy = opening.get(key)
    if (busy) await busy
    if (epoch !== desktopEpoch) return null
    const session = sessionFor(targetId, agent)
    if (!session.opened) {
      const task = (async () => {
        try {
          // 发现首页会话时只订阅正在运行的 Agent；游标前的未决审批仍会由 daemon 补发。
          const attached = attachResult(await attachSession(conn, session, Number.MAX_SAFE_INTEGER))
          if (epoch !== desktopEpoch) return false
          session.transport.setLastSeq(attached.lastSeq)
          patchSession(key, (current) => ({
            ...current,
            opened: true,
            openError: null,
            lastSeq: attached.lastSeq,
          }), session)
          return true
        } catch (err) {
          markRepairError(conn, epoch, err)
          return false
        }
      })()
      opening.set(key, task)
      try {
        if (!(await task)) return null
      } finally {
        if (opening.get(key) === task) opening.delete(key)
      }
    }
    return epoch === desktopEpoch ? get().sessions[key] ?? null : null
  }

  const reloadActiveConversation = async (session: AgentSession): Promise<void> => {
    const { selectedTargetId, selectedThreadId, selectedAgent } = get()
    if (selectedThreadId && selectedTargetId === session.targetId && selectedAgent === session.agent) {
      await reloadConversation(session, selectedThreadId)
    }
  }

  const showsConversation = (session: AgentSession): boolean => {
    const state = get()
    return state.page === 'chat' && state.selectedThreadId !== null
      && state.selectedTargetId === session.targetId && state.selectedAgent === session.agent
  }

  return {
    page: 'connections',
    targetsReturnPage: 'workspace',
    projectsReturnPage: 'workspace',
    chatReturnPage: 'threads',
    threadsReturnPage: 'projects',
    booting: true,
    mock: false,
    connections: [],
    activeId: null,
    connectionStatus: {},
    connectionLatencyMs: {},
    needsRepair: {},
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
    archivedThreads: {},
    threadsLoading: false,
    threadsError: null,
    agentErrors: {},
    selectedThreadId: null,
    openingThread: null,
    selectedAgent: DEFAULT_AGENT,
    sessions: {},
    models: {},
    modelPrefs: {},
    rateLimits: {},
    claudeRateLimits: {},
    claudeCosts: {},
    viewer: null,
    annotations: [],
    draftText: '',
    approvalSubmitting: {},
    sending: false,
    compactingThreads: {},
    queuedSends: {},
    error: null,
    notice: null,

    init: () => {
      if (initialized) return () => undefined
      initialized = true
      const gateway = getGateway()
      set({ mock: isMockGateway() })
      const onResume = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        controller?.wake()
      }
      if (typeof window !== 'undefined') {
        window.__qnBack = () => get().goBack()
        window.__qnResume = onResume
        window.addEventListener('online', () => controller?.wake(true))
      }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onResume)
      controller = new EventStreamController(gateway, () => activeConnection(get()), {
        onEvent: (event) => get().handleGatewayEvent(event),
        onOpen: (reconnected) => {
          if (reconnected) {
            const epoch = eventStreamEpoch
            const desktopId = get().activeId
            for (const session of Object.values(get().sessions)) session.loadedThreads.clear()
            const task = get().attachOpened()
            reconnectTask = task
            void task.then(() => {
              if (reconnectTask !== task) return
              reconnectTask = null
              if (!desktopId || epoch !== eventStreamEpoch || get().activeId !== desktopId || !get().eventsConnected) return
              for (const address of pendingQueueAddresses(desktopId)) void flushQueue(address)
            }, () => { if (reconnectTask === task) reconnectTask = null })
          }
          set({ eventsConnected: true, eventsError: null })
          const conn = activeConnection(get())
          if (conn && pendingRestore) void restoreSavedChat(conn)
        },
        onClose: (error) => {
          eventStreamEpoch += 1
          set({ eventsConnected: false, eventsError: error })
        },
        onRepair: (reason, message) => {
          const id = get().activeId
          if (id) markRepair(id, reason, message)
        },
      })
      void (async () => {
        try {
          const optional = (key: string) => gateway.storageGet(key).catch(() => null)
          const [raw, active, legacyPrefs, prefs, storedDrafts, chats, archives, queues] = await Promise.all([
            gateway.storageGet(STORAGE_CONNECTIONS),
            gateway.storageGet(STORAGE_ACTIVE),
            optional(STORAGE_MODEL_PREFS),
            optional(STORAGE_DESKTOP_MODEL_PREFS),
            optional(STORAGE_DRAFTS),
            optional(STORAGE_SAVED_CHATS),
            optional(STORAGE_ARCHIVED_THREADS),
            optional(QUEUE_STORAGE_KEY),
          ])
          const connections = parseConnections(raw)
          const activeId = active && connections.some((item) => item.id === active) ? active : null
          drafts = parseDrafts(storedDrafts)
          savedChats = parseSavedChats(chats)
          desktopModelPrefs = Object.fromEntries(Object.entries(parseStoredRecord(prefs))
            .map(([id, value]) => [id, parsePrefs(JSON.stringify(value))]))
          if (activeId && !prefs && legacyPrefs) {
            desktopModelPrefs[activeId] = parsePrefs(legacyPrefs)
            saveRecord(STORAGE_DESKTOP_MODEL_PREFS, desktopModelPrefs)
          }
          const archivedThreads = Object.fromEntries(Object.entries(parseStoredRecord(archives))
            .flatMap(([key, value]) => value === true ? [[key, true] as const] : []))
          set({ connections, archivedThreads, queuedSends: restoreQueues(queues, connections, archivedThreads), booting: false })
          if (activeId) await get().activate(activeId)
          else void get().refreshStatuses()
        } catch (err) {
          set({ booting: false, error: friendlyError(err, '读取本地连接失败') })
        }
      })()
      setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        controller?.wake()
        for (const session of Object.values(get().sessions)) {
          if (session.opened && session.agent === 'codex') void get().refreshRateLimits(session.targetId)
        }
      }, REFRESH_INTERVAL_MS)
      // WebView 生命周期内不拆除事件流，避免 React 开发态重复挂载造成重连风暴。
      return () => undefined
    },

    refreshStatuses: async () => {
      await Promise.all(get().connections.map((item) => {
        const existing = connectionProbes.get(item)
        if (existing) return existing
        const task = (async () => {
          if (!get().needsRepair[item.id]) {
            set((state) => ({ connectionStatus: { ...state.connectionStatus, [item.id]: 'checking' } }))
          }
          let status: ConnectionStatus = 'offline'
          let latencyMs: number | null = null
          try {
            const started = performance.now()
            const probe = await getGateway().probe(item.host, item.port)
            status = normalizeFingerprint(probe.fingerprint) === item.fp ? 'online' : 'mismatch'
            if (status === 'online') latencyMs = Math.ceil(performance.now() - started)
          } catch {
            status = 'offline'
          }
          if (!get().connections.includes(item)) return
          if (status === 'mismatch') markRepair(item.id, 'fingerprint', FINGERPRINT_MISMATCH_HINT)
          else if (!get().needsRepair[item.id]) {
            set((state) => ({
              connectionStatus: { ...state.connectionStatus, [item.id]: status },
              connectionLatencyMs: { ...state.connectionLatencyMs, [item.id]: latencyMs },
            }))
          }
        })().finally(() => connectionProbes.delete(item))
        connectionProbes.set(item, task)
        return task
      }))
    },

    openAddForm: () => {
      beginNavigation()
      pendingRestore = null
      set({
        page: 'form',
        form: emptyForm('add', null, get().page === 'workspace' ? 'workspace' : 'connections', {
          name: '', host: '', port: 38500, fp: '', code: '',
        }),
        error: null,
      })
    },

    openEditForm: (id) => {
      const conn = get().connections.find((item) => item.id === id)
      if (!conn) return
      beginNavigation()
      pendingRestore = null
      const page = get().page
      const returnPage = page === 'form' ? 'connections' : page
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

    beginRepair: (id) => {
      const conn = get().connections.find((item) => item.id === id)
      if (!conn) return
      beginNavigation()
      pendingRestore = null
      const page = get().page
      set({
        page: 'form',
        form: emptyForm('repair', id, page === 'form' ? 'connections' : page, {
          name: conn.name,
          host: conn.host,
          port: conn.port,
          fp: get().needsRepair[id] === 'fingerprint' ? '' : conn.fp,
          code: '',
        }),
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
      if (!form || form.mode === 'edit' || form.saving || form.testing) return
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
      const pending = { ...form, saving: true, error: null }
      set({ form: pending })
      try {
        const result = await getGateway().pair(
          draft,
          get().mock ? '浏览器调试' : DEVICE_NAME,
        )
        if (get().form !== pending) return
        const previous = form.mode === 'repair' ? get().connections.find((item) => item.id === form.editId) : null
        if (form.mode === 'repair' && !previous) throw new Error('此电脑连接已移除')
        const conn: Connection = {
          id: previous?.id ?? makeId(),
          name: draft.name.trim() || '未命名电脑',
          host: draft.host,
          port: draft.port,
          fp,
          token: result.token,
          desktopName: result.desktopName || draft.name,
          createdAt: previous?.createdAt ?? Date.now(),
        }
        const connections = previous
          ? get().connections.map((item) => item.id === conn.id ? conn : item)
          : [...get().connections, conn]
        await getGateway().storageSet(STORAGE_CONNECTIONS, serializeConnections(connections))
        if (get().form !== pending) return
        const needsRepair = { ...get().needsRepair }
        delete needsRepair[conn.id]
        if (previous && previous.fp !== fp) {
          // 新证书只能证明刚确认的电脑，旧会话及草稿不能自动带过去。
          delete savedChats[conn.id]
          saveRecord(STORAGE_SAVED_CHATS, savedChats)
          clearArchivedThreads(conn.id)
          discardDesktopQueue(conn.id)
        }
        set((state) => ({
          connections, needsRepair, form: null, page: 'connections',
          connectionLatencyMs: { ...state.connectionLatencyMs, [conn.id]: null },
        }))
        void get().refreshStatuses()
        await get().activate(conn.id)
      } catch (err) {
        const current = get().form
        if (current === pending) {
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
      const changedEndpoint = updated.host !== previous.host || updated.port !== previous.port
      set((state) => ({
        connections, form: null, page: form.returnPage,
        ...(changedEndpoint ? { connectionLatencyMs: { ...state.connectionLatencyMs, [updated.id]: null } } : {}),
      }))
      if (get().activeId === previous.id && changedEndpoint) {
        eventStreamEpoch += 1
        set({ eventsConnected: false, eventsError: null, targets: [], error: null })
        controller?.stop()
        pauseQueues([previous.id], '电脑连接已切换，队列已暂停')
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
        desktopEpoch += 1
        beginNavigation()
        pendingRestore = null
        restoreTask = null
        resetSessions()
        viewerToken += 1
        set({
          sessions: {},
          models: {},
          rateLimits: {},
          claudeRateLimits: {},
          claudeCosts: {},
          modelPrefs: {},
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
          eventsError: null,
          sending: false,
          draftText: '',
          annotations: [],
          approvalSubmitting: {},
        })
      }
      removeSavedDesktopState(id)
      const needsRepair = { ...get().needsRepair }
      delete needsRepair[id]
      set((state) => {
        const connectionStatus = { ...state.connectionStatus }
        const connectionLatencyMs = { ...state.connectionLatencyMs }
        delete connectionStatus[id]
        delete connectionLatencyMs[id]
        return { connections, activeId, needsRepair, connectionStatus, connectionLatencyMs, page: wasActive ? 'connections' : state.page }
      })
      await persist(connections, activeId)
      void get().refreshStatuses()
    },

    activate: async (id, page = 'workspace') => {
      const state = get()
      const conn = state.connections.find((item) => item.id === id)
      if (!conn) return
      if (state.needsRepair[id] || (page === 'targets' && state.connectionStatus[id] === 'mismatch')) {
        state.beginRepair(id)
        return
      }
      if (page === 'targets' && id === state.activeId && state.eventsConnected) {
        state.cancelPendingNavigation()
        set({ page, targetsReturnPage: 'connections' })
        return
      }
      controller?.stop()
      desktopEpoch += 1
      beginNavigation()
      refreshToken += 1
      viewerToken += 1
      resetSessions()
      pendingRestore = page === 'workspace' ? savedChats[id] ?? null : null
      restoreTask = null
      set({
        activeId: id,
        page,
        targetsReturnPage: page === 'targets' ? 'connections' : 'workspace',
        eventsConnected: false,
        eventsError: null,
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
        sessions: {},
        models: {},
        rateLimits: {},
        claudeRateLimits: {},
        claudeCosts: {},
        modelPrefs: desktopModelPrefs[id] ?? {},
        selectedAgent: DEFAULT_AGENT,
        connectingId: null,
        projectsLoading: false,
        threadsLoading: false,
        threadsError: null,
        credential: null,
        directory: null,
        sending: false,
        draftText: '',
        annotations: [],
        approvalSubmitting: {},
        viewer: null,
        error: null,
        notice: null,
      })
      void persist(get().connections, id)
      controller?.start(false)
      await Promise.all([get().loadTargets(), get().loadAgentSettings()])
    },

    deactivate: () => {
      beginNavigation()
      pendingRestore = null
      set({ page: 'connections' })
    },

    loadTargets: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      const epoch = desktopEpoch
      try {
        const result = await getGateway().rpc<unknown>(conn, 'targets.list', {})
        if (epoch !== desktopEpoch || get().needsRepair[conn.id]) return
        set({ targets: parseTargets(result), connectionStatus: { ...get().connectionStatus, [conn.id]: 'online' } })
      } catch (err) {
        if (epoch !== desktopEpoch) return
        markRepairError(conn, epoch, err)
        set({ error: friendlyError(err, '读取目标列表失败') })
      }
    },

    loadAgentSettings: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      const epoch = desktopEpoch
      try {
        const result = await getGateway().rpc<unknown>(conn, 'mobile.agents', {})
        if (epoch === desktopEpoch) set({ agentSettings: parseMobileAgents(result) })
      } catch (err) {
        // 旧桌面版本没有 mobile.agents：只用 Codex。
        if (epoch === desktopEpoch) {
          markRepairError(conn, epoch, err)
          set({ agentSettings: null })
        }
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
      const epoch = desktopEpoch
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
        if (epoch !== desktopEpoch) return
        markRepairError(conn, epoch, err)
        const message = hostKeyMessage(err, '连接失败')
        set((state) => ({
          targetErrors: { ...state.targetErrors, [id]: message },
          targetStates: applyTargetState(state.targetStates, { id, state: 'error', detail: message }),
          notice: isHostKeyError(err) ? HOST_KEY_HINT : null,
        }))
      } finally {
        if (epoch === desktopEpoch && get().connectingId === id) set({ connectingId: null })
      }
    },

    disconnectTarget: async (id) => {
      const conn = activeConnection(get())
      if (!conn) return
      const epoch = desktopEpoch
      try {
        await getGateway().rpc(conn, 'target.disconnect', { id })
        if (epoch !== desktopEpoch) return
        set((state) => ({ targetStates: applyTargetState(state.targetStates, { id, state: 'idle' }) }))
        pauseQueues([conn.id, id], '目标连接中断，队列已暂停')
      } catch (err) {
        if (epoch !== desktopEpoch) return
        markRepairError(conn, epoch, err)
        set({ notice: friendlyError(err, '断开失败') })
      }
    },

    selectTarget: async (id) => {
      const state = get()
      const conn = activeConnection(state)
      if (!conn) return
      const navigation = beginNavigation()
      pendingRestore = null
      const epoch = desktopEpoch
      const isCurrent = () => epoch === desktopEpoch && navigation === navigationEpoch && get().selectedTargetId === id
      set({
        selectedTargetId: id,
        selectedProjectId: null,
        selectedThreadId: null,
        projects: [],
        projectsLoading: true,
        threads: [],
        agentErrors: {},
        page: 'projects',
        projectsReturnPage: state.page === 'targets' ? 'targets' : 'workspace',
      })
      showDraft()
      saveActiveChat()
      // 启用状态可能在电脑上刚改过，每次进入目标都重新取一次（失败不阻断）。
      void get().loadAgentSettings()
      try {
        const result = await getGateway().rpc<unknown>(conn, 'projects.list', { targetId: id })
        if (!isCurrent()) return
        set({ projects: parseProjects(result), projectsLoading: false })
      } catch (err) {
        if (!isCurrent()) return
        markRepairError(conn, epoch, err)
        set({ projectsLoading: false, error: friendlyError(err, '读取项目列表失败') })
      }
    },

    selectProject: async (id, workspace) => {
      const source = get()
      const conn = activeConnection(source)
      const project = workspace?.project ?? source.projects.find((item) => item.id === id)
      if (!conn || !project) return
      beginNavigation()
      pendingRestore = null
      const changedTarget = source.selectedTargetId !== project.targetId
      set({
        selectedProjectId: id,
        selectedThreadId: null,
        threads: [],
        threadsError: null,
        agentErrors: {},
        ...(workspace ? workspaceSelection(conn.id, workspace) : {}),
        threadsLoading: true,
        page: 'threads',
        threadsReturnPage: source.page === 'workspace' ? 'workspace' : 'projects',
        error: null,
      })
      showDraft()
      saveActiveChat()
      if (changedTarget) void get().loadAgentSettings()
      await Promise.all([get().refreshThreads(), recordProjectVisit(conn, project)])
    },

    cancelPendingNavigation: () => {
      beginNavigation()
      pendingRestore = null
    },

    openDirectory: async () => {
      const conn = activeConnection(get())
      const targetId = get().selectedTargetId
      if (!conn || !targetId) return
      const epoch = desktopEpoch
      const directory = { path: '', entries: [], parent: null, loading: true, error: null, saving: false }
      set({ directory })
      try {
        const home = await getGateway().rpc<{ path: string }>(conn, 'server.req', {
          targetId,
          method: 'fs.home',
          params: {},
        })
        if (epoch === desktopEpoch && get().directory === directory) await get().browseDirectory(home.path)
      } catch (err) {
        if (epoch !== desktopEpoch || get().directory !== directory) return
        markRepairError(conn, epoch, err)
        set({ directory: { ...directory, loading: false, error: friendlyError(err, '读取主目录失败') } })
      }
    },

    browseDirectory: async (path) => {
      const conn = activeConnection(get())
      const targetId = get().selectedTargetId
      if (!conn || !targetId) return
      const epoch = desktopEpoch
      const current = get().directory
      const pending = { path, entries: current?.entries ?? [], parent: parentPath(path), loading: true, error: null, saving: false }
      set({ directory: pending })
      try {
        const result = await getGateway().rpc<FsListResult>(conn, 'server.req', {
          targetId,
          method: 'fs.list',
          params: { path, dirsOnly: true },
        })
        if (epoch !== desktopEpoch || get().directory !== pending) return
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
        if (epoch !== desktopEpoch || get().directory !== pending) return
        markRepairError(conn, epoch, err)
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
      const epoch = desktopEpoch
      const pending = { ...dir, saving: true, error: null }
      set({ directory: pending })
      try {
        const saved = await getGateway().rpc<unknown>(conn, 'projects.save', { targetId, path: dir.path })
        if (epoch !== desktopEpoch || get().directory !== pending) return
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
          threadsReturnPage: 'projects',
        }))
        await get().refreshThreads()
      } catch (err) {
        if (epoch !== desktopEpoch || get().directory !== pending) return
        markRepairError(conn, epoch, err)
        set({ directory: { ...pending, saving: false, error: friendlyError(err, '添加项目失败') } })
      }
    },

    ensureOpen: async (targetId, agent = DEFAULT_AGENT) => {
      const epoch = desktopEpoch
      if (reconnectTask) await reconnectTask
      if (epoch !== desktopEpoch) return false
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
      patchSession(key, (value) => ({ ...value, opening: true, openError: null, openErrorCode: undefined }), session)
      const task = (async () => {
        try {
          // 可执行文件路径由网关按电脑设置补上，手机不传路径。
          const opened = await getGateway().rpc<unknown>(conn, 'server.req', {
            targetId,
            method: 'codex.open',
            params: { agent },
          })
          if (epoch !== desktopEpoch) return false
          const hostSeq = openSeq(opened)
          const seen = session.transport.getLastSeq()
          const reset = seen !== null && hostSeq !== null && hostSeq < seen
          if (reset) {
            session.transport.resetSequence()
            session.resumedCodexThreads.clear()
            clearPendingApprovals(session)
          }
          let lastSeq = reset ? hostSeq : seen ?? hostSeq
          let truncated = reset
          try {
            // 每个 agent 有独立的回放缓冲，attach 必须带上 agent。
            const attached = await attachSession(conn, session, lastSeq ?? 0)
            const info = attachResult(attached)
            lastSeq = maxSeq(lastSeq, info.lastSeq)
            truncated ||= info.truncated
          } catch (err) {
            if (!['unknown_method', 'method_not_found', '-32601'].includes(errorCode(err))) throw err
          }
          if (epoch !== desktopEpoch) return false
          session.transport.setLastSeq(lastSeq)
          patchSession(key, (value) => ({
            ...value,
            opened: true,
            opening: false,
            openError: null,
            lastSeq,
          }), session)
          if (truncated) void reloadActiveConversation(session)
          if (agent === 'codex') void get().refreshRateLimits(targetId)
          return true
        } catch (err) {
          if (epoch !== desktopEpoch) return false
          markRepairError(conn, epoch, err)
          patchSession(key, (value) => ({
            ...value,
            opened: false,
            opening: false,
            openError: openFailureMessage(agent, err),
            openErrorCode: errorCode(err),
          }), session)
          return false
        } finally {
          if (epoch === desktopEpoch) {
            opening.delete(key)
            patchSession(key, (value) => ({ ...value, opening: false }), session)
          }
        }
      })()
      opening.set(key, task)
      return task
    },

    attachOpened: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      const epoch = desktopEpoch
      const streamEpoch = eventStreamEpoch
      const isCurrent = () => epoch === desktopEpoch && streamEpoch === eventStreamEpoch
      await Promise.all(Object.values(get().sessions).filter((session) => session.opened).map(async (session) => {
        const queued = () => pendingQueueAddresses(conn.id)
          .filter((address) => address.targetId === session.targetId && address.agent === session.agent)
        try {
          const cursor = session.transport.getLastSeq() ?? 0
          let info
          try {
            info = attachResult(await attachSession(conn, session, cursor))
          } catch (err) {
            if (!isCurrent() || !showsConversation(session) || errorCode(err) !== 'not_connected') throw err
            await connectSavedTarget(conn, session.targetId)
            if (!isCurrent()) return
            info = attachResult(await attachSession(conn, session, cursor))
          }
          if (!isCurrent()) return
          const restarted = info.lastSeq !== null && info.lastSeq < cursor
          if (restarted) {
            session.transport.resetSequence()
            session.resumedCodexThreads.clear()
            clearPendingApprovals(session)
            // 接回用户正在看的一条对话时才允许启动重启后还没恢复的 Agent。
            if (showsConversation(session)) {
              await getGateway().rpc(conn, 'server.req', {
                targetId: session.targetId,
                method: 'codex.open',
                params: { agent: session.agent },
              })
              if (!isCurrent()) return
            }
            info = attachResult(await attachSession(conn, session, 0))
            if (!isCurrent()) return
          }
          const queueNeedsSnapshot = restarted || info.truncated || info.lastSeq === null
            || info.lastSeq > (session.transport.getLastSeq() ?? 0)
          patchSession(session.key, (value) => ({
            ...value,
            opened: true,
            openError: null,
            lastSeq: restarted ? info.lastSeq : maxSeq(value.lastSeq, info.lastSeq),
          }), session)
          const queueAddresses = queueNeedsSnapshot ? queued() : []
          const threadIds = new Set(queueAddresses.map((address) => address.threadId))
          const selected = get().selectedThreadId
          if ((restarted || info.truncated) && selected && showsConversation(session)) threadIds.add(selected)
          // attach 的 HTTP 回包可能早于事件流；有缺口时先读会话，再判断队列能否发送。
          await Promise.all([...threadIds].map(async (threadId) => {
            const loaded = await reloadConversation(session, threadId, isCurrent)
            if (!isCurrent()) return
            const address = queueAddresses.find((item) => item.threadId === threadId)
            if (!address) return
            const key = sendKey(address)
            const view = get().sessions[session.key]?.state.threads[threadId]
            if (!loaded) pauseQueue(key, '未能确认会话状态，队列已暂停')
            else if (view?.status === 'error' || view?.activity === 'interrupted') pauseQueue(key, '上一轮未完成，队列已暂停')
          }))
        } catch (err) {
          if (!isCurrent()) return
          markRepairError(conn, epoch, err)
          patchSession(session.key, (value) => ({ ...value, opened: false, openError: '会话连接已断开，操作时会尝试重新连接' }), session)
          for (const address of queued()) pauseQueue(sendKey(address), '会话连接未能恢复，队列已暂停')
        }
      }))
    },

    refreshThreads: async (options) => {
      const token = ++refreshToken
      const { activeId, selectedProjectId, selectedTargetId: targetId } = get()
      if (!activeId || !targetId) {
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
            return { agent, threads: await listVisibleThreads(activeId, session, cwd), error: null }
          } catch (err) {
            return { agent, threads: [], error: friendlyError(err, '加载会话列表失败') }
          }
        }),
      )
      if (token !== refreshToken || get().selectedTargetId !== targetId || get().selectedProjectId !== selectedProjectId) return
      const agentErrors: Partial<Record<AgentKind, string>> = {}
      for (const agent of skipped) {
        const previous = previousErrors[agent] ?? get().sessions[sessionKey(targetId, agent)]?.openError
        if (previous) agentErrors[agent] = previous
      }
      for (const result of results) if (result.error) agentErrors[result.agent] = result.error
      const allFailed = skipped.size === 0 && results.length > 0 && results.every((result) => result.error !== null)
      set({
        threads: mergeThreadSummaries(results.map((result) => result.threads))
          .filter((thread) => !isArchived(activeId, targetId, thread)),
        threadsLoading: false,
        agentErrors,
        threadsError: allFailed
          ? results.map((result) => `${agentLabel(result.agent)}：${result.error}`).join('\n')
          : null,
      })
    },

    discoverWorkspaceSessions: async (projects) => {
      const conn = activeConnection(get())
      if (!conn || get().page !== 'workspace' || !get().eventsConnected || !projects.length) return []
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return []
      const epoch = desktopEpoch
      const normalized = (path: string) => {
        const kind = pathStyle(path)
        const value = normalizePath(path, kind).replace(/\\/g, '/')
        return kind === 'windows' ? value.toLowerCase() : value
      }
      const candidates = new Map<string, Map<string, Project>>()
      for (const project of projects) {
        const paths = candidates.get(project.targetId) ?? new Map<string, Project>()
        paths.set(normalized(project.path), project)
        candidates.set(project.targetId, paths)
      }
      await get().loadAgentSettings()
      if (epoch !== desktopEpoch || get().page !== 'workspace') return []
      const discovery = await Promise.allSettled([...candidates].flatMap(([targetId, paths]) =>
        targetAgents(get(), targetId).map(async (agent): Promise<DiscoveredThread[]> => {
          const session = await attachExisting(conn, targetId, agent, epoch)
          if (!session || get().page !== 'workspace') return []
          const threads = await listVisibleThreads(conn.id, session, [...paths.values()].map((project) => project.path), 100)
          return threads.flatMap((thread) => {
            const project = paths.get(normalized(thread.cwd))
            return project ? [{ ...thread, targetId, projectId: project.id }] : []
          })
        }),
      ))
      if (epoch !== desktopEpoch) return []
      return discovery.flatMap((item) => item.status === 'fulfilled' ? item.value : [])
    },

    newThread: async (agent, workspace) => {
      const source = get()
      const conn = activeConnection(source)
      const targetId = workspace?.project.targetId ?? source.selectedTargetId
      if (!conn || !targetId) return false
      const epoch = desktopEpoch
      const navigation = beginNavigation()
      pendingRestore = null
      const isCurrent = () => epoch === desktopEpoch && navigation === navigationEpoch && get().page === source.page
      const cwd = workspace?.project.path ?? currentCwd(source)
      const picked = agent ?? defaultAgentFor(source, targetId)
      set({ error: null })
      if (!targetAgents(get(), targetId).includes(picked)) {
        set({ error: `${agentLabel(picked)} 已在电脑设置中关闭` })
        return false
      }
      const session = await withSession(targetId, picked, navigation)
      if (!session || !isCurrent()) return false
      try {
        const result = await startThread(session.rpc, cwd ? { cwd } : {})
        if (!isCurrent()) return false
        if (picked === 'codex') session.resumedCodexThreads.add(result.thread.id)
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, result.thread) }), session)
        const movedProject = workspace &&
          (source.selectedTargetId !== targetId || source.selectedProjectId !== workspace.project.id)
        set({
          ...(movedProject ? workspaceSelection(conn.id, workspace) : {}),
          selectedThreadId: result.thread.id,
          selectedAgent: picked,
          page: 'chat',
          chatReturnPage: chatReturnPage(source),
          error: null,
        })
        showDraft()
        saveActiveChat()
        void get().refreshThreads({ skipFailed: true })
        if (workspace) void recordProjectVisit(conn, workspace.project)
        return true
      } catch (err) {
        if (isCurrent()) set({ error: friendlyError(err, '新建会话失败') })
        return false
      }
    },

    openThread: async (id, agent, workspace) => {
      const source = get()
      const conn = activeConnection(source)
      const targetId = workspace?.project.targetId ?? source.selectedTargetId
      if (!conn || !targetId) return false
      const picked = agent ?? source.threads.find((item) => item.id === id)?.agent ?? DEFAULT_AGENT
      const key = sessionKey(targetId, picked)
      const archived = () => isArchived(conn.id, targetId, { id, agent: picked })
      if (archived()) return false
      const cached = source.sessions[key]
      const hasFreshHistory = cached?.opened && cached.loadedThreads.has(id) && cached.state.threads[id]
        && source.eventsConnected && !reconnectTask
      const openingThread = { desktopId: conn.id, targetId, agent: picked, threadId: id }
      const navigation = beginNavigation(hasFreshHistory ? null : openingThread)
      if (workspace) pendingRestore = null
      const isCurrent = () => navigation === navigationEpoch
        && get().openingThread === openingThread && get().page === source.page
      const shouldLoad = () => isCurrent() && !archived()
      const showConversation = () => {
        const movedProject = workspace &&
          (source.selectedTargetId !== targetId || source.selectedProjectId !== workspace.project.id)
        set({
          ...(movedProject ? workspaceSelection(conn.id, workspace) : {}),
          selectedThreadId: id,
          selectedAgent: picked,
          page: 'chat',
          chatReturnPage: chatReturnPage(source),
          error: null,
        })
        showDraft()
        saveActiveChat()
        if (movedProject) void recordProjectVisit(conn, workspace.project)
      }
      if (hasFreshHistory) {
        showConversation()
        return true
      }
      set({ error: null })
      const loadHistory = async (): Promise<boolean> => {
        const ready = await get().ensureOpen(targetId, picked)
        if (!isCurrent() || archived()) return false
        const session = get().sessions[key]
        if (!ready || !session) {
          throw new NativeRequestError(session?.openError ?? `${agentLabel(picked)} 未就绪`, session?.openErrorCode)
        }
        if (!get().eventsConnected) throw new Error('电脑事件连接已断开，恢复后请重新打开会话')
        let result: { thread: Thread }
        let resumed = true
        try {
          result = await resumeThread(session.rpc, id, shouldLoad)
        } catch (err) {
          if (!shouldLoad()) return false
          if (isTargetDisconnected(err) || picked !== 'codex' || isOversizeHistoryResponse(err)) throw err
          if (!get().eventsConnected) throw new Error('电脑事件连接已断开，恢复后请重新打开会话')
          resumed = false
          result = await readThread(session.rpc, id, shouldLoad)
        }
        if (!isCurrent() || archived()) return false
        if (result?.thread?.id !== id) throw new Error('电脑返回的会话与所选会话不一致，请重试')
        if (get().eventsConnected && !reconnectTask && get().sessions[key]?.opened) session.loadedThreads.add(id)
        if (picked === 'codex') {
          if (resumed) session.resumedCodexThreads.add(id)
          else session.resumedCodexThreads.delete(id)
        }
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, result.thread) }), session)
        showConversation()
        return true
      }
      const openHistory = async (): Promise<boolean> => {
        try {
          return await loadHistory()
        } catch (err) {
          if (!isCurrent() || archived()) return false
          if (!isTargetDisconnected(err)) throw err
          // 用实际请求判断目标是否断开，连接正常时少一次往返。
          patchSession(key, (session) => {
            session.loadedThreads.clear()
            session.resumedCodexThreads.clear()
            return { ...session, opened: false }
          })
          await connectSavedTarget(conn, targetId)
          return isCurrent() && !archived() ? loadHistory() : false
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // 目标连接、恢复会话和历史兜底共用一次等待，迟到的回包不能再切换页面。
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('打开会话超时，请检查电脑连接后重试')), OPEN_THREAD_TIMEOUT_MS)
        })
        return await Promise.race([openHistory(), deadline])
      } catch (err) {
        if (isCurrent()) {
          markRepairError(conn, desktopEpoch, err)
          set({ error: hostKeyMessage(err, '打开会话失败') })
        }
        return false
      } finally {
        clearTimeout(timer)
        if (get().openingThread === openingThread) set({ openingThread: null })
      }
    },

    archiveConversation: async (targetId, thread) => {
      const conn = activeConnection(get())
      if (!conn) throw new Error('尚未选择电脑')
      const key = archivedThreadKey(conn.id, targetId, thread)
      if (get().archivedThreads[key] || archiveFlights.has(key)) return
      const epoch = desktopEpoch
      const stillPaired = () => get().connections.some((item) => item.id === conn.id && item.fp === conn.fp)
      archiveFlights.add(key)
      try {
        if (thread.agent !== 'codex') {
          await queueStorageWrite(STORAGE_ARCHIVED_THREADS, async () => {
            if (!stillPaired()) throw new Error('电脑连接已移除或重新配对')
            await writeArchives({ ...get().archivedThreads, [key]: true })
            if (stillPaired()) {
              set({ archivedThreads: { ...get().archivedThreads, [key]: true } })
              forgetArchivedChat(conn.id, targetId, thread)
            } else {
              persistArchives()
            }
          })
          return
        }
        const ready = await get().ensureOpen(targetId, thread.agent)
        const session = get().sessions[sessionKey(targetId, thread.agent)]
        if (epoch !== desktopEpoch) throw new Error('电脑连接已切换')
        if (!ready || !session) throw new Error(session?.openError ?? '会话连接未就绪')
        await archiveThread(session.rpc, thread.id)
        session.resumedCodexThreads.delete(thread.id)
        session.loadedThreads.delete(thread.id)
        if (stillPaired()) recordArchive(conn.id, targetId, thread)
      } finally {
        archiveFlights.delete(key)
      }
    },

    setDraftText: (text) => {
      const key = currentDraftKey()
      if (key) saveDraft(key, { text, annotations: get().annotations })
    },

    compactConversation: async () => {
      const initial = get()
      const address = selectedSendAddress(initial)
      if (!address || selectedCompactionBlockedReason(initial)) return false
      const key = sendKey(address)
      if (submitting.has(key) || reconnectTask) {
        set({ error: '会话正在处理消息或恢复连接，请稍后再压缩' })
        return false
      }
      const { targetId, agent, threadId } = address
      const session = initial.sessions[sessionKey(targetId, agent)]!
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      const isCurrent = () => {
        const state = get()
        const selected = selectedSendAddress(state)
        return epoch === desktopEpoch && navigation === navigationEpoch && state.page === 'chat'
          && selected !== null && sendKey(selected) === key
      }
      let unsubscribe = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      set((state) => ({ compactingThreads: { ...state.compactingThreads, [key]: true }, error: null }))
      try {
        if (!session.resumedCodexThreads.has(threadId)) await resumeCodexConversation(session, threadId)
        if (!isCurrent()) return false
        const state = get()
        const current = state.sessions[session.key]
        if (!state.eventsConnected || !current?.opened || current.transport !== session.transport || reconnectTask) {
          throw new Error('会话连接已中断，请重新打开后再压缩')
        }
        const thread = current.state.threads[threadId]
        if (!thread || isArchived(address.desktopId, targetId, { agent, id: threadId })) throw new Error('请重新打开会话')
        if (thread.status === 'running' || thread.pendingApprovals.length > 0) throw new Error('请先等待当前一轮结束')
        if (queueLimited(address)) throw new Error('当前额度已用完')

        // 请求只确认已提交。先监听同一会话的事件，以免快速回包留下重复触发的空档。
        const started = new Promise<boolean>((resolve) => {
          unsubscribe = session.rpc.onNotification((note) => {
            if ((note.method === 'turn/started' || note.method === 'turn/completed'
              || (note.method === 'item/started' && note.params.item.type === 'contextCompaction'))
              && note.params.threadId === threadId) resolve(true)
          })
          timer = setTimeout(() => resolve(false), 30_000)
        })
        await session.rpc.request('thread/compact/start', { threadId })
        if (!(await started)) throw new Error('尚未收到压缩进度，请检查当前会话')
        return true
      } catch (err) {
        if (isCurrent()) set({ error: `压缩会话失败。${friendlyError(err, '请稍后重试')}` })
        return false
      } finally {
        unsubscribe()
        clearTimeout(timer)
        if (epoch === desktopEpoch) {
          set((state) => {
            const compactingThreads = { ...state.compactingThreads }
            delete compactingThreads[key]
            return { compactingThreads }
          })
        }
      }
    },

    send: async (text, attachments = [], delegate = false, mode = 'queue', { keepDraft = false } = {}) => {
      const initial = get()
      const conn = activeConnection(initial)
      const { selectedTargetId: targetId, selectedAgent: agent } = initial
      const annotations = keepDraft ? [] : initial.annotations
      const finalText = formatQuotedMessage(annotations, text)
      if (!finalText.trim() && !attachments.length) return false
      const key = currentDraftKey(initial)
      if (!targetId || !key || !conn) {
        set({ error: '请先选择目标' })
        return false
      }
      if (!keepDraft && queueingDrafts.has(key)) return false
      if (mode === 'steer' && agent !== 'codex') {
        set({ error: '当前 Agent 不支持引导' })
        return false
      }
      const draft = { text, annotations }
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      const sessionId = sessionKey(targetId, agent)
      let address = selectedSendAddress(initial)
      if (keepDraft && !address) return false
      let queueKey = address ? sendKey(address) : null
      if (queueKey && initial.compactingThreads[queueKey]) return false
      const view = address ? initial.sessions[sessionId]?.state.threads[address.threadId] : undefined
      const models = initial.models[sessionId]?.models ?? []
      const prefs = initial.modelPrefs[sessionId] ?? EMPTY_PREFS
      const hasImage = attachments.some((item) => item.type === 'image' || item.type === 'localImage')
      if (attachments.some((item) => item.type === 'localImage')
        || (hasImage && (agent === 'pi' || resolveSelection(models, prefs).model?.imageInput === false))) {
        set({ error: '当前 Agent 或模型不支持此图片附件' })
        return false
      }
      const message = { ...draft, attachments, delegate }
      const input = queuedInput(agent, message)
      const overrides = overridesFor(agent, models, prefs)
      const expectedTurnId = mode === 'steer' && view?.status === 'running' ? view.activeTurnId : null
      if (mode === 'steer' && !expectedTurnId) {
        set({ error: '当前一轮已结束，请选择排队或发送' })
        return false
      }
      if (!mobileTurnFits(targetId, agent, initial.selectedThreadId, input, overrides, expectedTurnId ?? undefined)) {
        set({ error: '消息和附件合计超过 1 MiB，请移除部分内容后再发送' })
        return false
      }

      const clearSentDraft = (sentDraftKey: string) => {
        if (keepDraft) return
        const current = drafts[sentDraftKey]
        if (current?.text === draft.text && current.annotations === draft.annotations) {
          saveDraft(sentDraftKey, { text: '', annotations: [] })
        }
      }
      const enqueue = async (chat: SendAddress, sentDraftKey: string) => {
        const chatKey = sendKey(chat)
        const item = { ...message, id: makeId(), overrides, saving: true }
        if (!keepDraft) queueingDrafts.add(sentDraftKey)
        try {
          await updateQueue(chatKey, (list) => [...list, item])
        } catch {
          void dropQueuedSend(chatKey, item.id)
          return false
        } finally {
          if (!keepDraft) queueingDrafts.delete(sentDraftKey)
        }
        void updateQueue(chatKey, (list) => list.map((entry) => entry.id === item.id ? { ...entry, saving: undefined } : entry), false)
        clearSentDraft(sentDraftKey)
        void flushQueue(chat)
        return true
      }
      if (mode === 'queue' && address && queueKey && (
        view?.status === 'running' || initial.queuedSends[queueKey]?.length || submitting.has(queueKey)
      )) {
        if (!keepDraft) saveDraft(key, draft)
        set({ error: null })
        return enqueue(address, key)
      }
      if (initial.sending || (queueKey && submitting.has(queueKey))) return false
      if (!keepDraft) saveDraft(key, draft)
      set({ sending: true, error: null })
      if (queueKey) submitting.add(queueKey)
      try {
        const session = await withSession(targetId, agent, navigation)
        if (!session || epoch !== desktopEpoch || navigation !== navigationEpoch) return false
        let threadId = initial.selectedThreadId
        let sentDraftKey = key
        if (!threadId) {
          const cwd = currentCwd(initial)
          const created = await startThread(session.rpc, cwd ? { cwd } : {})
          if (epoch !== desktopEpoch || navigation !== navigationEpoch) return false
          patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, created.thread) }), session)
          threadId = created.thread.id
          address = { desktopId: conn.id, targetId, agent, threadId }
          queueKey = sendKey(address)
          submitting.add(queueKey)
          if (agent === 'codex') session.resumedCodexThreads.add(threadId)
          set({ selectedThreadId: threadId })
          sentDraftKey = draftKey(conn.id, targetId, initial.selectedProjectId, agent, threadId, conn.fp)
          saveDraft(sentDraftKey, drafts[key] ?? draft)
          saveDraft(key, { text: '', annotations: [] })
          saveActiveChat()
          void get().refreshThreads({ skipFailed: true })
        } else if (agent === 'codex' && !session.resumedCodexThreads.has(threadId)) {
          await resumeCodexConversation(session, threadId)
          if (epoch !== desktopEpoch || navigation !== navigationEpoch) return false
        }
        if (!address || !queueKey) return false
        const current = get().sessions[session.key]?.state.threads[threadId]
        if (expectedTurnId) {
          if (current?.status !== 'running' || current.activeTurnId !== expectedTurnId) {
            throw new Error('当前一轮已结束或切换，消息已保留')
          }
          await steerTurn(session.rpc, threadId, expectedTurnId, input)
          if (epoch === desktopEpoch) clearSentDraft(sentDraftKey)
          return true
        }
        if (current?.status === 'running') {
          if (mode === 'queue') return await enqueue(address, sentDraftKey)
          const turnId = current.activeTurnId
          if (!turnId) throw new Error('暂未收到当前轮次，请稍后重试')
          replacing.add(queueKey)
          await interruptAndWait(session, threadId, turnId)
          if (epoch !== desktopEpoch) return false
          if (navigation !== navigationEpoch) throw new Error('会话已切换，请重新打开后发送')
          if (get().sessions[session.key]?.state.threads[threadId]?.status === 'running') {
            throw new Error('会话已开始另一轮，请检查后再发送')
          }
          replacing.delete(queueKey)
        }
        await startMessageTurn(session, address, input, overrides)
        if (epoch !== desktopEpoch) return true
        clearSentDraft(sentDraftKey)
        return true
      } catch (err) {
        if (epoch === desktopEpoch && navigation === navigationEpoch) {
          set({ error: friendlyError(err, '未确认消息已发送，草稿已保留') })
        }
        if (epoch === desktopEpoch && queueKey && (mode === 'immediate' || mode === 'queue')) {
          pauseQueue(queueKey, '上一条消息未确认发送，队列已暂停')
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          if (queueKey) {
            submitting.delete(queueKey)
            replacing.delete(queueKey)
          }
          set({ sending: false })
          if (address) void flushQueue(address)
        }
      }
    },

    removeQueuedSend: (id) => {
      const address = selectedSendAddress(get())
      if (!address) return
      const key = sendKey(address)
      const item = get().queuedSends[key]?.find((entry) => entry.id === id)
      if (item && !item.sending && !item.saving && !editingQueue.has(id) && !savingQueue.has(id)) void dropQueuedSend(key, id)
    },

    beginQueuedEdit: (id) => {
      const address = selectedSendAddress(get())
      if (!address) return null
      const item = get().queuedSends[sendKey(address)]?.find((entry) => entry.id === id)
      if (!item || item.sending || item.saving || savingQueue.has(id) || editingQueue.has(id)) return null
      editingQueue.add(id)
      return (resume = true) => {
        if (editingQueue.delete(id) && resume) void flushQueue(address)
      }
    },

    editQueuedSend: async (id, text) => {
      const address = selectedSendAddress(get())
      if (!address || !editingQueue.has(id) || savingQueue.has(id)) return false
      const key = sendKey(address)
      const item = get().queuedSends[key]?.find((entry) => entry.id === id)
      if (!item || item.sending) return false
      const edited = { ...item, text }
      const input = queuedInput(address.agent, edited)
      if ((!formatQuotedMessage(item.annotations, text).trim() && !item.attachments.length)
        || !mobileTurnFits(address.targetId, address.agent, address.threadId, input, item.overrides)) return false
      savingQueue.add(id)
      try {
        await updateQueue(key, (list) => list.map((entry) => entry.id === id ? edited : entry))
        return true
      } catch {
        void updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, text: item.text } : entry))
        return false
      } finally {
        savingQueue.delete(id)
      }
    },

    steerQueuedSend: async (id) => {
      const state = get()
      const address = selectedSendAddress(state)
      if (!address || address.agent !== 'codex' || !state.eventsConnected) return false
      const { targetId, agent, threadId } = address
      const key = sendKey(address)
      const session = state.sessions[sessionKey(targetId, agent)]
      const view = session?.state.threads[threadId]
      const turnId = view?.status === 'running' ? view.activeTurnId : null
      const item = state.queuedSends[key]?.find((entry) => entry.id === id)
      if (!session?.opened || !turnId || !item || item.sending || item.saving
        || submitting.has(key) || editingQueue.has(id) || savingQueue.has(id)) return false
      const input = queuedInput(agent, item)
      if (!mobileTurnFits(targetId, agent, threadId, input, {}, turnId)) {
        set({ error: '消息和附件合计超过 1 MiB，请重新编辑后再引导' })
        return false
      }
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      submitting.add(key)
      set({ error: null })
      try {
        await updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: true } : entry))
        if (epoch !== desktopEpoch) return false
        const current = get().sessions[session.key]
        if (!get().eventsConnected || !current?.opened || current.state.threads[threadId]?.activeTurnId !== turnId) {
          throw new Error('当前一轮已结束或切换，排队消息已保留')
        }
        if (queueLimited(address)) throw new Error('当前额度已用完，排队消息已保留')
        await steerTurn(session.rpc, threadId, turnId, input)
        if (epoch === desktopEpoch) void dropQueuedSend(key, id)
        return true
      } catch (err) {
        if (epoch === desktopEpoch) {
          const error = friendlyError(err, '未确认引导成功，排队消息已保留')
          void updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: false, error } : entry))
          if (navigation === navigationEpoch) set({ error })
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          submitting.delete(key)
          void flushQueue(address)
        }
      }
    },

    sendQueuedInNewThread: async (id, mode) => {
      const state = get()
      const address = selectedSendAddress(state)
      if (!address || !state.eventsConnected || reconnectTask || state.sending) return false
      const { targetId, agent, threadId } = address
      if (mode === 'continue' && agent !== 'codex') return false
      const key = sendKey(address)
      const session = state.sessions[sessionKey(targetId, agent)]
      const item = state.queuedSends[key]?.find((entry) => entry.id === id)
      if (!session?.opened || !item || item.sending || item.saving || submitting.has(key)
        || editingQueue.has(id) || savingQueue.has(id) || state.compactingThreads[key]) return false
      if (queueLimited(address)) {
        set({ error: '当前额度已用完，排队消息已保留' })
        return false
      }
      const input = queuedInput(agent, item)
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      const streamEpoch = eventStreamEpoch
      const isCurrent = () => epoch === desktopEpoch && navigation === navigationEpoch
      const checkConnection = () => {
        const current = get().sessions[session.key]
        if (streamEpoch !== eventStreamEpoch || !get().eventsConnected || reconnectTask
          || !current?.opened || current.transport !== session.transport) {
          throw new Error('连接已中断，排队消息已保留')
        }
      }
      let submitted = false
      let created = false
      submitting.add(key)
      set({ error: null })
      try {
        // 先持久化发送状态，防止断线或进程重开后在原队列再次自动发送。
        await updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: true } : entry))
        if (!isCurrent()) return false
        checkConnection()
        let result: { thread: Thread }
        if (mode === 'continue') {
          const { thread: source } = await readThread(session.rpc, threadId, isCurrent)
          if (!isCurrent()) return false
          checkConnection()
          const lastTurn = source?.id === threadId && source.turns?.filter((turn) => isThreadOutcome(turn.status)).at(-1)
          if (!lastTurn) throw new Error('当前还没有已结束的一轮，可用「新会话开始」')
          // 指定已结束的轮次，分支时不会带入原会话正在执行的工作。
          result = await session.rpc.request('thread/fork', { threadId, lastTurnId: lastTurn.id, excludeTurns: true })
        } else {
          const cwd = currentCwd(state)
          result = await startThread(session.rpc, cwd ? { cwd } : {})
        }
        const { thread } = result
        if (!isCurrent()) return false
        if (!thread?.id || thread.id === threadId) throw new Error('未确认新会话已创建，排队消息已保留')
        created = true
        checkConnection()
        if (queueLimited(address)) throw new Error('当前额度已用完，排队消息已保留')
        if (!mobileTurnFits(targetId, agent, thread.id, input, item.overrides)) {
          throw new Error('消息和附件合计超过 1 MiB，请重新编辑后再发送')
        }
        if (agent === 'codex') session.resumedCodexThreads.add(thread.id)
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, thread) }), session)
        submitted = true
        await startMessageTurn(session, { ...address, threadId: thread.id }, input, item.overrides)
        if (epoch !== desktopEpoch) return true
        void dropQueuedSend(key, id)
        if (isCurrent()) {
          const opened = beginNavigation()
          pendingRestore = null
          set({ selectedThreadId: thread.id, error: null })
          showDraft()
          saveActiveChat()
          if (mode === 'continue') {
            void reloadConversation(session, thread.id, () => epoch === desktopEpoch && opened === navigationEpoch)
          }
        }
        return true
      } catch (err) {
        if (epoch === desktopEpoch) {
          const error = submitted ? UNCONFIRMED_QUEUED_SEND : friendlyError(err, '新会话发送失败，排队消息已保留')
          // 创建或发送失败时保留这条消息，待用户确认后再发送。
          void updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: false, error } : entry))
          if (isCurrent()) set({ error })
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          submitting.delete(key)
          if (!isCurrent() && !submitted) {
            void updateQueue(key, (list) => list.map((entry) => entry.id === id && entry.sending
              ? { ...entry, sending: false, error: '已切换会话，排队消息已保留' } : entry))
          }
          if (created && get().selectedTargetId === targetId) void get().refreshThreads({ skipFailed: true })
          void flushQueue(address)
        }
      }
    },

    retryQueuedSend: async () => {
      const address = selectedSendAddress(get())
      if (!address) return
      const key = sendKey(address)
      const first = get().queuedSends[key]?.[0]
      if (!first?.error || first.sending || first.saving || editingQueue.has(first.id) || savingQueue.has(first.id)
        || submitting.has(key) || !get().eventsConnected) return
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      submitting.add(key)
      try {
        const session = await withSession(address.targetId, address.agent, navigation)
        if (!session) return
        const { thread } = address.agent === 'codex'
          ? await resumeThread(session.rpc, address.threadId)
          : await readThread(session.rpc, address.threadId)
        if (epoch !== desktopEpoch || navigation !== navigationEpoch || first.id !== get().queuedSends[key]?.[0]?.id) return
        if (address.agent === 'codex') session.resumedCodexThreads.add(address.threadId)
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, thread) }), session)
      } catch (err) {
        if (epoch === desktopEpoch && navigation === navigationEpoch) set({ error: friendlyError(err, '无法恢复队列') })
        return
      } finally {
        if (epoch === desktopEpoch) submitting.delete(key)
      }
      await flushQueue(address, true)
    },

    interrupt: async () => {
      const { selectedTargetId, selectedThreadId, selectedAgent, sessions } = get()
      if (!selectedTargetId || !selectedThreadId) return
      const session = sessions[sessionKey(selectedTargetId, selectedAgent)]
      const turnId = session?.state.threads[selectedThreadId]?.activeTurnId
      if (session && turnId) await interruptTurn(session.rpc, selectedThreadId, turnId)
    },

    respondApproval: async (requestId, decision) => {
      const { selectedTargetId, selectedThreadId, selectedAgent, sessions, approvalSubmitting } = get()
      const submittingKey = String(requestId)
      if (!selectedTargetId || !selectedThreadId || approvalSubmitting[submittingKey]) return false
      const session = sessions[sessionKey(selectedTargetId, selectedAgent)]
      const approval = session?.state.threads[selectedThreadId]?.pendingApprovals.find((item) => item.requestId === requestId)
      if (!session || !approval) {
        set({ notice: '该审批已处理或失效' })
        return false
      }
      if (!availableApprovalDecisions(approval, selectedAgent).includes(decision)) {
        set({ error: '当前请求不支持该审批选项' })
        return false
      }
      const flights = approvalFlights.get(session.transport) ?? new Map<RequestId, string>()
      if (flights.has(requestId)) return false
      flights.set(requestId, selectedThreadId)
      approvalFlights.set(session.transport, flights)
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      let acknowledged = false
      set({ approvalSubmitting: { ...approvalSubmitting, [submittingKey]: true }, error: null })
      try {
        if (reconnectTask) await reconnectTask
        if (epoch !== desktopEpoch || navigation !== navigationEpoch) return false
        const pending = get().sessions[session.key]?.state.threads[selectedThreadId]?.pendingApprovals
        if (!pending?.some((item) => item.requestId === requestId)) return false
        await session.transport.respond(approval.requestId, mobileApprovalReply(approval, decision))
        acknowledged = true
        // HTTP 仅确认网关收到响应，桌面也可能先处理，等待 Agent 的 resolved 广播。
        return true
      } catch (err) {
        if (epoch !== desktopEpoch || navigation !== navigationEpoch) return false
        const pending = get().sessions[session.key]?.state.threads[selectedThreadId]?.pendingApprovals
        if (!pending?.some((item) => item.requestId === requestId)) return true
        set({ error: friendlyError(err, '提交审批失败') })
        return false
      } finally {
        if (!acknowledged) {
          flights.delete(requestId)
          const current = get()
          if (epoch === desktopEpoch && current.selectedTargetId === selectedTargetId
            && current.selectedAgent === selectedAgent && current.selectedThreadId === selectedThreadId) {
            const updated = { ...current.approvalSubmitting }
            delete updated[submittingKey]
            set({ approvalSubmitting: updated })
          }
        }
      }
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
      const isCurrent = () => get().sessions[key]?.transport === session.transport
      set((state) => ({
        models: { ...state.models, [key]: { models: current?.models ?? [], loading: true, error: null } },
      }))
      try {
        const models = toModelOptions(await listModels(session.rpc))
        if (!isCurrent()) return
        set((state) => ({
          models: { ...state.models, [key]: { models, loading: false, error: null, loadedAt: Date.now() } },
        }))
      } catch (err) {
        if (!isCurrent()) return
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
      const { activeId, modelPrefs } = get()
      if (!activeId) return
      const next = { ...modelPrefs, [sessionKey(targetId, agent)]: prefs }
      set({ modelPrefs: next })
      desktopModelPrefs[activeId] = next
      saveRecord(STORAGE_DESKTOP_MODEL_PREFS, desktopModelPrefs)
    },

    refreshRateLimits: async (targetId) => {
      const busy = rateRefresh.get(targetId)
      if (busy) return busy
      const session = get().sessions[sessionKey(targetId, 'codex')]
      if (!session?.opened) return
      const epoch = desktopEpoch
      patchRate(targetId, { loading: true })
      const task = (async () => {
        try {
          // 账号读取失败不应挡住额度显示，两个请求彼此独立。
          const [limits, account] = await Promise.allSettled([
            session.rpc.request('account/rateLimits/read', {}),
            session.rpc.request('account/read', {}),
          ])
          if (epoch !== desktopEpoch) return
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
          if (epoch === desktopEpoch) patchRate(targetId, { loading: false, error: friendlyError(err, '读取额度失败') })
        } finally {
          if (epoch === desktopEpoch) rateRefresh.delete(targetId)
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
      const key = currentDraftKey()
      if (!value || !key) return
      const { draftText, annotations } = get()
      saveDraft(key, { text: draftText, annotations: [...annotations, { id: makeId(), quote: value, comment }] })
    },

    updateAnnotation: (id, comment) => {
      const key = currentDraftKey()
      if (!key) return
      const { draftText, annotations } = get()
      saveDraft(key, { text: draftText, annotations: annotations.map((item) => (item.id === id ? { ...item, comment } : item)) })
    },

    removeAnnotation: (id) => {
      const key = currentDraftKey()
      if (!key) return
      const { draftText, annotations } = get()
      saveDraft(key, { text: draftText, annotations: annotations.filter((item) => item.id !== id) })
    },

    handleGatewayEvent: (event) => {
      if (isHeartbeat(event)) return
      switch (event.name) {
        case 'mobile.terminal': {
          const desktopId = get().activeId
          if (desktopId) deliverTerminalEvent(desktopId, event.payload)
          return
        }
        case 'target.state': {
          const payload = event.payload
          set((state) => ({ targetStates: applyTargetState(state.targetStates, payload) }))
          const record = isRecord(payload) ? payload : null
          const id = typeof record?.id === 'string' ? record.id : ''
          if (!id) return
          if (record?.state !== 'ready') {
            const desktopId = get().activeId
            if (desktopId) pauseQueues([desktopId, id], '目标连接中断，队列已暂停')
            // 链路断过之后 agent 进程可能已经换了，下次操作必须重新 codex.open。
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== id) continue
              session.loadedThreads.clear()
              session.resumedCodexThreads.clear()
              if (session.opened) patchSession(session.key, (value) => ({ ...value, opened: false }))
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
            const desktopId = get().activeId
            if (desktopId) {
              pauseQueues(agent ? [desktopId, targetId, agent] : [desktopId, targetId], 'Agent 已退出，队列已暂停')
            }
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== targetId || (agent !== null && session.agent !== agent)) continue
              session.loadedThreads.clear()
              session.resumedCodexThreads.clear()
              clearPendingApprovals(session)
              patchSession(session.key, (value) => ({
                ...value,
                state: failActiveThreads(value.state, `${agentLabel(value.agent)} 进程已退出`),
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
        case 'unauthorized': {
          const id = get().activeId
          if (id) markRepair(id, 'unauthorized', '设备已被撤销，请重新配对')
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
        leaveChat()
        return true
      }
      if (page === 'threads') {
        const page = get().threadsReturnPage
        beginNavigation()
        set({
          page,
          ...(page === 'workspace' ? { selectedTargetId: null } : {}),
          selectedProjectId: null,
          selectedThreadId: null,
        })
        return true
      }
      if (page === 'projects') {
        beginNavigation()
        set({ page: get().projectsReturnPage, selectedTargetId: null, directory: null })
        return true
      }
      if (page === 'targets') {
        beginNavigation()
        set({ page: get().targetsReturnPage })
        return true
      }
      if (page === 'workspace') {
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
