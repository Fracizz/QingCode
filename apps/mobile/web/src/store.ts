// 手机端全局状态：连接、目标、项目、会话（按目标 + Agent）、对话、模型、文件查看、额度与事件流。IO 全部经 Gateway 注入。
import {
  applyBackgroundTaskList,
  applyEarlierPlan,
  applyNotification,
  applyRateLimitsUpdate,
  applyServerRequest,
  archiveThread,
  claudeQuotaBlocked,
  CodexRpc,
  completedPlanExit,
  createResetCreditRedeemer,
  createDeltaBuffer,
  emptyState,
  failActiveThreads,
  interruptTurn,
  interruptTurnIdOf,
  isStreamDelta,
  isOversizeHistoryResponse,
  isSteerRejected,
  branchPoint,
  canReviseMessage,
  turnOpeningMessages,
  isThreadOutcome,
  listBackgroundTasks,
  listModels,
  listThreads,
  loadRecentThreadHistory,
  loadThread,
  noteTurnConfig,
  turnModelNote,
  openThreadHistory,
  pickAccount,
  pickAccountUsage,
  pickClaudeSnapshot,
  pickResetCredits,
  pickSnapshot,
  planSteer,
  prependThreadHistory,
  readEarlierPlan,
  readThread,
  readThreadHistoryPage,
  resolveServerRequest,
  resolveAccessMode,
  sendInput,
  sessionAccessOptions,
  setThreadName,
  startThread,
  inheritedModelPrefs,
  startThreadCompaction,
  STEER_ECHO_GRACE_MS,
  steerOutcome,
  steerTurn,
  stopBackgroundTask,
  stripAttachmentPlaceholders,
  supportsMcpStatus,
  userAnswerResponse,
  type ApprovalView,
  AGENT_CAPABILITIES,
  CodexRpcError,
  type AccessSelection,
  type ItemView,
  type SessionAccessMode,
  type SessionAccessSelection,
  type AccountSummary,
  type AccountUsage,
  type ClaudeRateLimitSnapshot,
  type ConversationState,
  type RateLimitSnapshot,
  type RequestId,
  type ResetCreditNotice,
  type ResetCredits,
  type SendMode,
  type ServerNotification,
  type ServerRequest,
  type Thread,
  type TurnOverrides,
  type UserInput,
  t,
  translateMessage,
} from '@qn/codex-client'
import {
  ACCESS_PREFS_STORAGE_KEY,
  accessPreferenceKey,
  accessSelectionOf,
  latestPlanExit,
  leavePlanPreference,
  restoreAccessPrefs,
  selectAccess,
  type AccessAddress,
  type AccessPref,
  type AccessPrefs,
} from './accessPrefs'
import { create } from 'zustand'
import {
  AGENTS,
  agentLabel,
  archivedThreadKey,
  DEFAULT_AGENT,
  enabledAgents,
  exitedAgent,
  isAgentKind,
  mergeThreadSummaries,
  parseMobileAgents,
  pickDefaultAgent,
  recvSessionKey,
  sessionKey,
  threadKey,
  type MobileAgentSettings,
} from './agents'
import { callDevice, getGateway, isMockGateway } from './client'
import type { DraftImage } from './composerLogic'
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
  overridesFor,
  parsePrefs,
  prefsFor,
  putThreadPrefs,
  EMPTY_PREFS,
  resolveSelection,
  threadPrefsKey,
  toModelOptions,
  triggerLabel,
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
import { applyRelayResult, mobileTurnFits, queuedInput, QUEUE_STORAGE_KEY, releaseRelayedSends, relayRequest, restoreQueues, serializeQueues, UNCONFIRMED_QUEUED_SEND, type MobileTurnAccess, type QueuedSend } from './queuedSends'
import { deliverTerminalEvent } from './terminalEvents'
import { echoedSteerIds, withoutPendingSteers, withPendingSteer, type PendingSteer, type SteerRecord } from './pendingSteers'
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
    /** 原生壳在 Activity 暂停（锁屏、切走）时调用：后台连接开启时 WebView 不暂停，页面可能仍是 visible。 */
    __qnPause?: () => void
  }
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STORAGE_CONNECTIONS = 'connections'
/** 连接失败信息看起来像认证失败（密码错/过期）时，重新弹密码框。 */
const AUTH_ERROR_RE = /auth|认证|密码|password/i
const STORAGE_ACTIVE = 'active'
const STORAGE_MODEL_PREFS = 'modelPrefs'
const STORAGE_DESKTOP_MODEL_PREFS = 'desktopModelPrefs'
const STORAGE_DRAFTS = 'chatDrafts'
const STORAGE_SAVED_CHATS = 'savedChats'
const STORAGE_ARCHIVED_THREADS = 'archivedThreads'
const REFRESH_INTERVAL_MS = 60_000
// pi 等 Agent 在会话进程启动前返回空模型列表，空列表隔一段时间允许重取。
const EMPTY_MODELS_RETRY_MS = 15_000
const DEVICE_NAME = t('QingCode Next 手机')
const FINGERPRINT_MISMATCH_HINT =
  t('地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息')

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
  /** Codex 账号级 token 总用量，仅在用户打开详情或点刷新时读取。 */
  usage?: AccountUsage | null
  usageLoading?: boolean
  usageError?: string | null
  usageUpdatedAt?: number | null
  /** Codex 重置卡与最近一次兑换结果。 */
  resetCredits?: ResetCredits | null
  resetting?: boolean
  resetNotice?: ResetCreditNotice | null
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
  linkInterrupted?: boolean
  accessSupported?: boolean
  mcpStatusSupported?: boolean
  activeTurnAccess?: Record<string, { turnId: string; mode: SessionAccessMode }>
  opening: boolean
  openError: string | null
  openErrorCode?: string
  lastSeq: number | null
}

/** 只读查看页：文件（fs.read）或改动卡片自带的差异。手机版不提供 Git 差异。 */
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
  diffSource: 'card' | null
  diffTruncated: boolean
  notice: string | null
}

export type DiffRequest = { path: string; diff?: string | null }
export type { SendMode }
export type QueuedThreadMode = 'start' | 'continue'

type SendAddress = AccessAddress

type DiscoveredThread = ThreadSummary & { targetId: string; projectId: string }

type WorkspaceProject = {
  project: Project
  projects: Project[]
  threads: ThreadSummary[]
}

type AppState = {
  page: Page
  unanimatedNavigation: number
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
  /** 设置尚未读取时只用 Codex。 */
  agentSettings: MobileAgentSettings | null
  legacyAgentSettings: boolean
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
  threadAccessModes: AccessPrefs
  models: Record<string, ModelList>
  modelPrefs: Record<string, ModelPrefs>
  rateLimits: Record<string, RateLimitEntry>
  claudeRateLimits: Record<string, ClaudeRateLimitSnapshot>
  claudeCosts: Record<string, number>
  viewer: ViewerState | null
  annotations: Annotation[]
  draftText: string
  draftImages: readonly DraftImage[]
  approvalSubmitting: Record<string, boolean>
  sending: boolean
  compactingThreads: Record<string, true>
  queuedSends: Record<string, QueuedSend[]>
  /** 已发出、等待 Agent 回显的引导消息，按 sendKey 分组，仅存内存。 */
  pendingSteers: Record<string, PendingSteer[]>
  backgroundConnectionEnabled: boolean
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
  activate: (id: string, page?: 'workspace' | 'targets', options?: { startup?: boolean }) => Promise<void>
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
  attachOpened: (targetId?: string) => Promise<void>
  /** skipFailed：后台刷新（如 turn 完成后）不重试已确认打不开的 Agent，避免反复拉起。 */
  refreshThreads: (options?: { skipFailed?: boolean }) => Promise<void>
  discoverWorkspaceSessions: (projects: readonly Project[]) => Promise<DiscoveredThread[]>
  newThread: (agent?: AgentKind, workspace?: WorkspaceProject) => Promise<boolean>
  openThread: (id: string, agent?: AgentKind, workspace?: WorkspaceProject, options?: { restoring?: boolean }) => Promise<boolean>
  loadEarlierHistory: (beforeApply: () => void) => Promise<void>
  archiveConversation: (targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>) => Promise<void>
  listArchivedConversations: (project: Project) => Promise<{ threads: ThreadSummary[]; error: string | null }>
  restoreConversation: (targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>) => Promise<void>
  /** 返回 'local' 表示目标机不支持原生重命名，由调用方记在本机。 */
  renameConversation: (targetId: string, threadId: string, name: string, agent?: AgentKind) => Promise<'native' | 'local'>
  compactConversation: () => Promise<boolean>
  /** 分叉并打开新会话；给出 lastTurnId 时只保留到该轮（含）。返回是否已切到新会话。 */
  forkConversation: (lastTurnId?: string) => Promise<boolean>
  /**
   * 编辑并重发一条用户消息，与电脑版 sendRevision 一致：能回退的 Agent（Codex）在原会话截掉这一轮及之后的历史再发送；
   * 只能分支的（Claude、pi）从上一轮分出新会话发送，原会话保留。文本不变时就是原样重发。
   */
  sendRevision: (itemId: string, text: string, attachments: UserInput[]) => Promise<boolean>
  setDraftText: (text: string, images?: readonly DraftImage[]) => void
  setAccessMode: (mode: SessionAccessSelection) => void
  /** 读取当前会话轮次外仍在运行的后台任务（打开会话或重连后）。 */
  refreshBackgroundTasks: () => Promise<void>
  /** 停止当前会话的一个后台任务；返回是否已提交。 */
  stopBackgroundTask: (taskId: string) => Promise<boolean>
  send: (text: string, attachments?: UserInput[], delegate?: boolean, mode?: SendMode, options?: { keepDraft?: boolean }) => Promise<boolean>
  removeQueuedSend: (id: string) => void
  beginQueuedEdit: (id: string) => ((resume?: boolean) => void) | null
  editQueuedSend: (id: string, text: string) => Promise<boolean>
  steerQueuedSend: (id: string) => Promise<boolean>
  /** 插入：打断当前一轮后立即发送这条排队消息，其余消息继续排队。 */
  interruptQueuedSend: (id: string) => Promise<boolean>
  dropPendingSteers: (ids: string[]) => void
  sendQueuedInNewThread: (id: string, mode: QueuedThreadMode) => Promise<boolean>
  retryQueuedSend: () => Promise<void>
  interrupt: () => Promise<void>
  respondApproval: (requestId: RequestId, decision: MobileApprovalDecision) => Promise<boolean>
  /** 回答 Agent 的提问（item/tool/requestUserInput）；answers 为空对象表示跳过。 */
  respondUserInput: (requestId: RequestId, answers: Record<string, string[]>) => Promise<boolean>
  loadModels: (targetId: string, agent: AgentKind, force?: boolean) => Promise<void>
  /** 带 threadId 时只改该会话；不带（草稿）时改 agent 默认，作为之后新会话的初始选择。 */
  /** 用户手动改选：更新新会话默认；带 threadId 时同时记到该会话。 */
  setModelPrefs: (targetId: string, agent: AgentKind, prefs: ModelPrefs, threadId?: string | null) => void
  /** 只把选择固定到会话上（发送时使用），不改默认。 */
  rememberThreadPrefs: (targetId: string, agent: AgentKind, threadId: string, prefs: ModelPrefs) => void
  refreshRateLimits: (targetId: string) => Promise<void>
  refreshClaudeRateLimits: (targetId: string) => Promise<boolean>
  refreshAccountUsage: (targetId: string) => Promise<void>
  /** 兑换一张 Codex 重置卡，只能在用户确认后调用；creditId 为 null 时由 Codex 选卡。 */
  consumeResetCredit: (targetId: string, creditId: string | null) => Promise<void>
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

/** 某会话当前生效的模型偏好：本机记录 > 会话历史配置 > agent 默认；threadId 为 null 表示草稿。 */
export function modelPrefsOf(state: AppState, targetId: string, agent: AgentKind, threadId: string | null): ModelPrefs {
  const sessionId = sessionKey(targetId, agent)
  const saved = threadId ? state.sessions[sessionId]?.state.threads[threadId]?.savedConfig : undefined
  return prefsFor(state.modelPrefs, agent, sessionId, threadId, state.models[sessionId]?.models, saved)
}

export function selectedQueuedSends(state: AppState): QueuedSend[] | undefined {
  const address = selectedSendAddress(state)
  return address ? state.queuedSends[sendKey(address)] : undefined
}

export function selectedPendingSteers(state: AppState): PendingSteer[] | undefined {
  const address = selectedSendAddress(state)
  return address ? state.pendingSteers[sendKey(address)] : undefined
}

function storedAccess(state: AppState, address: SendAddress): AccessPref | undefined {
  const connection = state.connections.find((item) => item.id === address.desktopId)
  return connection && state.threadAccessModes[accessPreferenceKey(address, connection.fp)]
}

function accessPreference(state: AppState, address: SendAddress): SessionAccessSelection | undefined {
  return accessSelectionOf(storedAccess(state, address))
}

export function selectedAccessPreference(state: AppState): SessionAccessSelection | undefined {
  const address = selectedSendAddress(state)
  return address ? accessPreference(state, address) : undefined
}

/** 退出计划模式后应恢复的选择。 */
export function selectedPlanReturn(state: AppState): AccessSelection {
  const address = selectedSendAddress(state)
  const pref = address ? storedAccess(state, address) : undefined
  return typeof pref === 'object' ? pref.back : 'inherit'
}

export function selectedAccessMode(state: AppState): SessionAccessMode {
  return resolveAccessMode(state.selectedAgent, state.agentSettings?.globalAccessMode, selectedAccessPreference(state))
}

function mobileTurnAccess(state: AppState, agent: AgentKind, selection: SessionAccessSelection = 'inherit'): MobileTurnAccess {
  const globalMode = state.agentSettings?.globalAccessMode
  const accessMode = resolveAccessMode(agent, globalMode, selection)
  const managed = agent !== 'pi' && ((selection === 'inherit' && globalMode !== undefined)
    || (selection === 'default' && !state.legacyAgentSettings))
  return { accessMode, ...(managed ? { inheritAccess: selection === 'inherit' } : {}) }
}

export function displayedAccessMode(state: AppState): SessionAccessMode {
  const address = selectedSendAddress(state)
  if (!address) return 'default'
  const session = state.sessions[sessionKey(address.targetId, address.agent)]
  const active = session?.activeTurnAccess?.[address.threadId]
  if (active && active.turnId === session?.state.threads[address.threadId]?.activeTurnId) return active.mode
  return selectedAccessMode(state)
}

function supportsMobileAccess(result: unknown): boolean {
  return isRecord(result) && result.mobileAccessModes === true
}

export function selectedCompactionStarting(state: AppState): boolean {
  const address = selectedSendAddress(state)
  return !!address && !!state.compactingThreads[sendKey(address)]
}

export function selectedCompactionBlockedReason(state: AppState): string | null {
  const address = selectedSendAddress(state)
  if (!address) return t('请先打开会话')
  if (!state.eventsConnected) return t('连接电脑后可压缩会话')
  const session = state.sessions[sessionKey(address.targetId, address.agent)]
  const thread = session?.state.threads[address.threadId]
  if (!session?.opened || !thread) return t('请先打开会话')
  if (selectedCompactionStarting(state)) return t('正在启动压缩…')
  if (thread.status === 'running' && thread.items.some((item) => item.kind === 'other' &&
    item.type === 'contextCompaction' && item.status === 'inProgress')) return t('正在压缩会话…')
  if (selectedQueuedSends(state)?.some((item) => item.compact)) return t('压缩已在排队')
  if (address.agent === 'claude' && claudeQuotaBlocked(state.claudeRateLimits[address.targetId])) return t('当前额度已用完')
  const quota = address.agent === 'codex' ? state.rateLimits[address.targetId]?.snapshot : null
  if (quota?.rateLimitReachedType || quota?.spendControlReached) return t('当前额度已用完')
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
    agent === 'codex' ? t('Codex 未就绪，请确认目标已连接') : t('{agent} 打开失败，请确认目标机已安装并登录', { agent: agentLabel(agent) }),
  )

const isTargetDisconnected = (err: unknown): boolean =>
  errorCode(err) === 'not_connected' || (isRecord(err) && errorCode(err.data) === 'not_connected')

let initialized = false
let controller: EventStreamController | null = null
let refreshToken = 0
let viewerToken = 0
const opening = new Map<string, Promise<boolean>>()
const rateRefresh = new Map<string, Promise<void>>()
const redeemResetCredit = createResetCreditRedeemer(makeId)
const usageRefresh = new Map<string, Promise<void>>()
const ACCOUNT_USAGE_MIN_INTERVAL_MS = 60_000
const OPEN_THREAD_TIMEOUT_MS = 30_000
/** 打开会话时等待事件流恢复的上限（整体仍受 OPEN_THREAD_TIMEOUT_MS 约束）。 */
const EVENTS_WAIT_MS = 15_000
const EVENTS_UNAVAILABLE_MESSAGE = t('暂时无法连接电脑，正在自动重试。')

/** 页面重载前关闭原生层事件流，否则旧连接会一直留到应用退出。 */
export function releaseEventStream(): void {
  controller?.stop()
}

type ArchiveListener = (desktopId: string, targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>) => void
const archiveListeners = new Set<ArchiveListener>()

/**
 * 会话归档成功（本机操作或目标机通知）时回调。Claude/pi 的归档只记在目标机，
 * 手机不再保留本地标记，首页缓存等派生列表需借此移除对应会话。
 */
export function onThreadArchived(listener: ArchiveListener): () => void {
  archiveListeners.add(listener)
  return () => { archiveListeners.delete(listener) }
}

type ServerEvtListener = (desktopId: string, targetId: string, name: string, payload: unknown) => void
const serverEvtListeners = new Set<ServerEvtListener>()

/** 订阅当前电脑转发来的目标机 server evt（如共享未读 thread.unread）。 */
export function onServerEvt(listener: ServerEvtListener): () => void {
  serverEvtListeners.add(listener)
  return () => { serverEvtListeners.delete(listener) }
}

type ComposerDraft = ChatDraft & { images?: readonly DraftImage[] }

export const useApp = create<AppState>((set, get) => {
  let desktopEpoch = 0
  let agentSettingsRequest = 0
  let eventStreamEpoch = 0
  let navigationEpoch = 0
  const beginNavigation = (openingThread: SendAddress | null = null): number => {
    const navigation = ++navigationEpoch
    if (get().openingThread !== openingThread) set({ openingThread })
    return navigation
  }
  let drafts: Record<string, ComposerDraft> = {}
  const photoDraftKeys = new Set<string>()
  const noImages: readonly DraftImage[] = []
  let savedChats: Record<string, SavedChat> = {}
  let pendingRestore: SavedChat | null = null
  let restoreTask: Promise<void> | null = null
  let reconnectTask: Promise<void> | null = null
  const targetLinkEpochs = new Map<string, number>()
  const claudeQuotaEpochs = new Map<string, number>()
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
  // 已交给电脑网关代发的会话队列：期间手机不再自己发送，回到前台时收回。
  const remoteQueues = new Set<string>()
  const handingOff = new Set<string>()
  let takeBackTask: Promise<void> | null = null
  let appPaused = false
  /** 已提交、待确认送达的引导，按 clientUserMessageId 记录，仅存内存。 */
  const steers = new Map<string, SteerRecord>()
  /** 已处理过退出计划模式的条目，避免回放或历史读取时又改掉用户之后的选择。 */
  const handledPlanExits = new Set<string>()

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

  const saveAccessPrefs = (threadAccessModes: AccessPrefs): void => {
    set({ threadAccessModes })
    const gateway = getGateway()
    const json = JSON.stringify(threadAccessModes)
    void queueStorageWrite(ACCESS_PREFS_STORAGE_KEY, () => gateway.storageSet(ACCESS_PREFS_STORAGE_KEY, json))
      .catch(() => {
        if (get().threadAccessModes === threadAccessModes) {
          set({ notice: t('无法保存权限设置，本次修改在手机重启后可能丢失。') })
        }
      })
  }

  const clearDesktopAccessPrefs = (desktopId: string): void => {
    const prefix = `[${JSON.stringify(desktopId)},`
    const entries = Object.entries(get().threadAccessModes)
    const remaining = entries.filter(([key]) => !key.startsWith(prefix))
    if (remaining.length !== entries.length) saveAccessPrefs(Object.fromEntries(remaining))
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
    set({ draftText: value?.text ?? '', draftImages: value?.images ?? noImages, annotations: value?.annotations ?? [], approvalSubmitting })
  }

  const persistDrafts = (): void => {
    // 图片只留在进程内，重启恢复的文字也应去掉这些图片的标签。
    const stored = Object.fromEntries(Object.entries(drafts).flatMap(([key, { text, annotations, images }]) => {
      const body = images?.length ? stripAttachmentPlaceholders(text, images) : text
      return body || annotations.length ? [[key, { text: body, annotations }]] : []
    }))
    saveRecord(STORAGE_DRAFTS, stored)
  }

  const saveDraft = (key: string, draft: ComposerDraft): void => {
    if (draft.text || draft.annotations.length || draft.images?.length) drafts[key] = draft
    else delete drafts[key]
    photoDraftKeys.delete(key)
    if (draft.images?.length) photoDraftKeys.add(key)
    if (photoDraftKeys.size > 12) {
      const oldest = photoDraftKeys.values().next().value!
      const { text, annotations, images } = drafts[oldest]!
      const body = stripAttachmentPlaceholders(text, images ?? noImages)
      if (body || annotations.length) drafts[oldest] = { text: body, annotations }
      else delete drafts[oldest]
      photoDraftKeys.delete(oldest)
    }
    persistDrafts()
    if (currentDraftKey() === key) set({ draftText: draft.text, draftImages: draft.images ?? noImages, annotations: draft.annotations })
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

  /** 刚建好、还没发过消息的会话，按 sendKey 记录请求时的项目目录。 */
  const freshThreads = new Map<string, string>()
  /** 已发出首条消息、服务端列表还没返回的会话；列表查到后移除。 */
  const localThreads = new Map<string, { address: SendAddress; summary: ThreadSummary }>()

  /** 首轮结束前 thread/list 可能查不到新会话，发送首条消息时先用本地摘要占位，列表能立即看到。 */
  const rememberLocalThread = (address: SendAddress, input: UserInput[]): void => {
    const key = sendKey(address)
    const cwd = freshThreads.get(key)
    if (cwd === undefined) return
    freshThreads.delete(key)
    const text = input.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n').trim()
    // 引用批注排在正文前面，标题优先取正文首行。
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    const now = Date.now()
    const summary: ThreadSummary = {
      id: address.threadId, agent: address.agent, cwd, preview: text.slice(0, 160),
      title: lines.find((line) => !line.startsWith('>')) ?? lines[0] ?? t('未命名会话'),
      createdAt: now, updatedAt: now,
    }
    localThreads.set(key, { address, summary })
    const state = get()
    if (state.activeId !== address.desktopId || state.selectedTargetId !== address.targetId || currentCwd(state) !== cwd) return
    if (state.threads.some((item) => item.id === summary.id && item.agent === summary.agent)) return
    set({ threads: mergeThreadSummaries([[summary], state.threads]) })
  }

  /** 把本地占位补进服务端列表；服务端已返回的以服务端为准。 */
  const withLocalThreads = (desktopId: string, targetId: string, cwd: string | undefined, listed: ThreadSummary[]): ThreadSummary[] => {
    const known = new Set(listed.map((item) => threadKey(item.agent, item.id)))
    const missing: ThreadSummary[] = []
    for (const [key, { address, summary }] of localThreads) {
      if (address.desktopId !== desktopId || address.targetId !== targetId) continue
      if (known.has(threadKey(summary.agent, summary.id))) localThreads.delete(key)
      else if (cwd === undefined || summary.cwd === cwd) missing.push(summary)
    }
    return missing.length ? mergeThreadSummaries([missing, listed]) : listed
  }

  const renameLocalThread = (targetId: string, agent: AgentKind, threadId: string, title: string): void => {
    for (const entry of localThreads.values()) {
      if (entry.address.targetId === targetId && entry.summary.agent === agent && entry.summary.id === threadId) {
        entry.summary = { ...entry.summary, title }
      }
    }
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
    localThreads.delete(sendKey({ desktopId, targetId, agent: thread.agent, threadId: thread.id }))
    const matches = (chat: SavedChat | null | undefined) =>
      chat?.targetId === targetId && chat.agent === thread.agent && chat.threadId === thread.id
    const current = get()
    const connection = current.connections.find((item) => item.id === desktopId)
    if (connection) {
      const key = accessPreferenceKey({ desktopId, targetId, agent: thread.agent, threadId: thread.id }, connection.fp)
      if (key in current.threadAccessModes) {
        const next = { ...current.threadAccessModes }
        delete next[key]
        saveAccessPrefs(next)
      }
    }
    if (current.activeId === desktopId) {
      const key = sessionKey(targetId, thread.agent)
      const session = current.sessions[key]
      if (session?.activeTurnAccess?.[thread.id]) {
        const activeTurnAccess = { ...session.activeTurnAccess }
        delete activeTurnAccess[thread.id]
        patchSession(key, (value) => ({ ...value, activeTurnAccess }), session)
      }
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
    // Claude/pi 的归档存在目标机上，thread/list 已排除归档会话，手机不再另记一份。
    if (thread.agent === 'codex') {
      set({ archivedThreads: { ...get().archivedThreads, [key]: true } })
      persistArchives()
    }
    updateQueue(sendKey({ desktopId, targetId, agent: thread.agent, threadId: thread.id }), () => [])
    forgetArchivedChat(desktopId, targetId, thread)
    for (const listener of archiveListeners) listener(desktopId, targetId, thread)
  }

  /** 旧版只记在手机上的 Claude/pi 归档：补写到目标机后删掉本地记录，电脑端随之隐藏。 */
  const migrateLocalArchives = (desktopId: string, session: AgentSession, threads: readonly ThreadSummary[]): void => {
    for (const thread of threads) {
      const key = archivedThreadKey(desktopId, session.targetId, thread)
      if (!get().archivedThreads[key] || archiveFlights.has(key)) continue
      archiveFlights.add(key)
      void archiveThread(session.rpc, thread.id).then(() => {
        if (get().activeId !== desktopId) return
        const archivedThreads = { ...get().archivedThreads }
        delete archivedThreads[key]
        set({ archivedThreads })
        persistArchives()
      }).catch(() => undefined).finally(() => archiveFlights.delete(key))
    }
  }

  const conversationSession = async (targetId: string, agent: AgentKind, epoch: number) => {
    const ready = await get().ensureOpen(targetId, agent)
    if (epoch !== desktopEpoch) throw new Error(t('电脑连接已切换'))
    const session = get().sessions[sessionKey(targetId, agent)]
    if (!ready || !session) throw new Error(session?.openError ?? t('会话连接未就绪'))
    return session
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
    if (session.agent !== 'codex' && get().activeId === desktopId) migrateLocalArchives(desktopId, session, threads)
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

  const saveModelPrefs = (modelPrefs: Record<string, ModelPrefs>): void => {
    const { activeId } = get()
    if (!activeId) return
    set({ modelPrefs })
    desktopModelPrefs[activeId] = modelPrefs
    saveRecord(STORAGE_DESKTOP_MODEL_PREFS, desktopModelPrefs)
  }

  const removeSavedDesktopState = (id: string): void => {
    delete savedChats[id]
    delete desktopModelPrefs[id]
    for (const key of Object.keys(drafts)) {
      if (!key.startsWith(`[${JSON.stringify(id)},`)) continue
      delete drafts[key]
      photoDraftKeys.delete(key)
    }
    saveRecord(STORAGE_SAVED_CHATS, savedChats)
    saveRecord(STORAGE_DESKTOP_MODEL_PREFS, desktopModelPrefs)
    persistDrafts()
    clearArchivedThreads(id)
    clearDesktopAccessPrefs(id)
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
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      pauseQueues([id], '电脑需要重新配对，队列已暂停')
      controller?.stop()
    }
  }

  const markRepairError = (conn: Connection, epoch: number, err: unknown): void => {
    if (epoch !== desktopEpoch) return
    const active = activeConnection(get())
    if (active?.host !== conn.host || active.port !== conn.port || active.token !== conn.token) return
    const reason = connectionRepairReason(err)
    if (reason) markRepair(conn.id, reason, friendlyError(err, t('请重新配对电脑')))
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
        await get().openThread(chat.threadId, chat.agent, undefined, { restoring: true })
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
      set({ error: friendlyError(err, t('保存连接失败')) })
    }
  }

  // 每个会话对象各自缓冲流式增量（见 createDeltaBuffer），按 key 记录当前会话的缓冲；
  // 任何会话写入前先冲刷，保证写入顺序与到达顺序一致。
  const deltaBuffers = new Map<string, ReturnType<typeof createDeltaBuffer>>()

  const patchSession = (key: string, update: (session: AgentSession) => AgentSession, source?: AgentSession): void => {
    deltaBuffers.get(key)?.flush(key)
    writeSession(key, update, source)
  }

  const writeSession = (key: string, update: (session: AgentSession) => AgentSession, source?: AgentSession): void => {
    set((state) => {
      const session = state.sessions[key]
      if (!session || (source && session.transport !== source.transport)) return state
      const next = update(session)
      return next === session ? state : { sessions: { ...state.sessions, [key]: next } }
    })
  }

  /** 计划获批后切回选计划模式前的档位；服务端不发模式变化通知。 */
  const leavePlan = (address: SendAddress): void => {
    const connection = get().connections.find((item) => item.id === address.desktopId)
    if (!connection) return
    const prefs = get().threadAccessModes
    const next = leavePlanPreference(prefs, accessPreferenceKey(address, connection.fp))
    if (next === prefs) return
    saveAccessPrefs(next)
    // 本轮开始时记下的计划档位已经过期。
    patchSession(sessionKey(address.targetId, address.agent), (value) => {
      if (value.activeTurnAccess?.[address.threadId]?.mode !== 'plan') return value
      const activeTurnAccess = { ...value.activeTurnAccess }
      delete activeTurnAccess[address.threadId]
      return { ...value, activeTurnAccess }
    })
  }

  /** 离开期间电脑端批准过计划（没收到完成通知）时，读到的历史里会多出一条已完成的退出计划条目。 */
  const reconcilePlanExit = (address: SendAddress): void => {
    const pref = storedAccess(get(), address)
    if (typeof pref !== 'object') return
    const view = get().sessions[sessionKey(address.targetId, address.agent)]?.state.threads[address.threadId]
    const latest = latestPlanExit(view?.items)
    if (!latest || latest === pref.seenExit || handledPlanExits.has(latest)) return
    handledPlanExits.add(latest)
    leavePlan(address)
  }

  /** 计划模式下分出的新会话沿用计划模式，避免换了会话就按总控直接执行；items 为新会话继承到的历史。 */
  const carryPlanMode = (source: SendAddress, threadId: string, items: readonly ItemView[] | undefined): SessionAccessSelection | undefined => {
    const connection = get().connections.find((item) => item.id === source.desktopId)
    if (!connection || accessPreference(get(), source) !== 'plan') return undefined
    const key = accessPreferenceKey({ ...source, threadId }, connection.fp)
    saveAccessPrefs(selectAccess(get().threadAccessModes, key, 'plan', latestPlanExit(items)))
    return 'plan'
  }

  const readBackgroundTasks = async (session: AgentSession, threadId: string): Promise<void> => {
    const before = get().sessions[session.key]?.state.threads[threadId]?.backgroundTasks
    try {
      const tasks = await listBackgroundTasks(session.rpc, threadId)
      patchSession(session.key, (value) => {
        const state = applyBackgroundTaskList(value.state, threadId, tasks, before)
        return state === value.state ? value : { ...value, state }
      }, session)
    } catch {
      // 旧版目标服务没有这个方法，等实时通知即可。
    }
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
    void task.catch(() => set({ notice: t('无法写入本地发送队列，请检查手机存储') }))
    return task
  }

  function dropQueuedSend(key: string, id: string): Promise<void> {
    return updateQueue(key, (list) => {
      const first = list[0]
      const remaining = list.filter((item) => item.id !== id)
      if (first?.id === id && first.error && remaining[0]) {
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        remaining[0] = { ...remaining[0], error: remaining[0].error ?? '队列已暂停' }
      }
      return remaining
    })
  }

  /** Claude / pi 要等真正消费输入才回显引导，先留本地占位；Codex 收到即回显，不需要。 */
  function rememberPendingSteer(address: SendAddress, id: string, message: Pick<QueuedSend, 'text' | 'annotations' | 'attachments'>): void {
    if (address.agent === 'codex') return
    const items = get().sessions[sessionKey(address.targetId, address.agent)]?.state.threads[address.threadId]?.items ?? []
    const steer: PendingSteer = {
      id,
      text: formatQuotedMessage(message.annotations, message.text),
      attachments: message.attachments.length,
      sentAt: Date.now(),
    }
    if (echoedSteerIds([steer], items).length > 0) return
    set((state) => ({ pendingSteers: withPendingSteer(state.pendingSteers, sendKey(address), steer) }))
  }

  function trackSteer(address: SendAddress, clientId: string, turnId: string, message: SteerRecord['message']): SteerRecord {
    const record: SteerRecord = { address, clientId, turnId, message }
    steers.set(clientId, record)
    return record
  }

  function acceptSteer(record: SteerRecord): void {
    record.accepted = true
    rememberPendingSteer(record.address, record.clientId, record.message)
    // 轮次可能在回执到达前就结束了。
    scheduleSteerCheck(record.address)
  }

  const waitingSteers = (key: string): SteerRecord[] => [...steers.values()]
    .filter((record) => record.accepted && !record.restoredId && sendKey(record.address) === key)

  function scheduleSteerCheck(address: SendAddress): void {
    if (!waitingSteers(sendKey(address)).length) return
    const epoch = desktopEpoch
    setTimeout(() => { if (epoch === desktopEpoch) checkSteers(address) }, STEER_ECHO_GRACE_MS)
  }

  /** 停止时被撤回的引导不会回显：放回队首暂停，等用户确认，不自动重发。 */
  function checkSteers(address: SendAddress): void {
    const key = sendKey(address)
    // 队列在电脑上时不能改：收回的结果会覆盖队首的暂停原因。收回后会再判断一次。
    if (takeBackTask || remoteQueues.has(key) || handingOff.has(key)) return
    const { desktopId, targetId, agent, threadId } = address
    const sessionId = sessionKey(targetId, agent)
    deltaBuffers.get(sessionId)?.flush(sessionId)
    const view = get().sessions[sessionId]?.state.threads[threadId]
    const archived = isArchived(desktopId, targetId, { agent, id: threadId })
    const lost: SteerRecord[] = []
    for (const record of waitingSteers(key)) {
      // 归档会话的队列已清空，不再追踪。
      const outcome = archived ? 'delivered' : steerOutcome(view, record)
      if (outcome === 'delivered') steers.delete(record.clientId)
      else if (outcome === 'undelivered') lost.push(record)
    }
    if (!lost.length) return
    const restored = lost.map((record): QueuedSend => {
      record.restoredId = makeId()
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      return { ...record.message, id: record.restoredId, error: '引导消息未送达，检查后可继续发送' }
    })
    void updateQueue(key, (list) => [...restored, ...list])
    set((state) => ({
      pendingSteers: withoutPendingSteers(state.pendingSteers, key, lost.map((record) => record.clientId)),
      notice: t('引导消息未送达，已放回发送队列'),
    }))
  }

  /** 判定未送达之后又收到回显，说明已经送达，撤掉队列里的副本。 */
  function confirmLateSteer(notification: ServerNotification): void {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return
    const item = notification.params?.item
    if (item?.type !== 'userMessage') return
    const record = steers.get(item.clientId || item.id)
    if (!record?.restoredId) return
    steers.delete(record.clientId)
    void updateQueue(sendKey(record.address), (list) => list.filter((entry) => entry.id !== record.restoredId || entry.sending))
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

  function queueLimited(address: Pick<SendAddress, 'agent' | 'targetId'>): boolean {
    const state = get()
    if (address.agent === 'claude') return claudeQuotaBlocked(state.claudeRateLimits[address.targetId])
    const snapshot = address.agent === 'codex' ? state.rateLimits[address.targetId]?.snapshot : null
    return !!(snapshot?.rateLimitReachedType || snapshot?.spendControlReached)
  }

  function pendingQueueAddresses(desktopId: string): SendAddress[] {
    return Object.entries(get().queuedSends).flatMap(([key, items]) => {
      if (!items.length || items[0]?.error) return []
      const [owner, targetId, agent, threadId] = JSON.parse(key) as [string, string, AgentKind, string]
      return owner === desktopId ? [{ desktopId, targetId, agent, threadId }] : []
    })
  }

  function canSendInBackground(): boolean {
    return get().backgroundConnectionEnabled || typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  async function resumeCodexConversation(session: AgentSession, threadId: string, isCurrent = () => true): Promise<void> {
    const before = get().sessions[session.key]?.state.threads[threadId]
    const { thread, earlier } = await openThreadHistory(session.rpc, threadId, 'resume', isCurrent)
    if (!isCurrent()) return
    session.resumedCodexThreads.add(threadId)
    patchSession(session.key, (value) => ({
      ...value, state: loadRecentThreadHistory(value.state, thread, earlier, before),
    }), session)
  }

  async function startMessageTurn(
    session: AgentSession, address: SendAddress, input: UserInput[], overrides: TurnOverrides, selection?: SessionAccessSelection,
  ): Promise<void> {
    const { targetId, agent, threadId } = address
    const access = mobileTurnAccess(get(), agent, selection)
    const { accessMode, inheritAccess } = access
    const opened = get().sessions[session.key]
    if (accessMode !== 'default' && !opened?.accessSupported) {
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      throw new Error('电脑或目标服务暂不支持当前访问模式，请升级后重试')
    }
    if (!mobileTurnFits(targetId, agent, threadId, input, overrides, undefined, access)) {
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      throw new Error('消息和附件合计超过 1 MiB，请移除部分内容后再发送')
    }
    rememberLocalThread(address, input)
    const clientUserMessageId = makeId()
    // 与上一轮相比换了模型或强度时，在本轮消息前留一行提示（参考 Codex）。
    const models = get().models[session.key]?.models ?? []
    const modelNote = turnModelNote(agent, models, opened?.state.threads[threadId], overrides, clientUserMessageId,
      (config) => triggerLabel(resolveSelection(models, { ...EMPTY_PREFS, model: config.model, effort: config.effort })))
    const params = { threadId, input, clientUserMessageId, model: overrides.model || undefined, effort: overrides.effort || undefined,
      serviceTier: overrides.serviceTier, mobileAccessMode: access }
    const { turn } = accessMode === 'default' && inheritAccess === undefined
      ? await sendInput(session.rpc, threadId, input, overrides, clientUserMessageId)
      : await session.rpc.request('turn/start', params)
    if (modelNote && get().sessions[session.key]?.transport === session.transport) {
      patchSession(session.key, (value) => ({
        ...value, state: noteTurnConfig(value.state, threadId, modelNote.config, modelNote.notice),
      }), session)
      // 本轮配置记为 seen：之后历史回报的就是它，不会被当成另一端的改动。
      const recordKey = threadPrefsKey(session.key, threadId)
      const own = get().modelPrefs[recordKey]
      if (own) get().rememberThreadPrefs(targetId, agent, threadId, { ...own, seen: { ...modelNote.config } })
    }
    const current = get().sessions[session.key]
    if (current?.transport !== session.transport || completedTurns.get(session.transport)?.has(turn.id)) return
    // 极短的一轮可能先完成，轮次响应也可能已是终态。
    if (turn.status === 'inProgress') {
      // 由网关兜底时没有本轮的权限快照，等待设置刷新后再显示。
      if (inheritAccess !== undefined || (selection && selection !== 'inherit') || agent === 'pi' || get().legacyAgentSettings) {
        patchSession(session.key, (value) => ({
          ...value,
          activeTurnAccess: { ...value.activeTurnAccess, [threadId]: { turnId: turn.id, mode: accessMode } },
        }), session)
      }
      if (current.state.threads[threadId]?.activeTurnId === turn.id) return
    }
    const synthetic = {
      method: turn.status === 'inProgress' ? 'turn/started' : 'turn/completed',
      params: { threadId, turn },
    } as ServerNotification
    patchSession(session.key, (value) => ({ ...value, state: applyNotification(value.state, synthetic) }), session)
    // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
    if (turn.status === 'failed' || turn.status === 'interrupted') pauseQueue(sendKey(address), '上一轮未完成，队列已暂停')
  }

  /** 执行排到队首的压缩；返回时压缩轮次已经开始。 */
  async function startQueuedCompaction(session: AgentSession, address: SendAddress): Promise<void> {
    const key = sendKey(address)
    const epoch = desktopEpoch
    set((state) => ({ compactingThreads: { ...state.compactingThreads, [key]: true } }))
    try {
      await startThreadCompaction(session.rpc, address.threadId)
    } finally {
      if (epoch === desktopEpoch) {
        set((state) => {
          const compactingThreads = { ...state.compactingThreads }
          delete compactingThreads[key]
          return { compactingThreads }
        })
      }
    }
  }

  async function flushQueue(address: SendAddress, retry = false): Promise<void> {
    const { desktopId, targetId, agent, threadId } = address
    const state = get()
    const key = sendKey(address)
    const next = state.queuedSends[key]?.[0]
    const session = state.sessions[sessionKey(targetId, agent)]
    const view = session?.state.threads[threadId]
    if (state.activeId !== desktopId || !next || (!retry && next.error)) return
    if (takeBackTask) {
      void takeBackTask.then(() => flushQueue(address, retry), () => undefined)
      return
    }
    if (remoteQueues.has(key) || handingOff.has(key)) return
    if (next.relayPending || next.sending || next.saving || submitting.has(key) || state.compactingThreads[key]
      || editingQueue.has(next.id) || savingQueue.has(next.id)
      || isArchived(desktopId, targetId, { agent, id: threadId })) return
    if (!session?.opened || session.linkInterrupted || !state.eventsConnected || reconnectTask || !view || !canSendInBackground()) return
    if (queueLimited(address)) {
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      pauseQueue(key, '当前额度已用完，队列已暂停')
      return
    }
    if (view.status === 'running') {
      if (retry) updateQueue(key, (list) => list.map((item) => item.id === next.id ? { ...item, error: undefined } : item))
      return
    }
    if (!retry && (view.status !== 'idle' || view.activity === 'interrupted')) {
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      pauseQueue(key, '上一轮未完成，队列已暂停')
      return
    }

    const epoch = desktopEpoch
    const streamEpoch = eventStreamEpoch
    submitting.add(key)
    let preparing = false
    let submitted = false
    const readyToSend = (): boolean => {
      if (!get().eventsConnected || reconnectTask || !canSendInBackground()) return false
      const current = get().sessions[session.key]
      if (!current?.opened || current.linkInterrupted || current.transport !== session.transport) return false
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      if (queueLimited(address)) throw new Error('当前额度已用完，队列已暂停')
      const thread = current.state.threads[threadId]
      if (thread?.status === 'running') return false
      if (!retry && (thread?.status !== 'idle' || thread.activity === 'interrupted')) {
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
        // 升级前的队列可能只有消息快照，显式修改会话权限后即以新设置为准。
        const mode = accessPreference(get(), address) ?? next.accessMode
        if (next.compact) await startQueuedCompaction(session, address)
        else await startMessageTurn(session, address, queuedInput(agent, next), next.overrides, mode)
        if (epoch === desktopEpoch) void dropQueuedSend(key, next.id)
      }
    } catch (err) {
      if (epoch === desktopEpoch) {
        const streamChanged = streamEpoch !== eventStreamEpoch
        const code = isRecord(err) ? errorCode(err.data) : ''
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        const message = friendlyError(err, next.compact ? '压缩会话失败' : '排队消息未发送')
        const replyLost = code === 'network' || code === 'timeout' || message.startsWith('Codex request timed out:')
        // turn/start 的回包不参加事件回放，发出后丢失回包可能已经在电脑执行。
        const linkInterrupted = get().sessions[session.key]?.linkInterrupted
        void settle(code === 'not_connected' || (preparing && (streamChanged || linkInterrupted)) ? next.error
          : submitted && (streamChanged || replyLost) ? UNCONFIRMED_QUEUED_SEND : message)
        // not_connected 由 backend 在转发前返回，等目标就绪事件再试。
        if (code === 'not_connected') return
      }
    } finally {
      if (epoch === desktopEpoch) submitting.delete(key)
    }
    // 快速完成可能已在 RPC 返回前收到结束事件，锁解除后再检查一次。
    if (epoch === desktopEpoch && !get().queuedSends[key]?.[0]?.error) void flushQueue(address)
    // 锁屏时正在发送的那条结束后，剩余消息再交给电脑。
    if (epoch === desktopEpoch && inBackground()) void handOffQueue(address)
  }

  function inBackground(): boolean {
    return appPaused || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  }

  /** 把一个会话的排队消息逐条交给电脑网关；交出第一条后该会话即归网关发送。 */
  async function handOffQueue(address: SendAddress): Promise<void> {
    const key = sendKey(address)
    const state = get()
    const conn = activeConnection(state)
    const list = state.queuedSends[key]
    if (!conn || conn.id !== address.desktopId || !state.agentSettings?.backgroundQueue || !state.eventsConnected) return
    if (remoteQueues.has(key) || handingOff.has(key) || submitting.has(key) || takeBackTask || !list?.length || list[0]!.error) return
    if (list.some((item) => item.relayPending || item.sending || item.saving || editingQueue.has(item.id) || savingQueue.has(item.id))) return
    const { targetId, agent, threadId } = address
    // 计划模式的队列留在手机：批准后要按切回的档位发送，电脑代发拿不到这次切换。
    if (mobileTurnAccess(state, agent, accessPreference(state, address) ?? list[0]!.accessMode).accessMode === 'plan') return
    const session = state.sessions[sessionKey(targetId, agent)]
    const view = session?.state.threads[threadId]
    if (!session?.opened || session.linkInterrupted || !view || queueLimited(address)) return
    // 网关不会替手机恢复 Codex 会话；没恢复过的留给手机回到前台后处理。
    if (agent === 'codex' && !session.resumedCodexThreads.has(threadId)) return
    const running = view.status === 'running' || !!state.compactingThreads[key]
    // 上一轮被中断时手机本身也会暂停队列，交给电脑前保持一致。
    if (!running && (view.status !== 'idle' || view.activity === 'interrupted')) return
    const epoch = desktopEpoch
    handingOff.add(key)
    try {
      for (const item of list) {
        // 电脑代发只支持消息；压缩及其后的内容留到手机回到前台再处理。
        if (item.compact || item.error) break
        const access = mobileTurnAccess(get(), agent, accessPreference(get(), address) ?? item.accessMode)
        const request = relayRequest(targetId, threadId, agent, item, access, !!session.accessSupported, makeId())
        // 请求发出前先落盘，WebView 被杀或回包丢失时也知道要向电脑核对。
        const markPending = (relayPending: true | undefined) => updateQueue(key, (items) => items.map((entry) =>
          entry.id === item.id ? { ...entry, relayPending } : entry))
        try {
          await markPending(true)
        } catch {
          void markPending(undefined)
          break
        }
        if (epoch !== desktopEpoch) return
        remoteQueues.add(key)
        await getGateway().rpc(conn, 'mobile.queue.put', { targetId, agent, threadId, id: item.id, running, request })
        if (epoch !== desktopEpoch) return
      }
    } catch {
      // 未交接的消息留在手机，已尝试交接的等收回时核对。
    } finally {
      handingOff.delete(key)
      if (!remoteQueues.has(key)) scheduleSteerCheck(address)
    }
  }

  function handOffQueues(): void {
    const desktopId = get().activeId
    if (!desktopId || !get().agentSettings?.backgroundQueue) return
    for (const address of pendingQueueAddresses(desktopId)) void handOffQueue(address)
  }

  /**
   * 电脑代发过的会话：锁屏期间的轮次事件可能没收到，消息已移出队列却看不到气泡和运行动画。
   * 直接读一次历史；优先走 HTTP，事件流还没发现自己断开时也能拿到结果。
   */
  async function syncRelayedThread(conn: Connection, address: SendAddress): Promise<void> {
    const { targetId, agent, threadId } = address
    const key = sessionKey(targetId, agent)
    const session = get().sessions[key]
    if (!session) return
    // 下次打开会话时重新读取，不沿用锁屏前的缓存。
    session.loadedThreads.delete(threadId)
    const before = session.state.threads[threadId]
    // 链路中断的会话由重连流程补读。
    if (!before || !session.opened || session.linkInterrupted) return
    const epoch = desktopEpoch
    const isCurrent = () => epoch === desktopEpoch && get().sessions[key]?.transport === session.transport
    try {
      let history: Awaited<ReturnType<typeof openThreadHistory>> | undefined
      if (get().agentSettings?.fastHistoryOpen) {
        try {
          history = await getGateway().rpc(conn, 'mobile.history.open', { targetId, agent, threadId })
        } catch (err) {
          if (!['forbidden', 'unknown_method', 'method_not_found', 'response_too_large'].includes(errorCode(err))) throw err
        }
      }
      if (!isCurrent()) return
      history ??= await openThreadHistory(session.rpc, threadId, 'read', isCurrent)
      if (!isCurrent()) return
      const { thread, earlier } = history
      if (thread?.id !== threadId) throw new Error(t('电脑返回的会话与所选会话不一致，请重试'))
      patchSession(key, (value) => ({
        ...value, state: loadRecentThreadHistory(value.state, thread, earlier, before),
      }), session)
    } catch {
      // 看不到电脑代发的结果时不能接着发下一条。
      // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
      if (isCurrent()) pauseQueue(sendKey(address), '未能确认会话状态，队列已暂停')
    }
  }

  /** 回到前台：收回交给电脑的队列，去掉电脑已发出的消息，再由手机继续发送。 */
  function takeBackQueues(): Promise<void> {
    if (takeBackTask) return takeBackTask
    const conn = activeConnection(get())
    if (!conn || !get().eventsConnected) return Promise.resolve()
    const epoch = desktopEpoch
    const task = (async () => {
      // 先等进行中的交接结束，否则收回后还可能再交出一条。
      while (handingOff.size > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      if (epoch !== desktopEpoch) return
      for (const [key, items] of Object.entries(get().queuedSends)) {
        if (items.some((item) => item.relayPending)) remoteQueues.add(key)
      }
      const owned = [...remoteQueues].filter((key) => key.startsWith(`[${JSON.stringify(conn.id)},`))
      let queues: unknown[] = []
      try {
        const result = await getGateway().rpc<unknown>(conn, 'mobile.queue.take', {})
        queues = isRecord(result) && Array.isArray(result.queues) ? result.queues : []
      } catch (err) {
        // 旧电脑没有代发能力时不会有已交出的队列；其他失败保留归属，下次回到前台再收。
        if (owned.length && !['forbidden', 'unknown_method', 'method_not_found', '-32601'].includes(errorCode(err))) return
      }
      if (epoch !== desktopEpoch) return
      const known = new Set<string>()
      const stale: SendAddress[] = []
      for (const entry of queues) {
        if (!isRecord(entry) || typeof entry.targetId !== 'string' || typeof entry.threadId !== 'string' || !isAgentKind(entry.agent)) continue
        const address = { desktopId: conn.id, targetId: entry.targetId, agent: entry.agent, threadId: entry.threadId }
        const key = sendKey(address)
        const sentIds = Array.isArray(entry.sentIds) ? entry.sentIds.filter((id): id is string => typeof id === 'string') : []
        known.add(key)
        if (sentIds.length) stale.push(address)
        const error = typeof entry.error === 'string' ? entry.error : undefined
        await updateQueue(key, (list) => releaseRelayedSends(applyRelayResult(list, sentIds, error), true))
      }
      // 交出过但电脑已没有记录（电脑端重启）：无法确认发送情况，暂停等用户核对。
      for (const key of owned) {
        if (!known.has(key)) {
          await updateQueue(key, (list) => releaseRelayedSends(list, false))
          const [desktopId, targetId, agent, threadId] = JSON.parse(key) as [string, string, AgentKind, string]
          stale.push({ desktopId, targetId, agent, threadId })
        }
        remoteQueues.delete(key)
      }
      // 读完历史前收回任务不结束，手机续发时能看到电脑发起的轮次仍在运行。
      await Promise.all(stale.map((address) => syncRelayedThread(conn, address)))
    })()
    takeBackTask = task
    void task.catch(() => undefined).finally(() => {
      if (takeBackTask === task) takeBackTask = null
      // 读历史期间又进了后台时交接会被跳过，这里补交。
      if (epoch === desktopEpoch && inBackground()) handOffQueues()
      // 代发期间暂缓判断的引导。
      for (const record of steers.values()) scheduleSteerCheck(record.address)
    })
    return task
  }

  /** 电脑代发后推来的进度：手机仍在后台运行时及时去掉已发出的消息。 */
  function applyRelayUpdate(payload: unknown): void {
    const desktopId = get().activeId
    if (!desktopId || !isRecord(payload) || typeof payload.targetId !== 'string' || typeof payload.threadId !== 'string' || !isAgentKind(payload.agent)) return
    const key = sendKey({ desktopId, targetId: payload.targetId, agent: payload.agent, threadId: payload.threadId })
    if (!remoteQueues.has(key)) return
    const sentIds = Array.isArray(payload.sentIds) ? payload.sentIds.filter((id): id is string => typeof id === 'string') : []
    void updateQueue(key, (list) => applyRelayResult(list, sentIds, typeof payload.error === 'string' ? payload.error : undefined))
  }

  // 打开会话时可以等短暂的重连，持续失联由连接状态统一提示。
  async function waitForEvents(desktopId: string, alive: () => boolean): Promise<boolean> {
    if (get().eventsConnected) return alive()
    return new Promise((resolve) => {
      const finish = (ready: boolean) => {
        clearTimeout(timer)
        unsubscribe()
        resolve(ready)
      }
      const check = () => {
        const state = get()
        if (!alive() || state.needsRepair[desktopId] || state.activeId !== desktopId) finish(false)
        else if (state.eventsConnected) finish(true)
      }
      const unsubscribe = useApp.subscribe(check)
      const timer = setTimeout(() => finish(false), EVENTS_WAIT_MS)
      check()
      if (!get().eventsConnected && alive()) controller?.wake()
    })
  }

  async function interruptAndWait(session: AgentSession, threadId: string, turnId: string): Promise<void> {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const finished = new Promise<boolean>((resolve) => {
      unsubscribe = session.rpc.onNotification((note) => {
        if (note.method !== 'turn/completed' || note.params?.threadId !== threadId || note.params.turn?.id !== turnId) return
        stopped = note.params.turn.status === 'interrupted' || note.params.turn.status === 'completed'
        resolve(stopped)
      })
      timer = setTimeout(() => resolve(false), 30_000)
    })
    try {
      try {
        await interruptTurn(session.rpc, threadId, turnId)
      } catch (err) {
        // 轮次可能在中断请求到达前自然结束。
        if (!stopped) throw err
      }
      if (!(await finished)) throw new Error(t('未确认当前一轮已停止，请检查会话后重试'))
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
    freshThreads.clear()
    localThreads.clear()
    const activeId = get().activeId
    // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
    if (activeId) pauseQueues([activeId], '电脑连接已切换，队列已暂停', true)
    for (const session of Object.values(get().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
    opening.clear()
    rateRefresh.clear()
    usageRefresh.clear()
    claudeCostPerTurn.clear()
    reconnectTask = null
    targetLinkEpochs.clear()
    claudeQuotaEpochs.clear()
    submitting.clear()
    replacing.clear()
    editingQueue.clear()
    steers.clear()
    set({ compactingThreads: {} })
  }

  const serverReq = async <T>(targetId: string, method: string, params: unknown): Promise<T> => {
    const conn = activeConnection(get())
    if (!conn) throw new Error(t('尚未选择电脑'))
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
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
        if (epoch !== desktopEpoch) throw new Error(t('电脑连接已切换'))
        // agent 直接放进 params：网关与 backend 都按 params.agent 路由，旧桌面会忽略它。
        const current = activeConnection(get()) ?? conn
        try {
          if (isRecord(msg) && msg.method === 'turn/start' && isRecord(msg.params)) {
            const { mobileAccessMode: access, ...params } = msg.params
            if (isRecord(access)) {
              return await getGateway().rpc(current, 'mobile.turn.start', {
                targetId, agent, ...access, msg: { ...msg, params }, replyViaHttp: true,
              })
            }
            return await getGateway().rpc(current, 'codex.send', { targetId, agent, msg, replyViaHttp: true })
          }
          return await getGateway().rpc(current, 'codex.send', { targetId, agent, msg })
        } catch (err) {
          markRepairError(current, epoch, err)
          if (epoch === desktopEpoch && ['access_mode_changed', 'access_settings_unavailable'].includes(errorCode(err))) void get().loadAgentSettings()
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
    // 换了新会话对象（重连等）时丢弃旧会话还没写入的增量。
    deltaBuffers.get(key)?.drop(key)
    const deltas = createDeltaBuffer((_, list) => {
      if (epoch !== desktopEpoch) return
      writeSession(key, (current) => ({ ...current, state: list.reduce(applyNotification, current.state) }), session)
    })
    deltaBuffers.set(key, deltas)
    set((state) => ({ sessions: { ...state.sessions, [key]: session } }))

    rpc.onNotification((notification: ServerNotification) => {
      if (epoch !== desktopEpoch) return
      // 流式增量没有副作用，先缓冲、定时合并写入，避免手机 WebView 每个增量都整页重渲染。
      if (isStreamDelta(notification)) {
        deltas.push(key, notification)
        return
      }
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
      if (steers.size) {
        confirmLateSteer(notification)
        if (method === 'turn/completed' && typeof params?.threadId === 'string') {
          scheduleSteerCheck({ desktopId: conn.id, targetId, agent, threadId: params.threadId })
        }
      }
      // 另一端或本机批准了计划，访问模式切回选计划模式前的档位。
      const planExit = completedPlanExit(notification)
      if (planExit && !handledPlanExits.has(planExit.itemId)) {
        handledPlanExits.add(planExit.itemId)
        leavePlan({ desktopId: conn.id, targetId, agent, threadId: planExit.threadId })
      }
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
        if (method === 'thread/name/updated' && typeof params?.threadName === 'string' && get().selectedTargetId === targetId) {
          const { threadId, threadName } = params
          if (typeof threadId === 'string') renameLocalThread(targetId, agent, threadId, threadName)
          set(({ threads }) => ({ threads: threads.map((item) => item.agent === agent && item.id === threadId ? { ...item, title: threadName } : item) }))
        }
      }
      // Claude/pi 的 server 同样发出归档通知，电脑端归档后手机也要随之隐藏。
      if (method === 'thread/archived' && typeof params?.threadId === 'string') {
        session.resumedCodexThreads.delete(params.threadId)
        session.loadedThreads.delete(params.threadId)
        recordArchive(conn.id, targetId, { id: params.threadId, agent })
      }
      if (method === 'thread/unarchived' && get().selectedTargetId === targetId) {
        void get().refreshThreads({ skipFailed: true })
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
        if (typeof params?.threadId === 'string' && !reconnectTask && !get().sessions[key]?.linkInterrupted
          && get().sessions[key]?.state.threads[params.threadId]?.status !== 'running') {
          const address = { desktopId: conn.id, targetId, agent, threadId: params.threadId }
          if (turn?.status === 'completed') void flushQueue(address)
          else if (turn?.status !== 'interrupted' || !replacing.has(sendKey(address))) {
            // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
            pauseQueue(sendKey(address), '上一轮未完成，队列已暂停')
          }
        }
      } else if (method === 'error' && !reconnectTask && !get().sessions[key]?.linkInterrupted
        && typeof params?.threadId === 'string' && params.willRetry !== true
        && get().sessions[key]?.state.threads[params.threadId]?.status !== 'running') {
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        pauseQueue(sendKey({ desktopId: conn.id, targetId, agent, threadId: params.threadId }), '上一轮未完成，队列已暂停')
      }
      if (visibleResolution) {
        set((state) => {
          const approvalSubmitting = { ...state.approvalSubmitting }
          delete approvalSubmitting[String(resolved)]
          return { approvalSubmitting }
        })
      }
      // Claude 和 pi 的会话进程就绪后会广播新的模型表。
      if (method === 'qingcode/models/updated') void get().loadModels(targetId, agent, true)
      if (agent === 'claude' && method === 'account/rateLimits/updated') {
        const snapshot = pickClaudeSnapshot(notification)
        if (snapshot) applyClaudeQuota(conn.id, targetId, snapshot)
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
      set({ error: get().sessions[key]?.openError ?? t('{agent} 未就绪', { agent: agentLabel(agent) }) })
      return null
    }
    if (epoch !== desktopEpoch || navigation !== navigationEpoch) return null
    return get().sessions[sessionKey(targetId, agent)] ?? null
  }

  const reloadConversation = async (session: AgentSession, threadId: string, isCurrent = () => true): Promise<boolean> => {
    try {
      const before = get().sessions[session.key]?.state.threads[threadId]
      const result = await openThreadHistory(session.rpc, threadId, 'read', isCurrent)
      if (!isCurrent() || result?.thread?.id !== threadId || get().sessions[session.key]?.transport !== session.transport) return false
      if (get().eventsConnected && get().sessions[session.key]?.opened) session.loadedThreads.add(threadId)
      patchSession(session.key, (value) => ({
        ...value, state: loadRecentThreadHistory(value.state, result.thread, result.earlier, before),
      }), session)
      const desktopId = get().activeId
      if (desktopId) {
        const address = { desktopId, targetId: session.targetId, agent: session.agent, threadId }
        reconcilePlanExit(address)
        scheduleSteerCheck(address)
      }
      return true
    } catch (err) {
      if (isCurrent() && showsConversation(session) && get().selectedThreadId === threadId
        && get().sessions[session.key]?.transport === session.transport) {
        set({ notice: friendlyError(err, t('暂时无法补齐会话历史，可再次打开会话')) })
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

  const applyClaudeQuota = (desktopId: string, targetId: string, snapshot: ClaudeRateLimitSnapshot): void => {
    set((state) => ({ claudeRateLimits: { ...state.claudeRateLimits, [targetId]: snapshot } }))
    // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
    if (claudeQuotaBlocked(snapshot)) pauseQueues([desktopId, targetId, 'claude'], '当前额度已用完，队列已暂停')
  }

  const clearClaudeQuota = (targetId: string): void => {
    claudeQuotaEpochs.set(targetId, (claudeQuotaEpochs.get(targetId) ?? 0) + 1)
    set((state) => {
      if (!state.claudeRateLimits[targetId]) return state
      const claudeRateLimits = { ...state.claudeRateLimits }
      delete claudeRateLimits[targetId]
      return { claudeRateLimits }
    })
  }

  const readClaudeRateLimits = async (session: AgentSession): Promise<boolean> => {
    const { key, targetId, rpc } = session
    const epoch = desktopEpoch
    const streamEpoch = eventStreamEpoch
    const quotaEpoch = claudeQuotaEpochs.get(targetId)
    const { activeId, claudeRateLimits } = get()
    if (!activeId) return false
    const previous = claudeRateLimits[targetId]
    try {
      // 只读取目标机缓存，读取期间可能收到新推送或切换连接。
      const snapshot = pickClaudeSnapshot(await rpc.request('account/rateLimits/read', {}))
      const state = get()
      if (!snapshot || epoch !== desktopEpoch || streamEpoch !== eventStreamEpoch || quotaEpoch !== claudeQuotaEpochs.get(targetId)
        || !state.sessions[key]?.opened || state.sessions[key].rpc !== rpc) return false
      if (state.claudeRateLimits[targetId] === previous) applyClaudeQuota(activeId, targetId, snapshot)
      return true
    } catch {
      // 旧版 daemon 或暂时断线时仍可等待下一次限额事件。
      return false
    }
  }

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
          const result = await attachSession(conn, session, Number.MAX_SAFE_INTEGER)
          const attached = attachResult(result)
          if (epoch !== desktopEpoch) return false
          session.transport.setLastSeq(attached.lastSeq)
          patchSession(key, (current) => ({
            ...current,
            opened: true,
            accessSupported: supportsMobileAccess(result) || undefined,
            openError: null,
            lastSeq: attached.lastSeq,
          }), session)
          if (agent === 'claude') void readClaudeRateLimits(session)
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

  /** 长时间离开后回到前台：事件流可能未被判定断开却漏了结束事件，重新读取仍显示运行中的当前会话。 */
  const reconcileSelectedRunning = (): void => {
    const state = get()
    const { selectedTargetId, selectedAgent, selectedThreadId } = state
    if (state.page !== 'chat' || !selectedTargetId || !selectedThreadId || !state.eventsConnected || reconnectTask) return
    const session = state.sessions[sessionKey(selectedTargetId, selectedAgent)]
    if (!session?.opened || session.state.threads[selectedThreadId]?.status !== 'running') return
    const epoch = desktopEpoch
    const streamEpoch = eventStreamEpoch
    void reloadConversation(session, selectedThreadId, () => epoch === desktopEpoch && streamEpoch === eventStreamEpoch)
  }

  const showsConversation = (session: AgentSession): boolean => {
    const state = get()
    return state.page === 'chat' && state.selectedThreadId !== null
      && state.selectedTargetId === session.targetId && state.selectedAgent === session.agent
  }

  /** 提交审批/提问类 server request 的回复：去重、等重连、只在仍未决时发送，等 Agent 的 resolved 广播收尾。 */
  const replyServerRequest = async (
    requestId: RequestId,
    check: (approval: ApprovalView, agent: AgentKind) => string | null,
    build: (approval: ApprovalView) => unknown,
  ): Promise<boolean> => {
    const { selectedTargetId, selectedThreadId, selectedAgent, sessions, approvalSubmitting } = get()
    const submittingKey = String(requestId)
    if (!selectedTargetId || !selectedThreadId || approvalSubmitting[submittingKey]) return false
    const session = sessions[sessionKey(selectedTargetId, selectedAgent)]
    const approval = session?.state.threads[selectedThreadId]?.pendingApprovals.find((item) => item.requestId === requestId)
    if (!session || !approval) return false
    const invalid = check(approval, selectedAgent)
    if (invalid) {
      set({ error: invalid })
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
      await session.transport.respond(approval.requestId, build(approval))
      acknowledged = true
      // HTTP 仅确认网关收到响应，桌面也可能先处理，等待 Agent 的 resolved 广播。
      return true
    } catch (err) {
      if (epoch !== desktopEpoch || navigation !== navigationEpoch) return false
      const pending = get().sessions[session.key]?.state.threads[selectedThreadId]?.pendingApprovals
      if (!pending?.some((item) => item.requestId === requestId)) return true
      set({ error: friendlyError(err, t('提交审批失败')) })
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
  }

  return {
    page: 'connections',
    unanimatedNavigation: 0,
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
    legacyAgentSettings: false,
    threads: [],
    archivedThreads: {},
    threadsLoading: false,
    threadsError: null,
    agentErrors: {},
    selectedThreadId: null,
    openingThread: null,
    selectedAgent: DEFAULT_AGENT,
    sessions: {},
    threadAccessModes: {},
    models: {},
    modelPrefs: {},
    rateLimits: {},
    claudeRateLimits: {},
    claudeCosts: {},
    viewer: null,
    annotations: [],
    draftText: '',
    draftImages: noImages,
    approvalSubmitting: {},
    sending: false,
    compactingThreads: {},
    queuedSends: {},
    pendingSteers: {},
    backgroundConnectionEnabled: true,
    error: null,
    notice: null,

    init: () => {
      if (initialized) return () => undefined
      initialized = true
      const gateway = getGateway()
      const mock = isMockGateway()
      set({ mock })
      if (!mock && typeof window !== 'undefined' && window.QnNative) {
        void callDevice<boolean>('background.get').then((enabled) => {
          if (typeof enabled === 'boolean') set({ backgroundConnectionEnabled: enabled })
        }).catch(() => undefined)
        let syncing = Promise.resolve<unknown>(undefined)
        const hasDesktop = (state: AppState) => !!state.activeId && !state.needsRepair[state.activeId]
        useApp.subscribe((state, previous) => {
          const active = hasDesktop(state)
          if (active === hasDesktop(previous)) return
          syncing = syncing.then(() => callDevice('background.connection', { active })).catch(() => undefined)
        })
      }
      const resumeQueues = () => {
        const desktopId = get().activeId
        void takeBackQueues().then(() => {
          if (!desktopId || get().activeId !== desktopId) return
          for (const address of pendingQueueAddresses(desktopId)) void flushQueue(address)
        }, () => undefined)
      }
      // 记录进入后台的时间；离开超过阈值再回来时核对当前会话状态。
      let hiddenAt: number | null = null
      const RECONCILE_AFTER_MS = 30_000
      const markHidden = () => { hiddenAt ??= Date.now() }
      const reconcileAfterIdle = () => {
        const since = hiddenAt
        hiddenAt = null
        if (since !== null && Date.now() - since >= RECONCILE_AFTER_MS) reconcileSelectedRunning()
      }
      const onResume = () => {
        appPaused = false
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        controller?.wake()
        resumeQueues()
        reconcileAfterIdle()
      }
      if (typeof window !== 'undefined') {
        window.__qnBack = () => get().goBack()
        window.__qnResume = onResume
        window.__qnPause = () => {
          appPaused = true
          markHidden()
          handOffQueues()
        }
        window.addEventListener('online', () => {
          if (document.visibilityState !== 'hidden') controller?.wake(true)
        })
      }
      controller = new EventStreamController(gateway, () => activeConnection(get()), {
        onEvent: (event) => get().handleGatewayEvent(event),
        onOpen: (reconnected) => {
          if (reconnected) {
            const epoch = eventStreamEpoch
            const desktopId = get().activeId
            for (const session of Object.values(get().sessions)) session.loadedThreads.clear()
            const task = Promise.all([get().attachOpened(), get().loadAgentSettings()]).then(() => undefined)
            reconnectTask = task
            void task.then(() => {
              if (reconnectTask !== task) return
              reconnectTask = null
              if (!desktopId || epoch !== eventStreamEpoch || get().activeId !== desktopId || !get().eventsConnected) return
              // 仍在后台时继续交给电脑；在前台则先收回再由手机发送。
              if (inBackground()) handOffQueues()
              else resumeQueues()
            }, () => { if (reconnectTask === task) reconnectTask = null })
          }
          set({ eventsConnected: true, eventsError: null })
          // 首次连上：收回上次（可能在应用被杀前）交给电脑的队列。
          if (!reconnected && !inBackground()) resumeQueues()
          if (reconnected && get().page === 'targets') void get().loadTargets()
          const conn = activeConnection(get())
          if (conn && pendingRestore) void restoreSavedChat(conn)
        },
        onClose: () => {
          eventStreamEpoch += 1
          set({ eventsConnected: false, claudeRateLimits: {} })
        },
        onUnavailable: () => set({ eventsError: EVENTS_UNAVAILABLE_MESSAGE }),
        onRepair: (reason, message) => {
          const id = get().activeId
          if (id) markRepair(id, reason, message)
        },
      })
      if (typeof document !== 'undefined') {
        const updateForeground = () => {
          const foreground = document.visibilityState !== 'hidden'
          controller?.setForeground(foreground)
          if (!foreground) {
            markHidden()
            handOffQueues()
            return
          }
          appPaused = false
          resumeQueues()
          reconcileAfterIdle()
        }
        document.addEventListener('visibilitychange', updateForeground)
        updateForeground()
      }
      void (async () => {
        try {
          const optional = (key: string) => gateway.storageGet(key).catch(() => null)
          const [raw, active, legacyPrefs, prefs, storedDrafts, chats, archives, queues, accessPrefs] = await Promise.all([
            gateway.storageGet(STORAGE_CONNECTIONS),
            gateway.storageGet(STORAGE_ACTIVE),
            optional(STORAGE_MODEL_PREFS),
            optional(STORAGE_DESKTOP_MODEL_PREFS),
            optional(STORAGE_DRAFTS),
            optional(STORAGE_SAVED_CHATS),
            optional(STORAGE_ARCHIVED_THREADS),
            optional(QUEUE_STORAGE_KEY),
            optional(ACCESS_PREFS_STORAGE_KEY),
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
          set({ connections, archivedThreads, queuedSends: restoreQueues(queues, connections, archivedThreads),
            threadAccessModes: restoreAccessPrefs(accessPrefs, connections, archivedThreads), booting: false })
          if (activeId) await get().activate(activeId, 'workspace', { startup: true })
          else void get().refreshStatuses()
        } catch (err) {
          set({ booting: false, error: friendlyError(err, t('读取本地连接失败')) })
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
        set({ form: { ...form, testing: false, error: t('未找到有效的连接信息，请粘贴包含 qingcode-next://pair? 的文本') } })
        return
      }
      if (form.mode === 'edit' && info.fp !== normalizeFingerprint(form.draft.fp)) {
        set({ form: { ...form, testing: false, error: t('这份连接信息的证书指纹不同，请作为新连接导入') } })
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
          set({ form: { ...form, testing: false, error: friendlyError(err, t('读取剪贴板失败')) } })
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
        set({ form: { ...form, error: t('请先填写有效的主机、端口与 64 位证书指纹') } })
        return
      }
      const pending = { ...form, testing: true, error: null, fpMismatch: null, probe: null }
      set({ form: pending })
      try {
        const result = await getGateway().probe(endpoint.host, endpoint.port)
        const actual = normalizeFingerprint(result.fingerprint)
        if (get().form !== pending) return
        if (actual === null) {
          set({ form: { ...pending, testing: false, error: t('电脑未返回有效的证书指纹') } })
        } else if (actual !== fp) {
          set({ form: { ...pending, testing: false, fpMismatch: FINGERPRINT_MISMATCH_HINT } })
        } else {
          set({ form: { ...pending, testing: false, probe: result } })
        }
      } catch (err) {
        if (get().form === pending) {
          set({ form: { ...pending, testing: false, error: friendlyError(err, t('测试连接失败，请检查地址与电脑是否在线')) } })
        }
      }
    },

    pairAndSave: async () => {
      const form = get().form
      if (!form || form.mode === 'edit' || form.saving || form.testing) return
      const endpoint = draftEndpoint(form.draft)
      const fp = normalizeFingerprint(form.draft.fp)
      if (!endpoint || !fp) {
        set({ form: { ...form, error: t('连接信息不完整，请重新粘贴或填写') } })
        return
      }
      const draft: ConnectionDraft = { ...form.draft, ...endpoint, fp }
      if (!isValidPairingCode(draft.code)) {
        set({ form: { ...form, error: t('配对密码需为 6–20 位且不含空白字符') } })
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
          get().mock ? t('浏览器调试') : DEVICE_NAME,
        )
        if (get().form !== pending) return
        const previous = form.mode === 'repair' ? get().connections.find((item) => item.id === form.editId) : null
        if (form.mode === 'repair' && !previous) throw new Error(t('此电脑连接已移除'))
        const conn: Connection = {
          id: previous?.id ?? makeId(),
          name: draft.name.trim() || '未命名电脑', // i18n-ignore: 默认名按原文保存，展示时翻译
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
          clearDesktopAccessPrefs(conn.id)
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
          set({ form: { ...current, saving: false, error: friendlyError(err, t('配对失败')) } })
        }
      }
    },

    saveEdit: async () => {
      const form = get().form
      if (!form || form.mode !== 'edit' || !form.editId || form.saving || form.testing) return
      const endpoint = draftEndpoint(form.draft)
      if (!endpoint) {
        set({ form: { ...form, error: t('主机或端口格式不正确') } })
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
        set({ form: { ...form, error: friendlyError(err, t('保存修改失败')) } })
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
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
          legacyAgentSettings: false,
          viewer: null,
          targetStates: {},
          selectedTargetId: null,
          selectedProjectId: null,
          selectedThreadId: null,
          eventsConnected: false,
          eventsError: null,
          sending: false,
          draftText: '',
          draftImages: noImages,
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

    activate: async (id, page = 'workspace', { startup = false } = {}) => {
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
        ...(startup ? { unanimatedNavigation: state.unanimatedNavigation + 1 } : {}),
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
        legacyAgentSettings: false,
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
        draftImages: noImages,
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
      const streamEpoch = eventStreamEpoch
      try {
        const result = await getGateway().rpc<unknown>(conn, 'targets.list', {})
        if (epoch !== desktopEpoch || get().needsRepair[conn.id]) return
        set({ targets: parseTargets(result), connectionStatus: { ...get().connectionStatus, [conn.id]: 'online' } })
      } catch (err) {
        if (epoch !== desktopEpoch) return
        markRepairError(conn, epoch, err)
        if (streamEpoch === eventStreamEpoch && get().eventsConnected) {
          set({ error: friendlyError(err, t('读取目标列表失败')) })
        }
      }
    },

    loadAgentSettings: async () => {
      const conn = activeConnection(get())
      if (!conn) return
      const epoch = desktopEpoch
      const request = ++agentSettingsRequest
      try {
        const result = await getGateway().rpc<unknown>(conn, 'mobile.agents', {})
        if (epoch === desktopEpoch && request === agentSettingsRequest) {
          const agentSettings = parseMobileAgents(result)
          if (agentSettings) set({ agentSettings, legacyAgentSettings: agentSettings.globalAccessMode === undefined })
        }
      } catch (err) {
        // 旧桌面版本没有 mobile.agents：只用 Codex。
        if (epoch === desktopEpoch && request === agentSettingsRequest) {
          if (['forbidden', 'unknown_method', 'method_not_found', '-32601'].includes(errorCode(err))) {
            set({ agentSettings: null, legacyAgentSettings: true })
          }
          markRepairError(conn, epoch, err)
        }
      }
    },

    requestConnect: (id) => {
      const target = get().targets.find((item) => item.id === id)
      if (!target) return
      if (target.kind === 'ssh' && target.auth.kind === 'password') {
        // 电脑上已保存密码时直接连（backend 合并已保存凭据）；认证失败再弹框让用户重输。
        if (!target.hasSavedSecret) {
          set({ credential: { targetId: id, name: target.name } })
          return
        }
        void get().connect(id, {}).then(() => {
          const info = get().targetStates[id]
          if (info?.state === 'error' && AUTH_ERROR_RE.test(info.detail ?? '')) {
            set({ credential: { targetId: id, name: target.name } })
          }
        })
        return
      }
      void get().connect(id, {})
    },

    submitCredentials: async (password, remember) => {
      const prompt = get().credential
      if (!prompt) return
      const saving = remember && Boolean(password)
      await get().connect(prompt.targetId, {
        ...(password ? { password } : {}),
        ...(saving ? { remember: true } : {}),
      })
      // 记住成功后刷新目标列表，让"已保存密码"立即生效，下次不再弹框。
      if (saving && get().targetStates[prompt.targetId]?.state !== 'error') void get().loadTargets()
    },

    cancelCredentials: () => set({ credential: null }),

    connect: async (id, credentials) => {
      const conn = activeConnection(get())
      if (!conn) {
        set({ error: t('尚未选择电脑') })
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
        const message = hostKeyMessage(err, t('连接失败'))
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
        clearClaudeQuota(id)
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        pauseQueues([conn.id, id], '目标连接中断，队列已暂停')
      } catch (err) {
        if (epoch !== desktopEpoch) return
        markRepairError(conn, epoch, err)
        set({ notice: friendlyError(err, t('断开失败')) })
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
        set({ projectsLoading: false, error: friendlyError(err, t('读取项目列表失败')) })
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
        set({ directory: { ...directory, loading: false, error: friendlyError(err, t('读取主目录失败')) } })
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
            error: friendlyError(err, t('读取目录失败')),
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
        set({ directory: { ...pending, saving: false, error: friendlyError(err, t('添加项目失败')) } })
      }
    },

    ensureOpen: async (targetId, agent = DEFAULT_AGENT) => {
      const epoch = desktopEpoch
      if (reconnectTask) await reconnectTask
      if (epoch !== desktopEpoch) return false
      const key = sessionKey(targetId, agent)
      const existing = get().sessions[key]
      if (existing?.opened && existing.accessSupported !== undefined) return true
      const busy = opening.get(key)
      if (busy) return busy
      const conn = activeConnection(get())
      if (!conn) {
        set({ error: t('尚未选择电脑') })
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
          let accessSupported = supportsMobileAccess(opened)
          let lastSeq = reset ? hostSeq : seen ?? hostSeq
          let truncated = reset
          try {
            // 每个 agent 有独立的回放缓冲，attach 必须带上 agent。
            const attached = await attachSession(conn, session, lastSeq ?? 0)
            accessSupported ||= supportsMobileAccess(attached)
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
            accessSupported,
            mcpStatusSupported: supportsMcpStatus(opened),
            opening: false,
            openError: null,
            lastSeq,
          }), session)
          if (truncated) void reloadActiveConversation(session)
          if (agent === 'codex') void get().refreshRateLimits(targetId)
          else if (agent === 'claude') void readClaudeRateLimits(session)
          // 打开即预取模型表，弹层打开时不必再等。
          void get().loadModels(targetId, agent, true)
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

    attachOpened: async (targetId) => {
      const conn = activeConnection(get())
      if (!conn) return
      const epoch = desktopEpoch
      const streamEpoch = eventStreamEpoch
      await Promise.all(Object.values(get().sessions).filter((session) => session.opened &&
        (targetId === undefined || session.targetId === targetId)).map(async (session) => {
        const linkEpoch = targetLinkEpochs.get(session.targetId)
        const isCurrent = () => epoch === desktopEpoch && streamEpoch === eventStreamEpoch &&
          linkEpoch === targetLinkEpochs.get(session.targetId)
        if (session.linkInterrupted && get().targetStates[session.targetId]?.state !== 'ready') return
        const queued = () => pendingQueueAddresses(conn.id)
          .filter((address) => address.targetId === session.targetId && address.agent === session.agent)
        try {
          const cursor = session.transport.getLastSeq() ?? 0
          let attached
          try {
            attached = await attachSession(conn, session, cursor)
          } catch (err) {
            if (!isCurrent() || !showsConversation(session) || errorCode(err) !== 'not_connected') throw err
            await connectSavedTarget(conn, session.targetId)
            if (!isCurrent()) return
            attached = await attachSession(conn, session, cursor)
          }
          if (!isCurrent()) return
          let info = attachResult(attached)
          const restarted = info.lastSeq !== null && info.lastSeq < cursor
          let accessSupported = (!restarted && session.accessSupported) || supportsMobileAccess(attached)
          let mcpStatusSupported = !restarted && session.mcpStatusSupported
          if (restarted) {
            session.transport.resetSequence()
            session.resumedCodexThreads.clear()
            clearPendingApprovals(session)
            // 接回用户正在看的一条对话时才允许启动重启后还没恢复的 Agent。
            if (showsConversation(session)) {
              const opened = await getGateway().rpc(conn, 'server.req', {
                targetId: session.targetId,
                method: 'codex.open',
                params: { agent: session.agent },
              })
              accessSupported ||= supportsMobileAccess(opened)
              mcpStatusSupported = supportsMcpStatus(opened)
              if (!isCurrent()) return
            }
            attached = await attachSession(conn, session, 0)
            info = attachResult(attached)
            if (!isCurrent()) return
          }
          patchSession(session.key, (value) => ({
            ...value,
            opened: true,
            accessSupported: accessSupported || supportsMobileAccess(attached) || (restarted ? undefined : session.accessSupported),
            mcpStatusSupported,
            openError: null,
            lastSeq: restarted ? info.lastSeq : maxSeq(value.lastSeq, info.lastSeq),
          }), session)
          // 断线期间可能错过模型更新通知；重新接到已打开的 Agent 后立即补读。
          if (!restarted || showsConversation(session)) void get().loadModels(session.targetId, session.agent, true)
          const quota = session.agent === 'claude' ? readClaudeRateLimits(session) : undefined
          const queueAddresses = queued()
          const threadIds = new Set(queueAddresses.map((address) => address.threadId))
          const selected = get().selectedThreadId
          // 断线期间可能错过 turn/completed：正在看的会话仍显示运行中时也重新读取，避免卡在运行中。
          const selectedView = selected ? get().sessions[session.key]?.state.threads[selected] : undefined
          if ((session.linkInterrupted || restarted || info.truncated || selectedView?.status === 'running')
            && selected && showsConversation(session)) threadIds.add(selected)
          // attach 的 HTTP 回包可能早于事件流；用当前会话状态判断队列能否继续。
          await Promise.all([...threadIds].map(async (threadId) => {
            const loaded = await reloadConversation(session, threadId, isCurrent)
            if (!isCurrent()) return
            const address = queueAddresses.find((item) => item.threadId === threadId)
            if (!address) return
            const key = sendKey(address)
            const view = get().sessions[session.key]?.state.threads[threadId]
            // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
            if (!loaded) pauseQueue(key, '未能确认会话状态，队列已暂停')
            // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
            else if (view?.status === 'error' || view?.activity === 'interrupted') pauseQueue(key, '上一轮未完成，队列已暂停')
          }))
          if (queueAddresses.length) await quota
          if (isCurrent()) patchSession(session.key, (value) => ({ ...value, linkInterrupted: false }), session)
        } catch (err) {
          if (!isCurrent()) return
          markRepairError(conn, epoch, err)
          if (isTargetDisconnected(err)) {
            patchSession(session.key, (value) => ({ ...value, linkInterrupted: true }), session)
            return
          }
          patchSession(session.key, (value) => ({ ...value, opened: false, openError: t('会话连接已断开，操作时会尝试重新连接') }), session)
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
            const message = get().sessions[sessionKey(targetId, agent)]?.openError ?? t('{agent} 未就绪', { agent: agentLabel(agent) })
            return { agent, threads: [], error: message }
          }
          const session = get().sessions[sessionKey(targetId, agent)]
          if (!session) return { agent, threads: [], error: t('{agent} 未就绪', { agent: agentLabel(agent) }) }
          try {
            return { agent, threads: await listVisibleThreads(activeId, session, cwd), error: null }
          } catch (err) {
            return { agent, threads: [], error: friendlyError(err, t('加载会话列表失败')) }
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
        threads: withLocalThreads(activeId, targetId, cwd, mergeThreadSummaries(results.map((result) => result.threads)))
          .filter((thread) => !isArchived(activeId, targetId, thread)),
        threadsLoading: false,
        agentErrors,
        threadsError: allFailed
          ? results.map((result) => t('{name}：{message}', {
              name: agentLabel(result.agent), message: translateMessage(result.error ?? ''),
            })).join('\n')
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
        set({ error: t('{agent} 已在电脑设置中关闭', { agent: agentLabel(picked) }) })
        return false
      }
      const session = await withSession(targetId, picked, navigation)
      if (!session || !isCurrent()) return false
      try {
        const result = await startThread(session.rpc, cwd ? { cwd } : {})
        if (!isCurrent()) return false
        if (picked === 'codex') session.resumedCodexThreads.add(result.thread.id)
        freshThreads.set(sendKey({ desktopId: conn.id, targetId, agent: picked, threadId: result.thread.id }), cwd || result.thread.cwd || '')
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
        if (isCurrent()) set({ error: friendlyError(err, t('新建会话失败')) })
        return false
      }
    },

    openThread: async (id, agent, workspace, { restoring = false } = {}) => {
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
          ...(restoring ? { unanimatedNavigation: get().unanimatedNavigation + 1 } : {}),
          chatReturnPage: chatReturnPage(source),
          error: null,
        })
        showDraft()
        saveActiveChat()
        if (movedProject) void recordProjectVisit(conn, workspace.project)
      }
      if (hasFreshHistory) {
        showConversation()
        void flushQueue(openingThread)
        return true
      }
      set({ error: null })
      const loadHistory = async (): Promise<boolean> => {
        if (!(await waitForEvents(conn.id, shouldLoad))) return false
        // 应用重开时先收回代发，再读历史，避免把代发期间的旧空闲状态当成可发送。
        if (get().queuedSends[sendKey(openingThread)]?.length) await takeBackTask?.catch(() => undefined)
        if (!shouldLoad()) return false
        const ready = await get().ensureOpen(targetId, picked)
        if (!isCurrent() || archived()) return false
        const session = get().sessions[key]
        if (!ready || !session) {
          throw new NativeRequestError(session?.openError ?? t('{agent} 未就绪', { agent: agentLabel(picked) }), session?.openErrorCode)
        }
        if (!(await waitForEvents(conn.id, shouldLoad))) return false
        const before = get().sessions[key]?.state.threads[id]
        type OpenedHistory = Awaited<ReturnType<typeof openThreadHistory>> & { resumed: boolean }
        let result: OpenedHistory | undefined
        if (get().agentSettings?.fastHistoryOpen) {
          try {
            result = await getGateway().rpc<OpenedHistory>(conn, 'mobile.history.open', { targetId, agent: picked, threadId: id })
          } catch (err) {
            if (!shouldLoad()) return false
            // 老网关与超过 HTTP 上限的历史继续走原来的事件流，保留分页兼容性。
            if (!['forbidden', 'unknown_method', 'method_not_found', 'response_too_large'].includes(errorCode(err))) throw err
          }
        }
        if (!result) {
          try {
            result = { ...await openThreadHistory(session.rpc, id, 'resume', shouldLoad), resumed: true }
          } catch (err) {
            if (!shouldLoad()) return false
            if (isTargetDisconnected(err) || picked !== 'codex' || isOversizeHistoryResponse(err)) throw err
            if (!(await waitForEvents(conn.id, shouldLoad))) return false
            result = { ...await openThreadHistory(session.rpc, id, 'read', shouldLoad), resumed: false }
          }
        }
        if (!isCurrent() || archived()) return false
        if (result?.thread?.id !== id) throw new Error(t('电脑返回的会话与所选会话不一致，请重试'))
        if (get().eventsConnected && !reconnectTask && get().sessions[key]?.opened) session.loadedThreads.add(id)
        if (picked === 'codex') {
          if (result.resumed) session.resumedCodexThreads.add(id)
          else session.resumedCodexThreads.delete(id)
        }
        const { thread, earlier } = result
        patchSession(session.key, (value) => ({
          ...value, state: loadRecentThreadHistory(value.state, thread, earlier, before),
        }), session)
        reconcilePlanExit(openingThread)
        scheduleSteerCheck(openingThread)
        showConversation()
        void flushQueue(openingThread)
        // 清单只挂在发生变化的轮次上，首页没有时到更早的页里找。
        if (AGENT_CAPABILITIES[picked].historyPlan && earlier && !get().sessions[key]?.state.threads[id]?.plan) {
          const isSameSession = () => get().sessions[key]?.transport === session.transport
          void readEarlierPlan(session.rpc, id, earlier, isSameSession).then((plan) => {
            if (plan && isSameSession()) {
              patchSession(key, (value) => ({ ...value, state: applyEarlierPlan(value.state, id, plan) }), session)
            }
          })
        }
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
          timer = setTimeout(() => reject(new Error(t('打开会话超时，请检查电脑连接后重试'))), OPEN_THREAD_TIMEOUT_MS)
        })
        return await Promise.race([openHistory(), deadline])
      } catch (err) {
        if (isCurrent()) {
          markRepairError(conn, desktopEpoch, err)
          set({ error: hostKeyMessage(err, t('打开会话失败')) })
        }
        return false
      } finally {
        clearTimeout(timer)
        if (get().openingThread === openingThread) set({ openingThread: null })
      }
    },

    loadEarlierHistory: async (beforeApply) => {
      const { selectedTargetId, selectedAgent, selectedThreadId, sessions } = get()
      if (!selectedTargetId || !selectedThreadId) return
      const key = sessionKey(selectedTargetId, selectedAgent)
      const session = sessions[key]
      const cursor = session?.state.threads[selectedThreadId]?.historyCursor
      if (!session || !cursor) return
      const navigation = navigationEpoch
      const isCurrent = () => {
        const state = get()
        const current = state.sessions[key]
        return navigation === navigationEpoch && state.page === 'chat' && state.selectedThreadId === selectedThreadId &&
          current?.transport === session.transport && current.state.threads[selectedThreadId]?.historyCursor === cursor
      }
      try {
        const page = await readThreadHistoryPage(session.rpc, selectedThreadId, cursor, isCurrent)
        if (!isCurrent()) return
        beforeApply()
        patchSession(key, (value) => ({ ...value, state: prependThreadHistory(value.state, selectedThreadId, page) }), session)
      } catch (error) {
        if (isCurrent()) throw error
      }
    },

    archiveConversation: async (targetId, thread) => {
      const conn = activeConnection(get())
      if (!conn) throw new Error(t('尚未选择电脑'))
      const key = archivedThreadKey(conn.id, targetId, thread)
      if (get().archivedThreads[key] || archiveFlights.has(key)) return
      const epoch = desktopEpoch
      const stillPaired = () => get().connections.some((item) => item.id === conn.id && item.fp === conn.fp)
      archiveFlights.add(key)
      try {
        // 所有 Agent 都在目标机上归档（Claude/pi 由 server 记录），电脑端同步隐藏。
        const session = await conversationSession(targetId, thread.agent, epoch)
        await archiveThread(session.rpc, thread.id)
        session.resumedCodexThreads.delete(thread.id)
        session.loadedThreads.delete(thread.id)
        if (stillPaired()) recordArchive(conn.id, targetId, thread)
      } finally {
        archiveFlights.delete(key)
      }
    },

    listArchivedConversations: async ({ targetId, path }) => {
      const conn = activeConnection(get())
      if (!conn) throw new Error(t('尚未选择电脑'))
      const epoch = desktopEpoch
      // 已确认打开失败（如未安装 pi）的 Agent 不在归档页重复报错，与会话列表的 skipFailed 一致。
      const enabled = targetAgents(get(), targetId)
      const unavailable = unavailableAgents(get(), targetId, enabled)
      const agents = AGENTS.filter((agent) => enabled.includes(agent) && !unavailable.has(agent))
      const results = await Promise.all(agents.map(async (agent) => {
        try {
          const session = await conversationSession(targetId, agent, epoch)
          const result = await listThreads(session.rpc, path, undefined, { archived: true })
          const threads = toThreadSummaries(result, agent)
          return { threads, error: null }
        } catch (err) {
          const message = translateMessage(friendlyError(err, t('读取归档失败')))
          return { threads: [], error: t('{name}：{message}', { name: agentLabel(agent), message }) }
        }
      }))
      if (epoch !== desktopEpoch) throw new Error(t('电脑连接已切换'))
      return { threads: mergeThreadSummaries(results.map(({ threads }) => threads)), error: results.map(({ error }) => error).filter(Boolean).join('\n') || null }
    },

    restoreConversation: async (targetId, thread) => {
      const conn = activeConnection(get())
      if (!conn) throw new Error(t('尚未选择电脑'))
      const key = archivedThreadKey(conn.id, targetId, thread)
      if (archiveFlights.has(key)) throw new Error(t('该会话正在处理归档，请稍后重试'))
      const epoch = desktopEpoch
      const stillPaired = () => get().connections.some((item) => item.id === conn.id && item.fp === conn.fp)
      archiveFlights.add(key)
      try {
        const session = await conversationSession(targetId, thread.agent, epoch)
        await session.rpc.request('thread/unarchive', { threadId: thread.id })
        if (stillPaired() && get().archivedThreads[key]) {
          const archivedThreads = { ...get().archivedThreads }
          delete archivedThreads[key]
          set({ archivedThreads })
          persistArchives()
        }
        if (epoch === desktopEpoch && get().selectedTargetId === targetId) await get().refreshThreads({ skipFailed: true })
      } finally {
        archiveFlights.delete(key)
      }
    },

    renameConversation: async (targetId, threadId, name, agent = 'codex') => {
      const epoch = desktopEpoch
      const title = name.trim()
      if (!title) throw new Error(t('请输入会话名称'))
      const session = await conversationSession(targetId, agent, epoch)
      try {
        await setThreadName(session.rpc, threadId, title)
      } catch (err) {
        if (agent !== 'codex' && err instanceof CodexRpcError && err.code === -32601) return 'local'
        throw err
      }
      if (epoch === desktopEpoch) renameLocalThread(targetId, agent, threadId, title)
      if (epoch === desktopEpoch && get().selectedTargetId === targetId) {
        set(({ threads }) => ({ threads: threads.map((item) => item.agent === agent && item.id === threadId ? { ...item, title } : item) }))
      }
      return 'native'
    },

    setDraftText: (text, images = get().draftImages) => {
      const key = currentDraftKey()
      if (key) saveDraft(key, { text, images, annotations: get().annotations })
    },

    setAccessMode: (mode) => {
      const state = get()
      const address = selectedSendAddress(state)
      const connection = activeConnection(state)
      if (!address || !connection || !state.eventsConnected || state.page !== 'chat' || state.sending) return
      const { targetId, agent, threadId } = address
      const key = sessionKey(targetId, agent)
      const threadKey = sendKey(address)
      const session = state.sessions[key]
      const view = session?.state.threads[threadId]
      if (!session?.opened || agent === 'pi' || (mode !== 'default' && mode !== 'inherit' && !session.accessSupported) ||
          // 运行中允许修改，新档位从下一轮开始生效。
          !view || state.compactingThreads[threadKey] ||
          (mode !== 'inherit' && !sessionAccessOptions(agent).some((option) => option.mode === mode))) return
      const preferenceKey = accessPreferenceKey(address, connection.fp)
      saveAccessPrefs(selectAccess(state.threadAccessModes, preferenceKey, mode, latestPlanExit(view.items)))
    },

    refreshBackgroundTasks: async () => {
      const address = selectedSendAddress(get())
      if (!address || !AGENT_CAPABILITIES[address.agent].backgroundTasks) return
      const session = get().sessions[sessionKey(address.targetId, address.agent)]
      if (session?.opened) await readBackgroundTasks(session, address.threadId)
    },

    stopBackgroundTask: async (taskId) => {
      const state = get()
      const address = selectedSendAddress(state)
      if (!address || !AGENT_CAPABILITIES[address.agent].backgroundTasks) return false
      const session = state.sessions[sessionKey(address.targetId, address.agent)]
      if (!session?.opened || !state.eventsConnected) return false
      const epoch = desktopEpoch
      try {
        await stopBackgroundTask(session.rpc, address.threadId, taskId)
        return true
      } catch (error) {
        if (epoch === desktopEpoch) {
          set({ notice: friendlyError(error, t('停止后台任务失败')) })
          // 任务可能刚好结束，重新读一次列表。
          void readBackgroundTasks(session, address.threadId)
        }
        return false
      }
    },

    forkConversation: async (lastTurnId) => {
      const source = get()
      const address = selectedSendAddress(source)
      if (!address || !AGENT_CAPABILITIES[address.agent].fork) throw new Error(t('当前会话不支持创建分支'))
      const navigation = navigationEpoch
      const epoch = desktopEpoch
      const { targetId, agent, threadId } = address
      const session = await conversationSession(targetId, agent, epoch)
      if (navigation !== navigationEpoch || epoch !== desktopEpoch) return false
      // 历史由 openThread 重新读取，分支回包不带轮次，避免长会话超出手机的回包上限。
      const result = await session.rpc.request('thread/fork', { threadId, ...(lastTurnId ? { lastTurnId } : {}), excludeTurns: true })
      if (navigation !== navigationEpoch || epoch !== desktopEpoch) return false
      const opened = await get().openThread(result.thread.id, agent)
      if (epoch === desktopEpoch) {
        // 读到分支历史后再记，继承来的批准记录不会被当成本次批准。
        carryPlanMode(address, result.thread.id, get().sessions[session.key]?.state.threads[result.thread.id]?.items)
      }
      if (epoch === desktopEpoch && get().selectedTargetId === targetId) void get().refreshThreads({ skipFailed: true })
      return opened
    },

    sendRevision: async (itemId, text, attachments) => {
      const initial = get()
      const address = selectedSendAddress(initial)
      if (!address || initial.sending || !text.trim() && !attachments.length) return false
      const { targetId, agent, threadId } = address
      const caps = AGENT_CAPABILITIES[agent]
      if (!caps.revert && !caps.fork) return false
      const key = sendKey(address)
      const sessionId = sessionKey(targetId, agent)
      const fail = (message: string) => {
        set({ error: message })
        return false
      }
      if (submitting.has(key) || initial.compactingThreads[key] || reconnectTask || !initial.eventsConnected) {
        return fail(t('会话正在处理消息或恢复连接，请稍后再试'))
      }
      const view = initial.sessions[sessionId]?.state.threads[threadId]
      if (view?.status === 'running') return fail(t('当前轮次仍在运行，请先停止再修改消息'))
      const turn = view?.turns?.find((item) => item.itemIds.includes(itemId))
      if (!view || !turn || !view.items.some((item) => item.id === itemId && item.kind === 'user' && !item.pending)) {
        return fail(t('未找到原消息的轮次，请重新打开会话后再试'))
      }
      if (!canReviseMessage(caps, false, itemId, turnOpeningMessages(view))) return fail(t('只能从开启一轮的消息分支重发'))
      const models = initial.models[sessionId]?.models ?? []
      // 修订沿用原会话的模型、推理强度与访问模式。
      const prefs = modelPrefsOf(initial, targetId, agent, threadId)
      const overrides = overridesFor(agent, models, prefs)
      const input = queuedInput(agent, { text, annotations: [], attachments, delegate: false })
      const selection = selectedAccessPreference(initial)
      if (!mobileTurnFits(targetId, agent, threadId, input, overrides, undefined, mobileTurnAccess(initial, agent, selection))) {
        return fail(t('消息和附件合计超过 1 MiB，请移除部分内容后再发送'))
      }
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      const isCurrent = () => epoch === desktopEpoch && navigation === navigationEpoch
      let reverted = false
      let branch: SendAddress | null = null
      submitting.add(key)
      set({ sending: true, error: null })
      try {
        const session = await withSession(targetId, agent, navigation)
        if (!session || !isCurrent()) return false
        if (agent === 'codex' && !session.resumedCodexThreads.has(threadId)) {
          await resumeCodexConversation(session, threadId, isCurrent)
          if (!isCurrent()) return false
        }
        if (caps.revert) {
          // 与 Codex app 一致：thread/revert 只改对话历史，不回退文件改动。
          const result = await session.rpc.request('thread/revert', { threadId, beforeTurnId: turn.id })
          if (result?.thread?.id !== threadId) throw new Error(t('电脑返回的会话与所选会话不一致，请重试'))
          reverted = true
          if (!isCurrent()) return false
          const history = await openThreadHistory(session.rpc, threadId, 'read', isCurrent)
          if (!isCurrent()) return false
          patchSession(session.key, (value) => {
            const live = value.state.threads[threadId]
            // 清空本地条目与轮次，避免被截掉的历史与新历史合并。
            const cleared = live ? { ...live, items: [], turns: [], plan: undefined } : undefined
            const base = cleared ? { threads: { ...value.state.threads, [threadId]: cleared } } : value.state
            return { ...value, state: loadRecentThreadHistory(base, history.thread, history.earlier, cleared) }
          }, session)
          await startMessageTurn(session, address, input, overrides, selection)
          return true
        }
        const live = () => get().sessions[session.key]?.state.threads[threadId]
        let point = branchPoint(live(), itemId)
        // 上一轮还没加载时向前翻页，直到能确定分支位置。
        while (point?.kind === 'earlier') {
          const cursor = live()?.historyCursor
          if (!cursor) break
          const page = await readThreadHistoryPage(session.rpc, threadId, cursor, isCurrent)
          if (!isCurrent()) return false
          patchSession(session.key, (value) => ({ ...value, state: prependThreadHistory(value.state, threadId, page) }), session)
          point = branchPoint(live(), itemId)
        }
        if (!point || point.kind === 'earlier') throw new Error(t('无法确定上一轮的位置，请重新打开会话后再试'))
        const cwd = currentCwd(get())
        const { thread } = point.kind === 'turn'
          // 分支回包不带轮次，历史由 openThread 重新读取，避免长会话超出手机的回包上限。
          ? await session.rpc.request('thread/fork', { threadId, lastTurnId: point.turnId, excludeTurns: true })
          : await startThread(session.rpc, cwd ? { cwd } : {})
        if (!thread?.id || thread.id === threadId) throw new Error(t('未确认新会话已创建，修改后的消息未发送'))
        if (!isCurrent()) return false
        branch = { ...address, threadId: thread.id }
        submitting.add(sendKey(branch))
        freshThreads.set(sendKey(branch), cwd || thread.cwd || '')
        if (agent === 'codex') session.resumedCodexThreads.add(thread.id)
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, thread) }), session)
        get().rememberThreadPrefs(targetId, agent, thread.id, prefs)
        const carried = carryPlanMode(address, thread.id, point.kind === 'turn' ? live()?.items : undefined)
        await startMessageTurn(session, branch, input, overrides, carried ?? selection)
        if (!isCurrent()) return true
        const notice = point.kind === 'turn' ? t('已从上一轮分出新会话发送，原会话保留') : t('已开新会话发送，原会话保留')
        await get().openThread(thread.id, agent)
        if (epoch === desktopEpoch) set({ notice })
        return true
      } catch (err) {
        if (isCurrent()) {
          const message = friendlyError(err, t('发送修订失败'))
          set({ error: reverted ? t('历史已回退，但修改后的消息未确认发送成功。{message}', { message: translateMessage(message) }) : message })
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          submitting.delete(key)
          if (branch) submitting.delete(sendKey(branch))
          set({ sending: false })
          if (get().selectedTargetId === targetId) void get().refreshThreads({ skipFailed: true })
          void flushQueue(address)
        }
      }
    },

    compactConversation: async () => {
      const initial = get()
      const address = selectedSendAddress(initial)
      if (!address || selectedCompactionBlockedReason(initial)) return false
      const key = sendKey(address)
      if (reconnectTask) {
        set({ error: t('会话正在处理消息或恢复连接，请稍后再压缩') })
        return false
      }
      const { targetId, agent, threadId } = address
      const session = initial.sessions[sessionKey(targetId, agent)]!
      // 会话在忙或前面还有排队内容时，压缩排到队尾。
      const enqueue = async () => {
        const item: QueuedSend = { id: makeId(), text: '/compact', annotations: [], attachments: [], delegate: false, overrides: {}, compact: true }
        set({ error: null })
        await updateQueue(key, (list) => list.some((entry) => entry.compact) ? list : [...list, item])
        void flushQueue(address)
        if (inBackground()) void handOffQueue(address)
        return true
      }
      const view = session.state.threads[threadId]!
      if (submitting.has(key) || initial.sending || view.status === 'running' || view.pendingApprovals.length > 0
        || initial.queuedSends[key]?.length) return enqueue()
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      const isCurrent = () => {
        const state = get()
        const selected = selectedSendAddress(state)
        return epoch === desktopEpoch && navigation === navigationEpoch && state.page === 'chat'
          && selected !== null && sendKey(selected) === key
      }
      set((state) => ({ compactingThreads: { ...state.compactingThreads, [key]: true }, error: null }))
      try {
        if (agent === 'codex' && !session.resumedCodexThreads.has(threadId)) await resumeCodexConversation(session, threadId)
        if (!isCurrent()) return false
        const state = get()
        const current = state.sessions[session.key]
        if (!state.eventsConnected || !current?.opened || current.transport !== session.transport || reconnectTask) {
          throw new Error(t('会话连接已中断，请重新打开后再压缩'))
        }
        const thread = current.state.threads[threadId]
        if (!thread || isArchived(address.desktopId, targetId, { agent, id: threadId })) throw new Error(t('请重新打开会话'))
        if (thread.status === 'running' || thread.pendingApprovals.length > 0) return await enqueue()
        if (queueLimited(address)) throw new Error(t('当前额度已用完'))

        await startThreadCompaction(session.rpc, threadId)
        return true
      } catch (err) {
        if (isCurrent()) {
          set({ error: t('压缩会话失败。{message}', { message: translateMessage(friendlyError(err, t('请稍后重试'))) }) })
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          set((state) => {
            const compactingThreads = { ...state.compactingThreads }
            delete compactingThreads[key]
            return { compactingThreads }
          })
          // 启动压缩期间发送的消息在排队；压缩没能开始时这里接着发送。
          void flushQueue(address)
          if (inBackground()) void handOffQueue(address)
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
        set({ error: t('请先选择目标') })
        return false
      }
      if (!keepDraft && queueingDrafts.has(key)) return false
      const images = initial.draftImages
      const draft = { text: images.length ? initial.draftText : text, annotations, images }
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      const sessionId = sessionKey(targetId, agent)
      let address = selectedSendAddress(initial)
      if (keepDraft && !address) return false
      let queueKey = address ? sendKey(address) : null
      const view = address ? initial.sessions[sessionId]?.state.threads[address.threadId] : undefined
      const models = initial.models[sessionId]?.models ?? []
      // 模型与推理强度按会话记：已有会话用它自己的选择（没记录时取历史配置），草稿用 agent 默认。
      const prefs = modelPrefsOf(initial, targetId, agent, initial.selectedThreadId)
      const hasImage = attachments.some((item) => item.type === 'image' || item.type === 'localImage')
      if (attachments.some((item) => item.type === 'localImage')
        || (hasImage && resolveSelection(models, prefs).model?.imageInput === false)) {
        set({ error: t('当前模型不支持此图片附件，或附件类型无效') })
        return false
      }
      const message = { text, annotations, attachments, delegate }
      const input = queuedInput(agent, message)
      const overrides = overridesFor(agent, models, prefs)
      const accessSelection = selectedAccessPreference(initial)
      const compactionStarting = !!(queueKey && initial.compactingThreads[queueKey])
      // 引导不可用时的去向：轮次已结束就按普通消息发送，压缩中、斜杠命令等转入排队。
      const plan = mode === 'steer' && address ? planSteer({ agent, view, input, compactionStarting }) : null
      if (!mobileTurnFits(targetId, agent, initial.selectedThreadId, input, overrides,
        plan?.route === 'steer' ? plan.turnId : undefined, mobileTurnAccess(initial, agent, accessSelection))) {
        set({ error: t('消息和附件合计超过 1 MiB，请移除部分内容后再发送') })
        return false
      }

      const clearSentDraft = (sentDraftKey: string) => {
        if (keepDraft) return
        const current = drafts[sentDraftKey]
        if (!current) return
        if (current.text === draft.text && current.annotations === draft.annotations && (!images.length || current.images === images)) {
          saveDraft(sentDraftKey, { text: '', annotations: [] })
        } else if (images.length && current.images?.some((image) => images.includes(image))) {
          const sent = current.images.filter((image) => images.includes(image))
          saveDraft(sentDraftKey, {
            text: stripAttachmentPlaceholders(current.text, sent),
            annotations: current.annotations,
            images: current.images.filter((image) => !images.includes(image)),
          })
        }
      }
      // 发送（含排队）时把实际使用的选择固定到会话上，之后改默认不会再影响它。
      const rememberPrefs = (threadId: string) => {
        if (epoch !== desktopEpoch) return
        const remembered = get().modelPrefs[threadPrefsKey(sessionId, threadId)]
        if (remembered?.model !== prefs.model || remembered?.effort !== prefs.effort || remembered?.fast !== prefs.fast) {
          get().rememberThreadPrefs(targetId, agent, threadId, prefs)
        }
      }
      const enqueue = async (chat: SendAddress, sentDraftKey: string, error?: string) => {
        const chatKey = sendKey(chat)
        rememberPrefs(chat.threadId)
        const item: QueuedSend = { ...message, id: makeId(), overrides, saving: true, ...(error ? { error } : {}) }
        if (!keepDraft) queueingDrafts.add(sentDraftKey)
        try {
          // 带错误入队的是打断失败的消息，本来就要优先送出：放到队首并暂停，等用户确认。
          await updateQueue(chatKey, (list) => error ? [item, ...list] : [...list, item])
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
      if (address && queueKey) {
        const busy = submitting.has(queueKey)
        const offline = !initial.eventsConnected || !!initial.sessions[sessionId]?.linkInterrupted
        const waiting = busy || offline || view?.status === 'running' || !!initial.queuedSends[queueKey]?.length
        if (compactionStarting || plan?.route === 'queue' || (plan?.route === 'steer' && (busy || offline)) ||
          ((mode === 'queue' || plan?.route === 'send') && waiting)) {
          if (!keepDraft) saveDraft(key, draft)
          set({ error: null })
          return enqueue(address, key)
        }
      }
      if (initial.sending || (queueKey && submitting.has(queueKey))) return false
      if (!keepDraft) saveDraft(key, draft)
      set({ sending: true, error: null })
      if (queueKey) submitting.add(queueKey)
      // 引导本身结果未确认时不动队列；改走普通发送后，失败时与普通发送一样暂停队列。
      let startingTurn = mode !== 'steer'
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
          freshThreads.set(queueKey, cwd || created.thread.cwd || '')
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
        rememberPrefs(threadId)
        let current = get().sessions[session.key]?.state.threads[threadId]
        if (plan?.route === 'steer') {
          // 等待连接期间轮次可能已结束或切换，按最新状态再判断一次。
          const latest = planSteer({ agent, view: current, input, expectedTurnId: plan.turnId })
          let rejected = false
          if (latest.route === 'steer') {
            const steerId = makeId()
            const record = trackSteer(address, steerId, latest.turnId, { ...message, overrides })
            try {
              await steerTurn(session.rpc, threadId, latest.turnId, input, steerId)
              if (epoch === desktopEpoch) {
                clearSentDraft(sentDraftKey)
                acceptSteer(record)
              }
              return true
            } catch (err) {
              steers.delete(steerId)
              // 只有明确拒绝才改走其他路径；结果未确认时保留草稿，避免重复发送。
              if (!isSteerRejected(err) || epoch !== desktopEpoch) throw err
              rejected = true
            }
            current = get().sessions[session.key]?.state.threads[threadId]
          }
          if (current?.status === 'running' || get().queuedSends[queueKey]?.length) {
            if (rejected) set({ notice: t('当前无法引导，消息已排队') })
            return await enqueue(address, sentDraftKey)
          }
          // 轮次刚结束，继续按普通消息发送。
          startingTurn = true
        }
        if (current?.status === 'running') {
          if (mode !== 'immediate') return await enqueue(address, sentDraftKey)
          try {
            const turnId = current.activeTurnId
            if (!turnId) throw new Error(t('暂未收到当前轮次，请稍后重试'))
            replacing.add(queueKey)
            await interruptAndWait(session, threadId, turnId)
            if (epoch !== desktopEpoch) return false
            if (navigation !== navigationEpoch) throw new Error(t('会话已切换，请重新打开后发送'))
            if (get().sessions[session.key]?.state.threads[threadId]?.status === 'running') {
              throw new Error(t('会话已开始另一轮，请检查后再发送'))
            }
            replacing.delete(queueKey)
          } catch (err) {
            if (epoch !== desktopEpoch) return false
            if (navigation === navigationEpoch) set({ error: friendlyError(err, t('未确认当前一轮已停止，请检查会话后重试')) })
            // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
            return await enqueue(address, sentDraftKey, '打断未成功，消息已保留在队列')
          }
        }
        await startMessageTurn(session, address, input, overrides, accessSelection)
        if (epoch !== desktopEpoch) return true
        clearSentDraft(sentDraftKey)
        return true
      } catch (err) {
        if (epoch === desktopEpoch && navigation === navigationEpoch) {
          set({ error: friendlyError(err, t('未确认消息已发送，草稿已保留')) })
        }
        if (epoch === desktopEpoch && queueKey && startingTurn) {
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
          // 发送期间切到后台时这条会话没能交给电脑，结束后补交排队消息。
          if (address && inBackground()) void handOffQueue(address)
        }
      }
    },

    removeQueuedSend: (id) => {
      const address = selectedSendAddress(get())
      if (!address) return
      const key = sendKey(address)
      const item = get().queuedSends[key]?.find((entry) => entry.id === id)
      if (item && !item.relayPending && !item.sending && !item.saving && !editingQueue.has(id) && !savingQueue.has(id)) void dropQueuedSend(key, id)
    },

    beginQueuedEdit: (id) => {
      const address = selectedSendAddress(get())
      if (!address) return null
      const item = get().queuedSends[sendKey(address)]?.find((entry) => entry.id === id)
      if (!item || item.compact || item.relayPending || item.sending || item.saving || savingQueue.has(id) || editingQueue.has(id)) return null
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
        || !mobileTurnFits(address.targetId, address.agent, address.threadId, input, item.overrides, undefined,
          mobileTurnAccess(get(), address.agent, accessPreference(get(), address) ?? item.accessMode))) return false
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
      if (!address || !state.eventsConnected) return false
      const { targetId, agent, threadId } = address
      const key = sendKey(address)
      const session = state.sessions[sessionKey(targetId, agent)]
      const view = session?.state.threads[threadId]
      const item = state.queuedSends[key]?.find((entry) => entry.id === id)
      if (!session?.opened || !item || item.compact || item.relayPending || item.sending || item.saving
        || submitting.has(key) || editingQueue.has(id) || savingQueue.has(id)) return false
      const input = queuedInput(agent, item)
      const plan = planSteer({ agent, view, input, compactionStarting: !!state.compactingThreads[key] })
      if (plan.route !== 'steer') {
        if (plan.route === 'queue') set({ notice: t('当前无法引导，消息继续排队') })
        return false
      }
      const { turnId } = plan
      if (!mobileTurnFits(targetId, agent, threadId, input, {}, turnId)) {
        set({ error: t('消息和附件合计超过 1 MiB，请重新编辑后再引导') })
        return false
      }
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      // 轮次已结束、切换或 Agent 拒绝时消息照常排队；本轮若是被停止或失败结束，暂停等用户确认，不自动续发。
      const keepQueued = () => {
        const activity = get().sessions[session.key]?.state.threads[threadId]?.activity
        const stopped = activity === 'interrupted' || activity === 'failed'
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        const error = stopped ? '上一轮未完成，队列已暂停' : item.error
        void updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: false, error } : entry))
        if (navigation === navigationEpoch) set({ notice: t('当前无法引导，消息继续排队') })
        return false
      }
      const steerId = makeId()
      submitting.add(key)
      set({ error: null })
      try {
        await updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: true } : entry))
        if (epoch !== desktopEpoch) return false
        const current = get().sessions[session.key]
        if (!get().eventsConnected || !current?.opened) {
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          throw new Error('连接已中断，排队消息已保留')
        }
        if (current.state.threads[threadId]?.activeTurnId !== turnId) return keepQueued()
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        if (queueLimited(address)) throw new Error('当前额度已用完，排队消息已保留')
        const { text, annotations, attachments, delegate, overrides } = item
        const record = trackSteer(address, steerId, turnId, { text, annotations, attachments, delegate, overrides })
        await steerTurn(session.rpc, threadId, turnId, input, steerId)
        if (epoch === desktopEpoch) {
          void dropQueuedSend(key, id)
          acceptSteer(record)
        }
        return true
      } catch (err) {
        steers.delete(steerId)
        if (epoch === desktopEpoch) {
          if (isSteerRejected(err)) return keepQueued()
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          const error = friendlyError(err, '未确认引导成功，排队消息已保留')
          void updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: false, error } : entry))
          if (navigation === navigationEpoch) set({ error })
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          submitting.delete(key)
          void flushQueue(address)
          if (inBackground()) void handOffQueue(address)
        }
      }
    },

    interruptQueuedSend: async (id) => {
      const state = get()
      const address = selectedSendAddress(state)
      if (!address || !state.eventsConnected || reconnectTask) return false
      const { targetId, agent, threadId } = address
      const key = sendKey(address)
      const session = state.sessions[sessionKey(targetId, agent)]
      const view = session?.state.threads[threadId]
      const item = state.queuedSends[key]?.find((entry) => entry.id === id)
      // 队列交给电脑代发期间不能再从手机发送，否则同一条会发两次。
      if (!session?.opened || session.linkInterrupted || view?.status !== 'running' || !item || item.compact || item.relayPending || item.sending || item.saving
        || submitting.has(key) || editingQueue.has(id) || savingQueue.has(id) || state.compactingThreads[key]
        || remoteQueues.has(key) || handingOff.has(key) || takeBackTask) return false
      const turnId = view.activeTurnId
      if (!turnId) {
        set({ notice: t('暂未收到当前轮次，请稍后重试') })
        return false
      }
      // 先确认这条消息能发出去，再打断当前一轮。
      if (queueLimited(address)) {
        set({ error: t('当前额度已用完，排队消息已保留') })
        return false
      }
      const input = queuedInput(agent, item)
      const mode = accessPreference(state, address) ?? item.accessMode
      if (!mobileTurnFits(targetId, agent, threadId, input, item.overrides, undefined, mobileTurnAccess(state, agent, mode))) {
        set({ error: t('消息和附件合计超过 1 MiB，请重新编辑后再发送') })
        return false
      }
      const epoch = desktopEpoch
      const streamEpoch = eventStreamEpoch
      let stopped = false
      submitting.add(key)
      // 这次中断是为了换上新消息，不能按“上一轮未完成”暂停队列。
      replacing.add(key)
      set({ error: null })
      try {
        await updateQueue(key, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: true, error: undefined } : entry))
        if (epoch !== desktopEpoch) return false
        if (agent === 'codex' && !session.resumedCodexThreads.has(threadId)) {
          await resumeCodexConversation(session, threadId)
          if (epoch !== desktopEpoch) return false
        }
        await interruptAndWait(session, threadId, turnId)
        if (epoch !== desktopEpoch) return false
        replacing.delete(key)
        if (get().sessions[session.key]?.state.threads[threadId]?.status === 'running') {
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          throw new Error('会话已开始另一轮，请检查后再发送')
        }
        stopped = true
        await startMessageTurn(session, address, input, item.overrides, mode)
        if (epoch === desktopEpoch) void dropQueuedSend(key, id)
        return true
      } catch (err) {
        if (epoch === desktopEpoch) {
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          const message = friendlyError(err, stopped ? '排队消息未发送' : '打断未成功，消息已保留在队列')
          const code = isRecord(err) ? errorCode(err.data) : ''
          const replyLost = code === 'network' || code === 'timeout' || message.startsWith('Codex request timed out:')
          // turn/start 发出后丢失回包时可能已经在电脑执行。
          const error = stopped && (streamEpoch !== eventStreamEpoch || replyLost) ? UNCONFIRMED_QUEUED_SEND : message
          // 没送出的消息本来要优先发送：放到队首并暂停，等用户确认。
          void updateQueue(key, (list) => {
            const failed = list.find((entry) => entry.id === id)
            return failed ? [{ ...failed, sending: false, error }, ...list.filter((entry) => entry.id !== id)] : list
          })
          set({ error })
        }
        return false
      } finally {
        if (epoch === desktopEpoch) {
          submitting.delete(key)
          replacing.delete(key)
          void flushQueue(address)
          if (inBackground()) void handOffQueue(address)
        }
      }
    },

    dropPendingSteers: (ids) => {
      const address = selectedSendAddress(get())
      if (!address || ids.length === 0) return
      // 已回显，或用户自己处理了占位：不再判断送达，避免重复放回队列。
      for (const id of ids) steers.delete(id)
      const key = sendKey(address)
      set((state) => {
        const pendingSteers = withoutPendingSteers(state.pendingSteers, key, ids)
        return pendingSteers === state.pendingSteers ? state : { pendingSteers }
      })
    },

    sendQueuedInNewThread: async (id, mode) => {
      const state = get()
      const address = selectedSendAddress(state)
      if (!address || !state.eventsConnected || reconnectTask || state.sending) return false
      const { targetId, agent, threadId } = address
      if (mode === 'continue' && !AGENT_CAPABILITIES[agent].fork) return false
      const key = sendKey(address)
      const session = state.sessions[sessionKey(targetId, agent)]
      const item = state.queuedSends[key]?.find((entry) => entry.id === id)
      if (!session?.opened || !item || item.compact || item.relayPending || item.sending || item.saving || submitting.has(key)
        || editingQueue.has(id) || savingQueue.has(id) || state.compactingThreads[key]) return false
      if (queueLimited(address)) {
        set({ error: t('当前额度已用完，排队消息已保留') })
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
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          if (!lastTurn) throw new Error('当前还没有已结束的一轮，可用「新会话开始」')
          // 指定已结束的轮次，分支时不会带入原会话正在执行的工作。
          result = await session.rpc.request('thread/fork', { threadId, lastTurnId: lastTurn.id, excludeTurns: true })
        } else {
          const cwd = currentCwd(state)
          result = await startThread(session.rpc, cwd ? { cwd } : {})
        }
        const { thread } = result
        if (!isCurrent()) return false
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        if (!thread?.id || thread.id === threadId) throw new Error('未确认新会话已创建，排队消息已保留')
        created = true
        checkConnection()
        // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
        if (queueLimited(address)) throw new Error('当前额度已用完，排队消息已保留')
        // 原会话的授权只适用于原会话；计划模式更严格，带到新会话。
        const selection = carryPlanMode(address, thread.id,
          mode === 'continue' ? get().sessions[session.key]?.state.threads[threadId]?.items : undefined)
        if (!mobileTurnFits(targetId, agent, thread.id, input, item.overrides, undefined, mobileTurnAccess(get(), agent, selection))) {
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          throw new Error('消息和附件合计超过 1 MiB，请重新编辑后再发送')
        }
        if (agent === 'codex') session.resumedCodexThreads.add(thread.id)
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, thread) }), session)
        // 新会话沿用原会话的模型与推理强度。
        get().rememberThreadPrefs(targetId, agent, thread.id,
          inheritedModelPrefs(modelPrefsOf(get(), targetId, agent, threadId), item.overrides))
        submitted = true
        freshThreads.set(sendKey({ ...address, threadId: thread.id }), currentCwd(state) || thread.cwd || '')
        await startMessageTurn(session, { ...address, threadId: thread.id }, input, item.overrides, selection)
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
          const modeChanged = isRecord(err) && errorCode(err.data) === 'access_mode_changed'
          // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
          const error = submitted && !modeChanged ? UNCONFIRMED_QUEUED_SEND : friendlyError(err, '新会话发送失败，排队消息已保留')
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
              // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
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
      if (!first?.error || first.relayPending || first.sending || first.saving || editingQueue.has(first.id) || savingQueue.has(first.id)
        || submitting.has(key) || !get().eventsConnected) return
      const epoch = desktopEpoch
      const navigation = navigationEpoch
      submitting.add(key)
      try {
        const session = await withSession(address.targetId, address.agent, navigation)
        if (!session) return
        const isCurrent = () => epoch === desktopEpoch && navigation === navigationEpoch && first.id === get().queuedSends[key]?.[0]?.id
        const before = get().sessions[session.key]?.state.threads[address.threadId]
        const { thread, earlier } = await openThreadHistory(session.rpc, address.threadId, address.agent === 'codex' ? 'resume' : 'read', isCurrent)
        if (!isCurrent()) return
        if (address.agent === 'codex') session.resumedCodexThreads.add(address.threadId)
        patchSession(session.key, (value) => ({
          ...value, state: loadRecentThreadHistory(value.state, thread, earlier, before),
        }), session)
      } catch (err) {
        if (epoch === desktopEpoch && navigation === navigationEpoch) set({ error: friendlyError(err, t('无法恢复队列')) })
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
      const turnId = interruptTurnIdOf(session?.state.threads[selectedThreadId])
      if (session && turnId !== null) await interruptTurn(session.rpc, selectedThreadId, turnId)
    },

    respondApproval: (requestId, decision) => replyServerRequest(
      requestId,
      (approval, agent) => availableApprovalDecisions(approval, agent).includes(decision) ? null : t('当前请求不支持该审批选项'),
      (approval) => mobileApprovalReply(approval, decision),
    ),

    respondUserInput: (requestId, answers) => replyServerRequest(
      requestId,
      (approval) => approval.questions?.length ? null : t('当前请求不支持该审批选项'),
      (approval) => userAnswerResponse(approval, answers),
    ),

    loadModels: async (targetId, agent, force = false) => {
      const key = sessionKey(targetId, agent)
      const current = get().models[key]
      const staleEmpty =
        current !== undefined &&
        current.models.length === 0 &&
        Date.now() - (current.loadedAt ?? 0) > EMPTY_MODELS_RETRY_MS
      // 强制刷新（如 Claude 真实模型表就绪）不与进行中的请求合并：旧请求可能还会返回别名表。
      if ((current?.loading && !force) || (current && !current.error && !force && !staleEmpty)) return
      const session = get().sessions[key]
      if (!session?.opened) return
      const pending = { models: current?.models ?? [], loading: true, error: null }
      // 只认最后一次发出的请求，较早返回的旧结果丢弃。
      const isCurrent = () => get().sessions[key]?.transport === session.transport && get().models[key] === pending
      set((state) => ({
        models: { ...state.models, [key]: pending },
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
            [key]: { models: current?.models ?? [], loading: false, error: friendlyError(err, t('加载模型列表失败')), loadedAt: Date.now() },
          },
        }))
      }
    },

    setModelPrefs: (targetId, agent, prefs, threadId) => {
      if (!get().activeId) return
      if (threadId) get().rememberThreadPrefs(targetId, agent, threadId, prefs)
      const { seen: _seen, ...defaults } = prefs
      saveModelPrefs({ ...get().modelPrefs, [agent]: defaults })
    },

    rememberThreadPrefs: (targetId, agent, threadId, prefs) => {
      const sessionId = sessionKey(targetId, agent)
      // 记下改选时会话历史的配置；之后历史变了才说明是另一端换过模型。
      const saved = get().sessions[sessionId]?.state.threads[threadId]?.savedConfig
      const record = !prefs.seen && saved ? { ...prefs, seen: { model: saved.model, effort: saved.effort } } : prefs
      saveModelPrefs(putThreadPrefs(get().modelPrefs, threadPrefsKey(sessionId, threadId), record))
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
            error: limits.status === 'rejected' ? friendlyError(limits.reason, t('读取额度失败')) : null,
          }
          if (snapshot) changes.snapshot = snapshot
          if (accountInfo) changes.account = accountInfo
          if (limits.status === 'fulfilled') changes.resetCredits = pickResetCredits(limits.value)
          if (snapshot || accountInfo) changes.updatedAt = Date.now()
          patchRate(targetId, changes)
        } catch (err) {
          if (epoch === desktopEpoch) patchRate(targetId, { loading: false, error: friendlyError(err, t('读取额度失败')) })
        } finally {
          if (epoch === desktopEpoch) rateRefresh.delete(targetId)
        }
      })()
      rateRefresh.set(targetId, task)
      return task
    },

    refreshAccountUsage: async (targetId) => {
      const busy = usageRefresh.get(targetId)
      if (busy) return busy
      const session = get().sessions[sessionKey(targetId, 'codex')]
      // 不为读用量单独启动 Codex（Agent 适配规范 R9），未打开时保持现状。
      if (!session?.opened) return
      // Agent 适配规范 §4：账号接口刷新间隔不少于 60 秒，期间沿用已读到的结果。
      const last = get().rateLimits[targetId]?.usageUpdatedAt
      if (last != null && Date.now() - last < ACCOUNT_USAGE_MIN_INTERVAL_MS) return
      const epoch = desktopEpoch
      const rpc = session.rpc
      patchRate(targetId, { usageLoading: true })
      const task = (async () => {
        try {
          const usage = pickAccountUsage(await rpc.request('account/usage/read', {}))
          if (epoch !== desktopEpoch || get().sessions[session.key]?.rpc !== rpc) return
          patchRate(targetId, { usage, usageLoading: false, usageError: null, usageUpdatedAt: Date.now() })
        } catch (err) {
          // 旧版 Codex 没有该方法时同样落到这里，界面提示读取失败即可。
          if (epoch === desktopEpoch) patchRate(targetId, { usageLoading: false, usageError: friendlyError(err, t('读取总用量失败')) })
        } finally {
          if (epoch === desktopEpoch) usageRefresh.delete(targetId)
        }
      })()
      usageRefresh.set(targetId, task)
      return task
    },

    consumeResetCredit: async (targetId, creditId) => {
      const session = get().sessions[sessionKey(targetId, 'codex')]
      if (!session?.opened || !get().eventsConnected || get().rateLimits[targetId]?.resetting) return
      const epoch = desktopEpoch
      patchRate(targetId, { resetting: true, resetNotice: null })
      // 幂等键按电脑和目标区分，切换电脑后不串用。
      const resetNotice = await redeemResetCredit(session.rpc, JSON.stringify([get().activeId, targetId]), creditId)
      if (epoch !== desktopEpoch) return
      patchRate(targetId, { resetNotice })
      // 兑换前发起的读取结果已过时，等它结束后再读一次；读完才恢复按钮。
      await rateRefresh.get(targetId)
      await get().refreshRateLimits(targetId)
      if (epoch === desktopEpoch) patchRate(targetId, { resetting: false })
    },

    refreshClaudeRateLimits: async (targetId) => {
      const session = get().sessions[sessionKey(targetId, 'claude')]
      return session?.opened ? readClaudeRateLimits(session) : false
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
        if (!result) throw new Error(t('电脑返回的文件内容格式不正确'))
        patchViewer(token, { loading: false, file: result })
      } catch (err) {
        patchViewer(token, { loading: false, error: viewerError(err, t('读取文件失败')) })
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
        if (!next) throw new Error(t('电脑返回的文件内容格式不正确'))
        const current = token === viewerToken ? get().viewer?.file : null
        patchViewer(token, { loadingMore: false, file: current ? appendRead(current, next) : next })
      } catch (err) {
        patchViewer(token, { loadingMore: false, error: viewerError(err, t('加载更多失败')) })
      }
    },

    openDiff: async (request) => {
      const targetId = get().selectedTargetId
      if (!targetId || !request.path) return
      // 只显示 Agent 改动卡片自带的 diff，不再读取 Git 工作区。
      const diff = typeof request.diff === 'string' && request.diff.trim() ? request.diff : null
      viewerToken += 1
      set({
        viewer: {
          mode: 'diff',
          targetId,
          path: request.path,
          cwd: currentCwd(get()),
          line: null,
          loading: false,
          loadingMore: false,
          error: diff ? null : t('这次改动没有附带差异'),
          file: null,
          diff,
          diffSource: diff ? 'card' : null,
          diffTruncated: false,
          notice: null,
        },
      })
    },

    closeViewer: () => {
      viewerToken += 1
      set({ viewer: null })
    },

    addAnnotation: (quote, comment = '') => {
      const value = quote.trim()
      const key = currentDraftKey()
      if (!value || !key) return
      const { draftText, draftImages, annotations } = get()
      saveDraft(key, { text: draftText, images: draftImages, annotations: [...annotations, { id: makeId(), quote: value, comment }] })
    },

    updateAnnotation: (id, comment) => {
      const key = currentDraftKey()
      if (!key) return
      const { draftText, draftImages, annotations } = get()
      saveDraft(key, { text: draftText, images: draftImages, annotations: annotations.map((item) => (item.id === id ? { ...item, comment } : item)) })
    },

    removeAnnotation: (id) => {
      const key = currentDraftKey()
      if (!key) return
      const { draftText, draftImages, annotations } = get()
      saveDraft(key, { text: draftText, images: draftImages, annotations: annotations.filter((item) => item.id !== id) })
    },

    handleGatewayEvent: (event) => {
      if (isHeartbeat(event)) return
      switch (event.name) {
        case 'settings.access':
          void get().loadAgentSettings()
          return
        case 'mobile.queue':
          applyRelayUpdate(event.payload)
          return
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
            targetLinkEpochs.set(id, (targetLinkEpochs.get(id) ?? 0) + 1)
            clearClaudeQuota(id)
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== id) continue
              session.loadedThreads.clear()
              session.resumedCodexThreads.clear()
              if (session.opened) patchSession(session.key, (value) => ({
                ...value, opened: record?.state !== 'idle', linkInterrupted: record?.state !== 'idle',
              }), session)
            }
          }
          if (record?.state === 'error') {
            const detail = typeof record.detail === 'string' ? record.detail : t('连接失败')
            const message = hostKeyMessage({ message: detail }, t('连接失败'))
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
            const epoch = desktopEpoch
            const desktopId = get().activeId
            void (async () => {
              if (reconnectTask) await reconnectTask.catch(() => undefined)
              if (epoch !== desktopEpoch || !desktopId || !get().eventsConnected || get().targetStates[id]?.state !== 'ready') return
              if (Object.values(get().sessions).some((session) => session.targetId === id && session.linkInterrupted)) {
                await get().attachOpened(id)
                if (epoch !== desktopEpoch) return
                for (const address of pendingQueueAddresses(desktopId)) {
                  if (address.targetId === id) void flushQueue(address)
                }
              }
              if (get().selectedTargetId === id && get().selectedProjectId) void get().refreshThreads()
            })()
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
          const eventDesktop = get().activeId
          if (eventDesktop && targetId && typeof payload?.name === 'string') {
            for (const listener of serverEvtListeners) listener(eventDesktop, targetId, payload.name, payload.payload)
          }
          if (payload?.name === 'server.restarted' && targetId) {
            clearClaudeQuota(targetId)
            for (const session of Object.values(get().sessions)) {
              if (session.targetId === targetId) {
                patchSession(session.key, (value) => ({ ...value, accessSupported: undefined }), session)
              }
            }
          }
          if (payload?.name === 'codex.exited' && targetId) {
            const agent = exitedAgent(payload)
            const desktopId = get().activeId
            if (desktopId) {
              // i18n-ignore: 随发送队列持久化，展示时用 translateMessage 翻译
              pauseQueues(agent ? [desktopId, targetId, agent] : [desktopId, targetId], 'Agent 已退出，队列已暂停')
            }
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== targetId || (agent !== null && session.agent !== agent)) continue
              session.loadedThreads.clear()
              session.resumedCodexThreads.clear()
              clearPendingApprovals(session)
              patchSession(session.key, (value) => ({
                ...value,
                state: failActiveThreads(value.state, t('{agent} 进程已退出', { agent: agentLabel(value.agent) })),
                opened: false,
                openError: t('{agent} 进程已退出，下次操作将重新启动', { agent: agentLabel(value.agent) }),
              }))
            }
            if (agent === null || agent === 'codex') patchRate(targetId, emptyRateLimit())
            if (agent === null || agent === 'claude') clearClaudeQuota(targetId)
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
          if (id) markRepair(id, 'unauthorized', t('设备已被撤销，请重新配对'))
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
