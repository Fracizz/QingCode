import { create } from 'zustand'
import {
  createDeltaBuffer,
  isStreamDelta,
  CodexRpc,
  DRAFT_THREAD_ID,
  addOptimisticUser,
  applyNotification,
  applyServerRequest,
  approvalResponse,
  archiveThread,
  clearDraftThread,
  deleteThread,
  dropOptimisticUsers,
  forkThread,
  emptyState,
  failActiveThreads,
  interruptTurn,
  isActiveThread,
  isOversizeHistoryResponse,
  listThreads,
  loadRecentThreadHistory,
  loadThread,
  moveOptimisticUsers,
  openThreadHistory,
  prependThreadHistory,
  readThreadHistoryPage,
  requestSubagents,
  resolveServerRequest,
  sendInput,
  sessionStatus,
  setThreadName,
  startThread,
  steerTurn,
  supportsSubagentRequests,
  t,
  userItemFromInput,
  type ApprovalDecision,
  type ApprovalView,
  type ConversationState,
  type ItemView,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
  type UserInput,
  type TurnOverrides,
} from '@qn/codex-client'
import type { ServerResult } from '@qn/protocol'
import type { AgentKind } from '../../../shared/backendApi'
import { call, on } from '../lib/backend'
import { canContinueQueued, canSteerQueued, replacePendingText, type PendingThreadMode } from './pendingQueue'
import { attachResult, BackendCodexTransport, maxSeq, openSeq } from '../lib/codexTransport'
import { describeCodexOpenError, friendlyError, isActiveWriterError } from '../lib/errors'
import { mergeThreadSummaries, nextCopyTitle, refreshThreadOrder, toThreadSummaries, withLocalThreads, type ThreadSummary } from '../lib/threads'
import { archivedThreadSummaries, isInactiveForArchive } from '../lib/threadPrefs'
import {
  AGENTS,
  DEFAULT_AGENT,
  agentLabel,
  classifyAgentOpenError,
  emptyAgentStatus,
  preferredAgent,
  exitedAgentOf,
  sessionKey,
  type AgentAvailability,
} from '../lib/agents'
import { buildAnnotatedMessage, type Annotation } from '../lib/annotations'
import { agentPrefs } from '../features/settings/settingsModel'
import { useSettings } from '../features/settings/settingsStore'
import { adaptTurnInput } from '../features/composer/agentInput'
import { turnInputSizeProblem } from '../features/composer/images'
import {
  emptyAccessMemory,
  getAccessMode,
  getAccessSelection,
  rememberAccessMode,
  resetDraftAccess,
  resetTargetAccess,
  targetAgentKeyPrefix,
  turnAccessOverride,
  type AccessAddress,
  type AccessMemory,
  type AccessSelection,
} from '../features/access/accessModel'
import { configuredAgentOpen } from '../features/access/openConfig'
import { threadKey } from '../lib/threads'
import { useDock } from './dock'
import { useAgentPrefs } from './agentPrefs'
import { overridesFor, prefsFor, useModels } from './models'
import { useTargets } from './targets'
import { useThreadPrefs } from './threadPrefs'

type TargetSession = {
  key: string
  targetId: string
  agent: AgentKind
  rpc: CodexRpc
  transport: BackendCodexTransport
  state: ConversationState
  threadsAwaitingResume: ReadonlySet<string>
  opened: boolean
  openedConfig: { directory: string | undefined; accessModes: boolean; ephemeralNoTools?: boolean } | null
  opening: boolean
  openError: string | null
  openFailure: unknown
  agentVersion: string | null
  lastSeq: number | null
}

export type SendMode = 'queue' | 'steer' | 'immediate'

type SendOptions = {
  agent?: AgentKind
  targetId?: string
  threadId?: string
  /** 完整输入（含图片/附件/技能）；不传则只发 text。 */
  input?: UserInput[]
  mode?: SendMode
  onThreadCreated?: (threadId: string) => void
  sideKey?: string
  delegate?: boolean
}

type ChatAddress = { targetId: string; agent: AgentKind; threadId: string }
type PendingUser = Extract<ItemView, { kind: 'user' }>

type PendingSend = {
  id: number
  text: string
  input: UserInput[]
  overrides: TurnOverrides
  sending?: boolean
  error?: string
}

export function pendingSendKey({ targetId, agent, threadId }: ChatAddress): string {
  return JSON.stringify([targetId, agent, threadId])
}

type SideChatState = {
  targetId: string
  agent: AgentKind
  cwd: string | null
  parentThreadId: string
  threadId: string | null
  draft: string
  annotations: Annotation[]
  open: boolean
  busy: boolean
  firstMessage: string
  expired: boolean
  error: string | null
}

export function currentChatKey(state: CodexState): string {
  return JSON.stringify([state.currentTargetId, state.currentCwd, state.currentAgent, state.currentThreadId])
}

export function composerDraftKey(state: CodexState): string {
  return state.currentThreadId === null
    ? `draft:${state.composerDraftRevision}:${JSON.stringify([state.currentTargetId, state.currentCwd])}`
    : currentChatKey(state)
}

export function currentSideChat(state: CodexState) {
  return state.sideChats[currentChatKey(state)]
}

const noApprovals: readonly ApprovalView[] = []

function isMainChat(state: CodexState, { targetId, agent, threadId }: ChatAddress): boolean {
  return state.currentTargetId === targetId && state.currentAgent === agent && state.currentThreadId === threadId
}

function openingAnotherChat(state: CodexState): boolean {
  return !!state.openingThread && !isMainChat(state, state.openingThread)
}

export function currentThreadApprovals(state: CodexState): readonly ApprovalView[] {
  const { currentTargetId, currentAgent, currentThreadId } = state
  if (!currentTargetId || !currentThreadId || openingAnotherChat(state)) return noApprovals
  return state.sessions[sessionKey(currentTargetId, currentAgent)]?.state.threads[currentThreadId]?.pendingApprovals ?? noApprovals
}

export function currentSideApprovals(state: CodexState): readonly ApprovalView[] {
  const side = currentSideChat(state)
  if (!side?.open || side.expired || !side.threadId || openingAnotherChat(state)) return noApprovals
  return state.sessions[sessionKey(side.targetId, side.agent)]?.state.threads[side.threadId]?.pendingApprovals ?? noApprovals
}

type ThreadListScope = { targetId: string; cwd: string | null }
type ThreadListState = ThreadListScope & { threads: ThreadSummary[]; loading: boolean; error: string | null }

const threadListKey = ({ targetId, cwd }: ThreadListScope) => JSON.stringify([targetId, cwd])
const noThreads: ThreadSummary[] = []

export function threadListFor(state: CodexState, targetId: string, cwd: string | null): ThreadListState | undefined {
  return state.threadLists[threadListKey({ targetId, cwd })]
}

/** 分支会话的新标题：在该目标已加载的同 agent 会话里找同名系列，原会话不在列表里时不改名。 */
function forkedThreadTitle(state: CodexState, targetId: string, agent: AgentKind, sourceId: string): string | null {
  const threads = Object.values(state.threadLists)
    .filter((list) => list.targetId === targetId)
    .flatMap((list) => list.threads)
    .filter((thread) => thread.agent === agent)
  const source = threads.find((thread) => thread.id === sourceId)
  return source ? nextCopyTitle(source.title, threads.map((thread) => thread.title)) : null
}

export function currentThreads(state: CodexState): ThreadSummary[] {
  return (state.currentTargetId && threadListFor(state, state.currentTargetId, state.currentCwd)?.threads) || noThreads
}

type CodexState = {
  sessions: Record<string, TargetSession>
  agents: Record<string, Record<AgentKind, AgentAvailability>>
  currentTargetId: string | null
  currentCwd: string | null
  currentThreadId: string | null
  currentAgent: AgentKind
  threadLists: Record<string, ThreadListState>
  sending: boolean
  sendingMessage: { key: string; preview?: PendingUser } | null
  access: AccessMemory
  composerDraftRevision: number
  pendingSends: Record<string, PendingSend[]>
  error: string | null
  notice: string | null
  sideChats: Record<string, SideChatState>
  init: () => () => void
  setContext: (targetId: string | null, cwd: string | null, refresh?: boolean) => void
  ensureOpen: (targetId: string, agent?: AgentKind) => Promise<boolean>
  probeAgents: (targetId: string) => Promise<void>
  refreshThreads: (scope?: ThreadListScope) => Promise<void>
  listArchivedThreads: (targetId: string) => Promise<{ threads: ThreadSummary[]; error: string | null }>
  restoreThread: (targetId: string, thread: ThreadSummary) => Promise<void>
  newThread: (agent?: AgentKind, onDraftCreated?: (threadId: string) => void) => Promise<void>
  /** 回到"新会话"草稿态（参考 Codex 的 New thread）：不立即建会话，发第一条消息时再创建，避免留下空会话。 */
  startDraft: (agent?: AgentKind) => void
  /** 草稿态下切换下一条消息使用的 Agent；已打开会话时 Agent 跟随会话，不可切换。 */
  setDraftAgent: (agent: AgentKind) => void
  setAccessMode: (address: AccessAddress, draftRevision: number, mode: AccessSelection) => void
  openThread: (threadId: string, agent?: AgentKind) => Promise<void>
  loadEarlierHistory: (beforeApply: () => void) => Promise<void>
  openingThread: ChatAddress | null
  /** 返回是否成功提交；失败时调用方要把输入框内容还回去。 */
  send: (text: string, options?: SendOptions) => Promise<boolean>
  sendSide: (text: string, mode: SendMode) => Promise<void>
  removePendingSend: (chat: ChatAddress, id: number) => void
  retryPendingSend: (chat: ChatAddress) => void
  /** 暂停该排队消息的自动发送并返回释放函数；消息正在发送或已被暂停时返回 null。 */
  holdPendingSend: (chat: ChatAddress, id: number) => ((resume?: boolean) => void) | null
  /** 修改排队消息正文，附件与技能保留；需先 holdPendingSend。 */
  editPendingSend: (chat: ChatAddress, id: number, text: string) => boolean
  /** 把排队消息补充到当前一轮（仅 Codex）。 */
  steerPendingSend: (chat: ChatAddress, id: number) => Promise<boolean>
  /** 把排队消息移到新会话发送，并切换到新会话。 */
  sendPendingInNewThread: (chat: ChatAddress, id: number, mode: PendingThreadMode) => Promise<boolean>
  openSideChat: (quote?: string) => void
  addSideAnnotation: (quote: string, comment: string) => void
  editSideAnnotation: (id: string, quote: string) => void
  removeSideAnnotation: (id: string) => void
  restartSideChat: () => Promise<void>
  endSideChat: () => Promise<void>
  setSideDraft: (draft: string) => void
  clearSideError: () => void
  closeSideChat: () => void
  interrupt: () => Promise<void>
  interruptSide: () => Promise<void>
  respondApproval: (chat: ChatAddress, requestId: RequestId, decision: ApprovalDecision) => void
  /** 归档在缺少原生 RPC 的 Agent 上保存在桌面端。 */
  renameThread: (threadId: string, agent: AgentKind, name: string) => Promise<boolean>
  archiveThread: (threadId: string, agent: AgentKind) => Promise<boolean>
  deleteThread: (threadId: string, agent: AgentKind) => Promise<boolean>
  /** 分叉出新会话并切换过去。 */
  /** lastTurnId：只分叉到该轮为止（含），用于"从这条回复分支"。 */
  forkThread: (threadId: string, agent: AgentKind, lastTurnId?: string) => Promise<boolean>
  clearError: () => void
  clearNotice: () => void
}

// 旧版 server 会丢弃超长回包，请求永远等不到响应；超时后释放“打开中”并允许重试。
const OPEN_THREAD_TIMEOUT_MS = 30_000
const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000

let subscribed = false
let offEvents: Array<() => void> = []

export const useCodex = create<CodexState>((set, get) => {
  function patchSide(key: string, patch: Partial<SideChatState>) {
    set((state) => {
      const side = state.sideChats[key]
      return side ? { sideChats: { ...state.sideChats, [key]: { ...side, ...patch } } } : state
    })
  }

  function expireSides(targetId: string, agent: AgentKind, threadId?: string) {
    for (const [key, side] of Object.entries(get().sideChats)) {
      if (side.threadId && side.targetId === targetId && side.agent === agent && (!threadId || side.threadId === threadId)) {
        patchSide(key, { expired: true, error: t('侧聊已结束，可重新开始。') })
        pausePending({ targetId, agent, threadId: side.threadId }, t('侧聊已结束，重开后可继续发送'))
      }
    }
  }

  const opening = new Map<string, Promise<boolean>>()
  const probing = new Map<string, Promise<void>>()
  const submitting = new Set<string>()
  const changingParentThreads = new Set<string>()
  const replacing = new Set<string>()
  /** 正在重新编辑或选择新会话的排队消息，自动发送要跳过，避免用户还在改时被发出。 */
  const holdingPending = new Set<number>()
  let nextPendingId = 0
  let nextSideAnnotationId = 0
  const sideAnnotation = (quote: string, comment = ''): Annotation =>
    ({ id: `side-${++nextSideAnnotationId}`, quote, comment })
  const threadListRequests = new Map<string, symbol>()
  /** 本窗口新建、服务端列表还没返回的会话，按 pendingSendKey 记录；列表查到后移除。 */
  const localThreads = new Map<string, { targetId: string; summary: ThreadSummary }>()
  const localThreadsFor = (targetId: string, incoming: ThreadSummary[]): ThreadSummary[] => {
    const listed = new Set(incoming.map((thread) => threadKey(thread.agent, thread.id)))
    const result: ThreadSummary[] = []
    for (const [key, entry] of localThreads) {
      if (entry.targetId !== targetId) continue
      if (listed.has(threadKey(entry.summary.agent, entry.summary.id))) localThreads.delete(key)
      else result.push(entry.summary)
    }
    return result
  }
  let openThreadToken = 0

  const refreshThreadListsFor = (targetId: string, agent: AgentKind, threadId?: string, cwd?: string) => {
    const state = get()
    if (state.currentTargetId === targetId) void state.refreshThreads()
    for (const list of Object.values(state.threadLists)) {
      if (list.targetId !== targetId || (state.currentTargetId === targetId && state.currentCwd === list.cwd)) continue
      if ((cwd !== undefined && (list.cwd === null || list.cwd === cwd)) || list.threads.some((thread) => thread.agent === agent && thread.id === threadId)) {
        void state.refreshThreads({ targetId, cwd: list.cwd })
      }
    }
  }

  // 流式增量先缓冲、定时合并成一次 set（见 createDeltaBuffer）；其他通知和任何会话写入前都会先冲刷，保证写入顺序不变。
  const deltas = createDeltaBuffer((key, list) => {
    set((state) => {
      const session = state.sessions[key]
      if (!session) return state
      return { sessions: { ...state.sessions, [key]: { ...session, state: list.reduce(applyNotification, session.state) } } }
    })
  })
  const flushDeltas = deltas.flush

  const patchSession = (key: string, update: (session: TargetSession) => TargetSession): void => {
    flushDeltas(key)
    set((state) => {
      const session = state.sessions[key]
      if (!session) return state
      const next = update(session)
      if (next === session) return state
      return { sessions: { ...state.sessions, [key]: next } }
    })
  }

  const forgetSideTranscript = (side: SideChatState) => {
    const { targetId, agent, threadId } = side
    if (!threadId) return
    patchSession(sessionKey(targetId, agent), (session) => {
      const threads = { ...session.state.threads }
      delete threads[threadId]
      return { ...session, state: { ...session.state, threads } }
    })
  }

  function dropSide(key: string, side: SideChatState): void {
    forgetSideTranscript(side)
    set((state) => {
      const sideChats = { ...state.sideChats }
      delete sideChats[key]
      return { sideChats }
    })
  }

  const patchAgent = (targetId: string, agent: AgentKind, status: AgentAvailability): void => {
    set((state) => ({
      agents: {
        ...state.agents,
        [targetId]: { ...(state.agents[targetId] ?? emptyAgentStatus()), [agent]: status },
      },
    }))
  }

  /** 切换上下文时清掉各会话残留的草稿占位，别把上一条发送中的气泡带到新会话。 */
  const clearAllDrafts = (): void => {
    set((state) => {
      const sessions = { ...state.sessions }
      for (const [key, session] of Object.entries(sessions)) {
        const next = clearDraftThread(session.state)
        if (next === session.state) continue
        sessions[key] = { ...session, state: next }
      }
      return {
        sessions,
        access: resetDraftAccess(state.access),
        composerDraftRevision: state.composerDraftRevision + 1,
      }
    })
  }

  const statusFor = (targetId: string, agent: AgentKind): AgentAvailability | undefined =>
    get().agents[targetId]?.[agent]

  // 优先级：该连接设过的默认 > 设置里的全局默认 Agent > 自动挑可用的。
  const defaultFor = (targetId: string): AgentKind =>
    preferredAgent(
      get().agents[targetId],
      useAgentPrefs.getState().byTarget[targetId] ?? (useSettings.getState().settings.general.defaultAgent as AgentKind),
    )

  const openParams = (targetId: string, agent: AgentKind) =>
    configuredAgentOpen(agent, agentPrefs(useSettings.getState().settings, targetId, agent))

  const configDirFor = (targetId: string, agent: AgentKind): string | undefined => {
    const params = openParams(targetId, agent)
    return params.codexHome ?? params.claudeConfigDir
  }

  const sessionFor = (targetId: string, agent: AgentKind): TargetSession => {
    const key = sessionKey(targetId, agent)
    const existing = get().sessions[key]
    if (existing) return existing

    const transport = new BackendCodexTransport(targetId, agent)
    const rpc = new CodexRpc(transport, { timeoutMs: 30_000 })
    const session: TargetSession = {
      key,
      targetId,
      agent,
      rpc,
      transport,
      state: emptyState(),
      threadsAwaitingResume: new Set(),
      opened: false,
      openedConfig: null,
      opening: false,
      openError: null,
      openFailure: null,
      agentVersion: null,
      lastSeq: null,
    }
    set((state) => ({ sessions: { ...state.sessions, [key]: session } }))

    rpc.onNotification((notification: ServerNotification) => {
      if (isStreamDelta(notification)) {
        deltas.push(key, notification)
        return
      }
      patchSession(key, (current) => ({
        ...current,
        state: applyNotification(current.state, notification),
      }))
      if (notification.method === 'thread/closed') expireSides(targetId, agent, notification.params.threadId)
      if (notification.method === 'turn/completed' && notification.params?.threadId && notification.params.turn) {
        const chat = { targetId, agent, threadId: notification.params.threadId }
        const state = get()
        if (state.sessions[key]?.state.threads[chat.threadId]?.status !== 'running') {
          if (!(state.currentTargetId === targetId && state.currentAgent === agent && state.currentThreadId === chat.threadId)
            && !Object.values(state.sideChats).some(side => side.targetId === targetId && side.agent === agent && side.threadId === chat.threadId)) {
            useThreadPrefs.getState().setUnread(targetId, threadKey(agent, chat.threadId), true)
          }
          if (notification.params.turn.status === 'completed') void flushPending(chat)
          else if (!replacing.has(pendingSendKey(chat))) pausePending(chat, t('上一轮未完成，队列已暂停'), true)
        }
      }
      if (
        notification.method === 'turn/completed' ||
        notification.method === 'thread/started' ||
        notification.method === 'thread/name/updated'
      ) {
        const params = notification.params
        if ('thread' in params) refreshThreadListsFor(targetId, agent, params.thread.id, params.thread.cwd)
        else refreshThreadListsFor(targetId, agent, params.threadId)
      }
    })
    rpc.onServerRequest((request: ServerRequest) => {
      patchSession(key, (current) => ({
        ...current,
        state: applyServerRequest(current.state, request),
      }))
    })
    return session
  }

  const ensureOpen = async (targetId: string, agent: AgentKind = DEFAULT_AGENT): Promise<boolean> => {
    const key = sessionKey(targetId, agent)
    const current = get().sessions[key]
    const params = openParams(targetId, agent)
    const directory = params.codexHome ?? params.claudeConfigDir
    const busy = opening.get(key)
    if (busy) return (await busy) && ensureOpen(targetId, agent)
    if (current?.opened && current.openedConfig?.directory === directory) return true

    const session = sessionFor(targetId, agent)
    patchSession(key, (value) => ({ ...value, opening: true, openError: null }))

    const task = (async () => {
      try {
        const open = () => call('server.req', { targetId, method: 'codex.open', params })
        const opened = await open().catch(async (err: unknown) => {
          // 本机目标不需要凭据：链路丢了直接补连一次，不让用户停在"目标 local 未连接"。
          if (targetId !== 'local' || (err as { code?: unknown })?.code !== 'not_connected') throw err
          const state = useTargets.getState().states[targetId]?.state
          if (state === 'connecting' || state === 'deploying') throw err
          await useTargets.getState().connect(targetId)
          return open()
        })
        const version =
          typeof (opened as { agentVersion?: unknown })?.agentVersion === 'string'
            ? ((opened as { agentVersion: string }).agentVersion)
            : null
        const capabilities = (opened as ServerResult<'codex.open'> | null)?.capabilities
        if (directory && capabilities?.agentConfigDir !== true) {
          throw new Error(t('目标服务暂不支持 Agent 配置目录，请升级目标服务后重试'))
        }
        const replaced = session.openedConfig !== null && session.openedConfig.directory !== directory
        if (replaced) {
          expireSides(targetId, agent)
          const prefix = targetAgentKeyPrefix(targetId, agent)
          patchSession(key, (value) => ({ ...value, state: emptyState(), threadsAwaitingResume: new Set() }))
          set((state) => ({
            access: resetTargetAccess(state.access, targetId, agent),
            pendingSends: agent === 'codex'
              ? Object.fromEntries(Object.entries(state.pendingSends).filter(([key]) => !key.startsWith(prefix)))
              : state.pendingSends,
            threadLists: Object.fromEntries(Object.entries(state.threadLists).map(([id, list]) => [
              id, list.targetId === targetId ? { ...list, threads: list.threads.filter((thread) => thread.agent !== agent) } : list,
            ])),
            ...(state.currentTargetId === targetId ? {
              ...(state.currentAgent === agent && state.currentThreadId !== null ? {
                currentThreadId: null,
                notice: t('{agent} 配置目录已切换，请重新选择会话', { agent: agentLabel(agent) }),
              } : {}),
            } : {}),
          }))
        }
        let lastSeq = maxSeq(openSeq(opened), session.transport.getLastSeq())

        try {
          // 每个 agent 有独立的回放缓冲，attach 必须带上 agent。
          const attached = await call('server.req', {
            targetId,
            method: 'codex.attach',
            params: { agent, sinceSeq: lastSeq ?? 0 },
          })
          const info = attachResult(attached)
          lastSeq = maxSeq(lastSeq, info.lastSeq)
          if (info.truncated) {
            set({ notice: t('{agent} 历史缓冲已裁剪，请重新打开会话加载完整记录', { agent: agentLabel(agent) }) })
          }
        } catch {
          // 旧版 daemon 没有 attach 时仍能正常对话。
        }

        session.transport.setLastSeq(lastSeq)
        patchSession(key, (value) => ({
          ...value,
          opened: true,
          openedConfig: { directory, accessModes: capabilities?.accessModes === true, ephemeralNoTools: capabilities?.ephemeralNoTools === true },
          opening: false,
          openError: null,
          openFailure: null,
          agentVersion: version,
          lastSeq,
        }))
        for (const threadId of Object.keys(get().sessions[key]?.state.threads ?? {})) {
          void flushPending({ targetId, agent, threadId })
        }
        return true
      } catch (err) {
        const message =
          agent === 'codex'
            ? describeCodexOpenError(err, targetId)
            : friendlyError(err, agent === 'pi' ? t('打开 pi 失败') : t('打开 Claude 失败'))
        patchSession(key, (value) => ({
          ...value,
          opened: (err as { code?: unknown })?.code === 'config_dir_busy' && value.opened,
          opening: false,
          openError: message,
          openFailure: err,
        }))
        return false
      } finally {
        opening.delete(key)
        patchSession(key, (value) => ({ ...value, opening: false }))
      }
    })()

    opening.set(key, task)
    return task
  }

  const probeAgents = async (targetId: string): Promise<void> => {
    const busy = probing.get(targetId)
    if (busy) return busy
    const task = (async () => {
      for (const agent of AGENTS) {
        const key = sessionKey(targetId, agent)
        const session = get().sessions[key]
        if (session?.opened && session.openedConfig?.directory === configDirFor(targetId, agent)) {
          patchAgent(targetId, agent, {
            state: 'ready',
            ...(session.agentVersion ? { version: session.agentVersion } : {}),
          })
          continue
        }
        patchAgent(targetId, agent, { state: 'checking' })
        const ok = await ensureOpen(targetId, agent)
        const after = get().sessions[key]
        patchAgent(
          targetId,
          agent,
          ok
            ? { state: 'ready', ...(after?.agentVersion ? { version: after.agentVersion } : {}) }
            : classifyAgentOpenError(agent, after?.openFailure ?? new Error(after?.openError ?? '')),
        )
      }
      // 只有 Claude 可用时，输入框与新建会话应默认落在 Claude 上。
      if (get().currentTargetId === targetId && !get().currentThreadId) {
        set({ currentAgent: defaultFor(targetId) })
      }
    })()
    probing.set(targetId, task)
    try {
      await task
    } finally {
      probing.delete(targetId)
    }
  }

  const startNewThread = async (
    targetId: string,
    agent: AgentKind,
    options: { cwd: string | null; ephemeral: boolean },
  ): Promise<string | null> => {
    const key = sessionKey(targetId, agent)
    if (!(await ensureOpen(targetId, agent))) {
      set({ error: get().sessions[key]?.openError ?? t('{agent} 未就绪', { agent: agentLabel(agent) }) })
      return null
    }
    const session = get().sessions[key]
    if (!session) return null
    try {
      const result = await startThread(session.rpc, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.ephemeral ? { ephemeral: true } : {}),
      })
      patchSession(key, (value) => ({
        ...value,
        state: loadThread(value.state, result.thread),
      }))
      return result.thread.id
    } catch (err) {
      set({ error: friendlyError(err, t('新建会话失败')) })
      return null
    }
  }

  const interruptFor = async (
    targetId: string,
    agent: AgentKind,
    threadId: string | null,
  ): Promise<void> => {
    if (!threadId) {
      set({ notice: t('当前没有运行中的 turn') })
      return
    }
    const session = get().sessions[sessionKey(targetId, agent)]
    if (!session) return
    const view = session.state.threads[threadId]
    const turnId = view?.activeTurnId
    if (!turnId) {
      set({ notice: t('当前没有运行中的 turn') })
      return
    }
    try {
      await interruptTurn(session.rpc, threadId, turnId)
      set({ notice: t('已请求中断当前 turn') })
    } catch (err) {
      set({ error: friendlyError(err, t('中断失败')) })
    }
  }

  /** 在当前目标的指定 agent 会话上执行一次 RPC；失败写入 error。 */
  const withSession = async <T,>(
    agent: AgentKind,
    fallback: string,
    run: (session: TargetSession) => Promise<T>,
  ): Promise<T | null> => {
    const targetId = get().currentTargetId
    if (!targetId) {
      set({ error: t('请先选择目标') })
      return null
    }
    if (!(await ensureOpen(targetId, agent))) {
      set({ error: get().sessions[sessionKey(targetId, agent)]?.openError ?? t('{agent} 未就绪', { agent: agentLabel(agent) }) })
      return null
    }
    const session = get().sessions[sessionKey(targetId, agent)]
    if (!session) return null
    try {
      return await run(session)
    } catch (err) {
      set({ error: friendlyError(err, fallback) })
      return null
    }
  }

  /** 当前会话被归档/删除后回到草稿态，避免对话区停在一个已不存在的会话上。 */
  const leaveIfCurrent = (threadId: string, agent: AgentKind): void => {
    if (get().currentThreadId === threadId && get().currentAgent === agent) {
      set({ currentThreadId: null })
    }
  }

  const parentAddress = (side: SideChatState): ChatAddress =>
    ({ targetId: side.targetId, agent: side.agent, threadId: side.parentThreadId })

  function threadHasWork(chat: ChatAddress): boolean {
    const state = get()
    const key = pendingSendKey(chat)
    const view = state.sessions[sessionKey(chat.targetId, chat.agent)]?.state.threads[chat.threadId]
    return submitting.has(key) || !!state.pendingSends[key]?.length || view?.status === 'running' || isActiveThread(sessionStatus(view))
  }

  function removeFromThreadLists({ targetId, agent, threadId }: ChatAddress) {
    localThreads.delete(pendingSendKey({ targetId, agent, threadId }))
    set((state) => ({
      threadLists: Object.fromEntries(Object.entries(state.threadLists).map(([id, list]) => {
        if (list.targetId !== targetId) return [id, list]
        const threads = list.threads.filter((thread) => thread.id !== threadId || thread.agent !== agent)
        return [id, threads.length === list.threads.length ? list : { ...list, threads }]
      })),
    }))
  }

  function sideHasWork(side: SideChatState): boolean {
    if (side.busy) return true
    if (!side.threadId) return false
    const key = pendingSendKey({ ...side, threadId: side.threadId })
    const view = get().sessions[sessionKey(side.targetId, side.agent)]?.state.threads[side.threadId]
    return submitting.has(key) || !!get().pendingSends[key]?.length ||
      (!side.expired && (view?.status === 'running' || !!view?.pendingApprovals.length))
  }

  async function removeParentThread(threadId: string, agent: AgentKind, action: 'archive' | 'delete'): Promise<boolean> {
    const targetId = get().currentTargetId
    if (!targetId) {
      set({ error: t('请先选择目标') })
      return false
    }
    const chat = { targetId, agent, threadId }
    const key = pendingSendKey(chat)
    if (changingParentThreads.has(key)) return false
    const openingChat = get().openingThread
    if (openingChat && pendingSendKey(openingChat) === key) {
      set({ notice: t('请等待会话打开后重试') })
      return false
    }
    if (threadHasWork(chat)) {
      set({ notice: t('请先停止会话并处理审批或排队消息') })
      return false
    }
    const sides = Object.entries(get().sideChats).filter(([, side]) => pendingSendKey(parentAddress(side)) === key)
    if (sides.some(([, side]) => sideHasWork(side))) {
      set({ notice: t('请先停止侧聊并处理审批或排队消息') })
      return false
    }
    changingParentThreads.add(key)
    try {
      const fallback = action === 'archive' ? t('归档失败') : t('删除失败')
      const native = action === 'delete' || agent === 'codex'
      if (native || sides.some(([, side]) => side.threadId && !side.expired)) {
        const ok = await withSession(agent, fallback, async (session) => {
          for (const [sideKey] of sides) {
            const side = get().sideChats[sideKey]
            if (!side?.threadId || side.expired) continue
            if (sideHasWork(side)) throw new Error(t('请先停止侧聊并处理审批或排队消息'))
            await session.rpc.request('thread/unsubscribe', { threadId: side.threadId })
            patchSide(sideKey, { expired: true, error: t('侧聊已结束，可重新开始。') })
          }
          if (threadHasWork(chat)) throw new Error(t('请先停止会话并处理审批或排队消息'))
          if (native) await (action === 'archive' ? archiveThread : deleteThread)(session.rpc, threadId)
          return true
        })
        if (!ok) return false
      }
      for (const [sideKey, side] of sides) dropSide(sideKey, side)
      if (action === 'archive') useThreadPrefs.getState().setArchived(targetId, agent, threadId, true)
      if (get().currentTargetId === targetId) leaveIfCurrent(threadId, agent)
      if (native) {
        refreshThreadListsFor(targetId, agent, threadId)
        removeFromThreadLists(chat)
      }
      return true
    } finally {
      changingParentThreads.delete(key)
    }
  }

  async function loadThreadList(targetId: string, cwd?: string, archived = false) {
    const lists = await Promise.all(AGENTS.map(async (agent) => {
      const session = get().sessions[sessionKey(targetId, agent)]
      const status = statusFor(targetId, agent)
      if (status?.state !== 'ready' || !session?.opened) {
        const error = archived && status?.state === 'error' ? t('{agent}：{detail}', { agent: agentLabel(agent), detail: status.detail ?? t('未就绪') }) : null
        return { threads: [], error }
      }
      try {
        const result = await listThreads(session.rpc, cwd, undefined, archived && agent === 'codex' ? { archived: true } : undefined)
        const current = get().sessions[session.key]
        const threads = current?.opened && current.openedConfig === session.openedConfig ? toThreadSummaries(result, agent) : []
        return { threads, error: null }
      } catch (err) {
        return { threads: [], error: t('{agent}：{detail}', { agent: agentLabel(agent), detail: friendlyError(err, t('加载会话列表失败')) }) }
      }
    }))
    return { threads: mergeThreadSummaries(lists.map(({ threads }) => threads)), error: lists.find(({ error }) => error)?.error ?? null }
  }

  async function archiveInactiveLocalThreads(days: number, isCurrent: () => boolean) {
    const targetId = 'local'
    await probeAgents(targetId)
    if (!isCurrent()) return
    const cutoff = Date.now() - days * 24 * AUTO_ARCHIVE_INTERVAL_MS
    const changedDirectories = new Set<string>()
    await Promise.all(AGENTS.map(async (agent) => {
      const session = get().sessions[sessionKey(targetId, agent)]
      if (!session) return
      const isSessionCurrent = () => {
        const current = get().sessions[session.key]
        return isCurrent() && current?.opened && current.openedConfig === session.openedConfig &&
          current.openedConfig?.directory === configDirFor(targetId, agent)
      }
      if (!isSessionCurrent()) return
      try {
        const result = await listThreads(session.rpc)
        const threads = toThreadSummaries(result.data.filter((thread) => !thread.ephemeral && !thread.parentThreadId), agent)
        for (const thread of threads) {
          if (!isSessionCurrent()) break
          const chat = { targetId, agent, threadId: thread.id }
          const key = pendingSendKey(chat)
          const state = get()
          const prefs = useThreadPrefs.getState()
          if (!isInactiveForArchive(thread, prefs.byTarget[targetId], cutoff) || changingParentThreads.has(key) ||
            isMainChat(state, chat) || (state.openingThread && pendingSendKey(state.openingThread) === key) ||
            threadHasWork(chat) || Object.values(state.sideChats).some((side) => pendingSendKey(parentAddress(side)) === key)) continue
          changingParentThreads.add(key)
          try {
            if (agent === 'codex') {
              await archiveThread(session.rpc, thread.id)
              changedDirectories.add(thread.cwd)
              removeFromThreadLists(chat)
            }
            prefs.setArchived(targetId, agent, thread.id, true)
          } catch {
            // 单个会话归档失败时，下一轮检查会重新读取它的状态。
          } finally {
            changingParentThreads.delete(key)
          }
        }
      } catch {
        // Agent 离线或读取失败时保留会话，等下次检查。
      }
    }))
    for (const { targetId: listTarget, cwd } of Object.values(get().threadLists)) {
      if (listTarget === targetId && (cwd === null ? changedDirectories.size > 0 : changedDirectories.has(cwd))) {
        void get().refreshThreads({ targetId, cwd })
      }
    }
  }

  const updatePending = (chat: ChatAddress, update: (list: PendingSend[]) => PendingSend[]) => {
    const key = pendingSendKey(chat)
    set((state) => {
      const list = update(state.pendingSends[key] ?? [])
      const pendingSends = { ...state.pendingSends }
      if (list.length) pendingSends[key] = list
      else delete pendingSends[key]
      return { pendingSends }
    })
  }

  function pausePending(chat: ChatAddress, error: string, afterSending = false) {
    const list = get().pendingSends[pendingSendKey(chat)]
    const first = afterSending ? list?.find((item) => !item.sending) : list?.[0]
    if (!first) return
    updatePending(chat, (items) => items.map((item) => item.id === first.id ? { ...item, error } : item))
  }

  const addPendingUser = (key: string, threadId: string, item: PendingUser) => {
    patchSession(key, (value) => ({
      ...value,
      state: addOptimisticUser(value.state, threadId, item),
    }))
  }

  const removePendingUser = (key: string, threadIds: string[], id: string) => {
    patchSession(key, (value) => ({ ...value, state: dropOptimisticUsers(value.state, threadIds, id) }))
  }

  async function startTurn(
    session: TargetSession, threadId: string, input: UserInput[], overrides: TurnOverrides, pendingUser: PendingUser,
  ) {
    if (get().sessions[session.key]?.threadsAwaitingResume.has(threadId)) {
      const before = get().sessions[session.key]?.state.threads[threadId]
      const { thread, earlier } = await openThreadHistory(session.rpc, threadId, 'resume')
      patchSession(session.key, (value) => {
        const threadsAwaitingResume = new Set(value.threadsAwaitingResume)
        threadsAwaitingResume.delete(threadId)
        const state = loadRecentThreadHistory(value.state, thread, earlier, before)
        return {
          ...value,
          threadsAwaitingResume,
          state: addOptimisticUser(state, threadId, pendingUser),
        }
      })
      if (get().sessions[session.key]?.state.threads[threadId]?.status === 'running') {
        throw new Error(t('会话已有正在执行的轮次，请等待完成后再发送'))
      }
    }
    const observed = new Set<string>()
    const unsubscribe = session.rpc.onNotification((note) => {
      if ((note.method === 'turn/started' || note.method === 'turn/completed') && note.params?.threadId === threadId) {
        if (note.params.turn?.id) observed.add(note.params.turn.id)
      }
    })
    try {
      const mode = getAccessMode(get().access, { targetId: session.targetId, agent: session.agent, threadId },
        useSettings.getState().settings.general.globalAccessMode)
      const access = turnAccessOverride(session.agent, mode)
      if (access && session.openedConfig?.accessModes !== true) {
        throw new Error(t('目标服务暂不支持当前访问模式，请升级目标服务后重试'))
      }
      // 文件类 mention 对 Codex 改成正文里的路径说明（Codex 的 mention 只认 app/plugin）。
      const adaptedInput = adaptTurnInput(session.agent, input)
      const { turn } = access
        ? await session.rpc.request('turn/start', { threadId, input: adaptedInput, ...overrides, ...access })
        : await sendInput(session.rpc, threadId, adaptedInput, overrides)
      // 快速完成的轮次可能在 RPC 回包前已收到事件，不要把它重新标成运行中。
      if (!observed.has(turn.id)) {
        const method = turn.status === 'inProgress' ? 'turn/started' : 'turn/completed'
        patchSession(session.key, (value) => ({
          ...value,
          state: applyNotification(value.state, { method, params: { threadId, turn } }),
        }))
        if (turn.status === 'failed' || turn.status === 'interrupted') {
          pausePending({ targetId: session.targetId, agent: session.agent, threadId }, t('上一轮未完成，队列已暂停'), true)
        }
      }
    } finally {
      unsubscribe()
    }
  }

  async function flushPending(chat: ChatAddress, retry = false): Promise<void> {
    const key = pendingSendKey(chat)
    if (changingParentThreads.has(key)) return
    if (Object.values(get().sideChats).some((side) => side.expired && side.targetId === chat.targetId &&
      side.agent === chat.agent && side.threadId === chat.threadId)) return
    const session = get().sessions[sessionKey(chat.targetId, chat.agent)]
    const view = session?.state.threads[chat.threadId]
    const next = get().pendingSends[key]?.[0]
    if (!session?.opened || !view || !next || submitting.has(key) || holdingPending.has(next.id)) return
    if (session.openedConfig?.directory !== configDirFor(chat.targetId, chat.agent)) return
    if (view.status === 'running' || (!retry && (view.status !== 'idle' || next.error))) return

    submitting.add(key)
    updatePending(chat, (list) => list.map((item) => item.id === next.id ? { ...item, sending: true, error: undefined } : item))
    const pendingUser = userItemFromInput(`local-user-${++nextPendingId}`, next.input)
    addPendingUser(session.key, chat.threadId, pendingUser)
    try {
      await startTurn(session, chat.threadId, next.input, next.overrides, pendingUser)
      updatePending(chat, (list) => list.filter((item) => item.id !== next.id))
    } catch (err) {
      removePendingUser(session.key, [chat.threadId], pendingUser.id)
      pausePending(chat, friendlyError(err, t('排队消息未发送')))
    } finally {
      submitting.delete(key)
      updatePending(chat, (list) => list.map((item) => item.id === next.id ? { ...item, sending: false } : item))
    }
    if (!get().pendingSends[key]?.[0]?.error && get().sessions[session.key]?.state.threads[chat.threadId]?.status === 'idle') {
      void flushPending(chat)
    }
  }

  async function interruptAndWait(session: TargetSession, threadId: string, turnId: string) {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finished = new Promise<boolean>((resolve) => {
      unsubscribe = session.rpc.onNotification((note) => {
        if (note.method === 'turn/completed' && note.params?.threadId === threadId && note.params.turn?.id === turnId) {
          resolve(note.params.turn.status === 'completed' || note.params.turn.status === 'interrupted')
        }
      })
      timer = setTimeout(() => resolve(false), 30_000)
    })
    try {
      await interruptTurn(session.rpc, threadId, turnId)
      if (!(await finished)) throw new Error(t('未确认当前一轮已停止，请检查会话后重试'))
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  }

  async function createSideThread(side: SideChatState): Promise<string> {
    const key = sessionKey(side.targetId, side.agent)
    if (!await ensureOpen(side.targetId, side.agent)) throw new Error(get().sessions[key]?.openError ?? t('连接失败'))
    const session = get().sessions[key]!
    if (side.agent === 'pi' && !session.openedConfig?.ephemeralNoTools) throw new Error(t('请升级目标服务以使用 Pi 无工具侧聊'))
    const { thread } = await startThread(session.rpc, { cwd: side.cwd, ephemeral: true })
    patchSession(key, (value) => ({ ...value, state: loadThread(value.state, thread) }))
    return thread.id
  }

  return {
    sessions: {},
    agents: {},
    currentTargetId: null,
    currentCwd: null,
    currentThreadId: null,
    currentAgent: DEFAULT_AGENT,
    threadLists: {},
    sending: false,
    sendingMessage: null,
    access: emptyAccessMemory,
    composerDraftRevision: 0,
    pendingSends: {},
    error: null,
    notice: null,
    sideChats: {},

    openingThread: null,

    init: () => {
      if (subscribed) return () => undefined
      subscribed = true
      let stopped = false
      let checkingArchive = false
      let checkAgain = false
      const initialSettings = useSettings.getState()
      let savedArchiveDays = initialSettings.loaded && !initialSettings.saving ? initialSettings.settings.general.autoArchiveDays : 0
      const checkArchive = () => {
        const days = savedArchiveDays
        const isCurrent = () => !stopped && savedArchiveDays === days &&
          useSettings.getState().settings.general.autoArchiveDays === days && useTargets.getState().states.local?.state === 'ready'
        if (!days || !isCurrent()) return
        if (checkingArchive) {
          checkAgain = true
          return
        }
        checkingArchive = true
        void archiveInactiveLocalThreads(days, isCurrent).catch(() => undefined).finally(() => {
          checkingArchive = false
          if (checkAgain) {
            checkAgain = false
            checkArchive()
          }
        })
      }
      const archiveTimer = setInterval(checkArchive, AUTO_ARCHIVE_INTERVAL_MS)
      offEvents = [
        useSettings.subscribe((state, previous) => {
          if (!state.loaded || state.saving) return
          const days = state.settings.general.autoArchiveDays
          if (savedArchiveDays === days && previous.settings.general.autoArchiveDays === days) return
          savedArchiveDays = days
          checkArchive()
        }),
        useTargets.subscribe((state, previous) => {
          if (state.states.local?.state === 'ready' && previous.states.local?.state !== 'ready') checkArchive()
        }),
        on('server.evt', (payload) => {
          if (payload.name === 'server.restarted') {
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== payload.targetId) continue
              session.transport.resetLastSeq()
              patchSession(session.key, (value) => ({
                ...value,
                opened: false,
                lastSeq: null,
                state: failActiveThreads(value.state, t('Server 已重启，进行中的任务已中断')),
                threadsAwaitingResume: new Set(Object.keys(value.state.threads)),
              }))
              expireSides(payload.targetId, session.agent)
              patchAgent(payload.targetId, session.agent, { state: 'unknown' })
            }
            return
          }
          const exitedAgent = exitedAgentOf(payload.name, payload.payload)
          if (!exitedAgent) return
          const key = sessionKey(payload.targetId, exitedAgent)
          const session = get().sessions[key]
          // 只有真正打开过的会话才算"进程退出"；探测/启动失败（如目标机没装 codex）不是退出，
          // 否则在用 pi 时也会因为探测 codex 不停弹出提示。
          if (!session?.opened) return
          patchSession(key, (value) => ({
            ...value,
            state: failActiveThreads(value.state, t('{agent} 进程已退出', { agent: agentLabel(value.agent) })),
            opened: false,
            openError: t('{agent} 进程已退出，下次操作将重新启动', { agent: agentLabel(value.agent) }),
          }))
          expireSides(payload.targetId, exitedAgent)
          patchAgent(payload.targetId, exitedAgent, { state: 'unknown' })
          if (get().currentTargetId === payload.targetId && get().currentAgent === exitedAgent) {
            set({ notice: t('{agent} 进程已退出，请重试', { agent: agentLabel(exitedAgent) }) })
          }
        }),
        on('target.state', (payload) => {
          if (payload.state !== 'ready') {
            // 链路断过之后 agent 进程可能已经换了，下次操作必须重新 codex.open。
            for (const session of Object.values(get().sessions)) {
              if (session.targetId !== payload.id || !session.opened) continue
              patchSession(session.key, (value) => ({ ...value, opened: false }))
            }
            return
          }
          if (get().currentTargetId !== payload.id) return
          // 启动时项目可能先于连接恢复，就绪后才能查到这个目录的历史会话。
          if (get().currentCwd) void get().refreshThreads()
          else void get().probeAgents(payload.id)
        }),
      ]
      checkArchive()
      return () => {
        stopped = true
        clearInterval(archiveTimer)
        for (const off of offEvents) off()
        offEvents = []
        subscribed = false
      }
    },

    setContext: (targetId, cwd, refresh = false) => {
      ++openThreadToken
      clearAllDrafts()
      set({
        currentTargetId: targetId,
        currentCwd: cwd,
        currentThreadId: null,
        openingThread: null,
        currentAgent: targetId ? defaultFor(targetId) : DEFAULT_AGENT,
        error: null,
      })
      if (refresh && targetId) void get().refreshThreads()
    },

    ensureOpen,
    probeAgents,

    refreshThreads: async (scope) => {
      const { targetId, cwd } = scope ?? { targetId: get().currentTargetId, cwd: get().currentCwd }
      if (!targetId) return
      const key = threadListKey({ targetId, cwd })
      const request = Symbol()
      threadListRequests.set(key, request)
      const update = (threads: ThreadSummary[], loading: boolean, error: string | null) => {
        set((state) => ({
          threadLists: { ...state.threadLists, [key]: { targetId, cwd, threads, loading, error } },
        }))
      }
      update(get().threadLists[key]?.threads ?? noThreads, true, null)
      try {
        await get().probeAgents(targetId)
        if (threadListRequests.get(key) !== request) return
        const { threads, error } = await loadThreadList(targetId, cwd ?? undefined)
        if (threadListRequests.get(key) === request) {
          const merged = withLocalThreads(threads, localThreadsFor(targetId, threads), cwd)
          update(refreshThreadOrder(get().threadLists[key]?.threads ?? noThreads, merged), false, error)
        }
      } catch (err) {
        if (threadListRequests.get(key) === request) {
          update(get().threadLists[key]?.threads ?? noThreads, false, friendlyError(err, t('加载会话列表失败')))
        }
      } finally {
        if (threadListRequests.get(key) === request) threadListRequests.delete(key)
      }
    },

    listArchivedThreads: async (targetId) => {
      await get().probeAgents(targetId)
      const { threads, error } = await loadThreadList(targetId, undefined, true)
      return { threads: archivedThreadSummaries(threads, useThreadPrefs.getState().byTarget[targetId]), error }
    },

    restoreThread: async (targetId, { agent, id: threadId, cwd }) => {
      const key = pendingSendKey({ targetId, agent, threadId })
      if (changingParentThreads.has(key)) throw new Error(t('正在更新该会话，请稍后重试'))
      changingParentThreads.add(key)
      try {
        if (agent === 'codex') {
          const ready = await ensureOpen(targetId, agent)
          const session = get().sessions[sessionKey(targetId, agent)]
          if (!ready || !session) throw new Error(session?.openError ?? t('Codex 未就绪'))
          await session.rpc.request('thread/unarchive', { threadId })
        }
        useThreadPrefs.getState().setArchived(targetId, agent, threadId, false)
        refreshThreadListsFor(targetId, agent, threadId, cwd)
      } finally {
        changingParentThreads.delete(key)
      }
    },

    newThread: async (agent, onDraftCreated) => {
      const initial = get()
      const picked = agent ?? initial.currentAgent
      if (onDraftCreated && (initial.currentThreadId || initial.sending || picked !== initial.currentAgent)) return
      const token = ++openThreadToken
      set({ openingThread: null })
      const targetId = initial.currentTargetId
      if (!targetId) {
        set({ error: t('请先选择目标') })
        return
      }
      const reason = statusFor(targetId, picked)
      if (reason?.state === 'unavailable') {
        set({ error: t('{agent} 不可用：{reason}', { agent: agentLabel(picked), reason: reason.detail ?? t('未安装') }) })
        return
      }
      const threadId = await startNewThread(targetId, picked, {
        cwd: initial.currentCwd,
        ephemeral: false,
      })
      if (!threadId || token !== openThreadToken) return
      if (onDraftCreated) {
        const current = get()
        if (
          current.currentThreadId || current.sending || current.currentAgent !== picked ||
          current.access.draftRevision !== initial.access.draftRevision
        ) return
        onDraftCreated(threadId)
      }
      clearAllDrafts()
      set({ currentThreadId: threadId, currentAgent: picked, error: null })
      void get().refreshThreads()
    },

    startDraft: (agent) => {
      useDock.getState().setView('chat')
      ++openThreadToken
      clearAllDrafts()
      const targetId = get().currentTargetId
      // 设过默认的连接，新会话回到默认；没设过则沿用当前 Agent。
      const chosen = targetId && useAgentPrefs.getState().byTarget[targetId] ? defaultFor(targetId) : null
      set((state) => ({
        currentThreadId: null,
        openingThread: null,
        currentAgent: agent ?? chosen ?? state.currentAgent,
        error: null,
      }))
    },

    setDraftAgent: (agent) => {
      set((state) => {
        if (state.currentThreadId || state.sending || state.currentAgent === agent) return state
        return { currentAgent: agent, error: null, access: resetDraftAccess(state.access) }
      })
    },

    setAccessMode: (address, draftRevision, mode) => {
      set((state) => {
        const { targetId, agent, threadId } = address
        const session = state.sessions[sessionKey(targetId, agent)]
        if (
          state.currentTargetId !== targetId || state.currentAgent !== agent || state.currentThreadId !== threadId ||
          !session?.opened || (mode !== 'default' && mode !== 'inherit' && session.openedConfig?.accessModes !== true) ||
          state.sending || (threadId === null && state.access.draftRevision !== draftRevision) ||
          (threadId !== null && (session.state.threads[threadId]?.status === 'running' || submitting.has(pendingSendKey({ targetId, agent, threadId }))))
        ) return state
        return { access: rememberAccessMode(state.access, address, mode) }
      })
    },

    openThread: async (threadId, agent) => {
      useDock.getState().setView('chat')
      const { currentTargetId: targetId, currentAgent, openingThread } = get()
      if (!targetId) {
        set({ error: t('请先选择目标') })
        return
      }
      const picked = agent ?? currentAgent
      if (openingThread?.targetId === targetId && openingThread.agent === picked && openingThread.threadId === threadId) return
      const chat = { targetId, agent: picked, threadId }
      if (changingParentThreads.has(pendingSendKey(chat))) {
        set({ error: t('正在更新该会话，请稍后重试') })
        return
      }
      const token = ++openThreadToken
      const isCurrent = () => token === openThreadToken
      const key = sessionKey(targetId, picked)
      clearAllDrafts()
      set({ openingThread: chat, error: null })
      const timeout = new Error(t('打开会话超时，请检查目标连接后重试'))
      let timer: ReturnType<typeof setTimeout> | undefined
      const load = async (): Promise<void> => {
        const ready = await ensureOpen(targetId, picked)
        if (!isCurrent()) return
        const session = get().sessions[key]
        if (!ready || !session) {
          set({ error: session?.openError ?? t('{agent} 未就绪', { agent: agentLabel(picked) }) })
          return
        }
        const before = session.state.threads[threadId]
        let result: Awaited<ReturnType<typeof openThreadHistory>>
        let readOnly = false
        let writerConflict = false
        try {
          result = await openThreadHistory(session.rpc, threadId, 'resume', isCurrent)
        } catch (err) {
          if (!isCurrent()) return
          if (picked !== 'codex' || isOversizeHistoryResponse(err)) throw err
          readOnly = true
          writerConflict = isActiveWriterError(err)
          result = await openThreadHistory(session.rpc, threadId, 'read', isCurrent)
        }
        if (!isCurrent()) return
        if (result.thread?.id !== threadId) throw new Error(t('返回的会话与所选会话不一致，请重试'))
        patchSession(key, (value) => {
          const threadsAwaitingResume = new Set(value.threadsAwaitingResume)
          if (readOnly) threadsAwaitingResume.add(threadId)
          else threadsAwaitingResume.delete(threadId)
          return {
            ...value, threadsAwaitingResume,
            state: loadRecentThreadHistory(value.state, result.thread, result.earlier, before),
          }
        })
        set({ currentThreadId: threadId, currentAgent: picked, error: null })
        useThreadPrefs.getState().setUnread(targetId, threadKey(picked, threadId), false)
        if (writerConflict) {
          const message = t('会话被另一个 Codex 进程占用，当前可查看历史。释放会话后可再次发送')
          pausePending(chat, message)
          set({ notice: message })
        } else {
          void flushPending(chat)
        }
      }
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout), OPEN_THREAD_TIMEOUT_MS)
        })
        await Promise.race([load(), deadline])
      } catch (err) {
        if (isCurrent()) {
          set({ error: err === timeout ? timeout.message : friendlyError(err, t('打开会话失败')), openingThread: null })
          // 迟到的回包不能再切换到这条会话。
          if (err === timeout) ++openThreadToken
        }
      } finally {
        clearTimeout(timer)
        if (isCurrent()) set({ openingThread: null })
      }
    },

    loadEarlierHistory: async (beforeApply) => {
      const { currentTargetId, currentAgent, currentThreadId, sessions } = get()
      if (!currentTargetId || !currentThreadId) return
      const key = sessionKey(currentTargetId, currentAgent)
      const session = sessions[key]
      const cursor = session?.state.threads[currentThreadId]?.historyCursor
      if (!session || !cursor) return
      const token = openThreadToken
      const isCurrent = () => {
        const state = get()
        const current = state.sessions[key]
        return token === openThreadToken && state.currentThreadId === currentThreadId && current?.rpc === session.rpc &&
          current.state.threads[currentThreadId]?.historyCursor === cursor
      }
      try {
        const page = await readThreadHistoryPage(session.rpc, currentThreadId, cursor, isCurrent)
        if (!isCurrent()) return
        beforeApply()
        patchSession(key, (value) => ({ ...value, state: prependThreadHistory(value.state, currentThreadId, page) }))
      } catch (error) {
        if (isCurrent()) throw error
      }
    },

    send: async (text, options) => {
      const trimmed = text.trim()
      const userInput: UserInput[] = options?.input ?? (trimmed ? [{ type: 'text', text: trimmed, text_elements: [] }] : [])
      const context = get()
      if (userInput.length === 0 || context.sending) return false
      const side = options?.sideKey ? context.sideChats[options.sideKey] : undefined
      if (options?.sideKey && (!side || side.expired || changingParentThreads.has(pendingSendKey(parentAddress(side))))) return false
      const targetId = options?.targetId ?? context.currentTargetId
      if (!targetId) {
        set({ error: t('请先选择目标') })
        return false
      }
      const agent = options?.agent ?? context.currentAgent
      const input = options?.delegate && supportsSubagentRequests(agent) ? requestSubagents(userInput) : userInput
      const key = sessionKey(targetId, agent)
      let threadId = options?.threadId ?? context.currentThreadId
      const draftMode = getAccessSelection(context.access, { targetId, agent, threadId: null })
      let chat = threadId ? { targetId, agent, threadId } : null
      let chatKey = chat ? pendingSendKey(chat) : null
      const mode = options?.mode ?? 'queue'
      // 模型与推理强度按会话记：已有会话用它自己的选择，草稿用 agent 默认，并在发送时固定到会话上。
      // 本机没记录过的历史会话，先用会话历史里的配置（如侧边对话、排队等未经过模型选择器的路径）。
      if (threadId) useModels.getState().seedFromHistory(targetId, agent, threadId, context.sessions[key]?.state.threads[threadId]?.savedConfig)
      const usedPrefs = prefsFor(useModels.getState(), targetId, agent, threadId)
      const overrides = overridesFor(targetId, agent, threadId)
      if (threadId) useModels.getState().rememberThreadPrefs(targetId, agent, threadId, usedPrefs)
      const report = (error: string | null) => options?.sideKey ? patchSide(options.sideKey, { error }) : set({ error })
      const sizeProblem = turnInputSizeProblem(adaptTurnInput(agent, input))
      if (sizeProblem) {
        report(sizeProblem)
        return false
      }
      if (chatKey && changingParentThreads.has(chatKey)) {
        report(t('正在更新该会话，请稍后重试'))
        return false
      }
      report(null)

      const enqueue = (address: ChatAddress) => {
        const item = { id: ++nextPendingId, text, input, overrides }
        updatePending(address, (list) => [...list, item])
        void flushPending(address)
        return true
      }

      if (mode === 'queue' && chat && chatKey && context.sessions[key]?.openedConfig?.directory === configDirFor(targetId, agent) && (
        context.sessions[key]?.state.threads[chat.threadId]?.status === 'running' ||
        context.pendingSends[chatKey]?.length || submitting.has(chatKey)
      )) return enqueue(chat)
      if (chatKey && submitting.has(chatKey)) {
        report(t('正在发送另一条消息，请稍后重试'))
        return false
      }

      const pendingUser = userItemFromInput(`local-user-${++nextPendingId}`, input)
      // 等上一轮中断时先在界面显示气泡，避免旧轮次的回显替换这条新消息。
      const preview = mode !== 'queue' && threadId ? pendingUser : undefined
      set({
        sending: true,
        sendingMessage: { key: chatKey ?? pendingSendKey({ targetId, agent, threadId: DRAFT_THREAD_ID }), preview },
      })
      if (chatKey) submitting.add(chatKey)
      sessionFor(targetId, agent)
      if (!preview) addPendingUser(key, threadId ?? DRAFT_THREAD_ID, pendingUser)
      const commitPreview = (threadId: string) => {
        if (!preview) return
        flushDeltas(key)
        set((state) => {
          const session = state.sessions[key]
          if (!session) return state
          return {
            sendingMessage: { key: pendingSendKey({ targetId, agent, threadId }) },
            sessions: { ...state.sessions, [key]: {
              ...session,
              state: addOptimisticUser(session.state, threadId, preview),
            } },
          }
        })
      }
      const rollback = () => {
        removePendingUser(key, [DRAFT_THREAD_ID, ...(threadId ? [threadId] : [])], pendingUser.id)
      }
      try {
        if (!(await ensureOpen(targetId, agent))) {
          throw new Error(get().sessions[key]?.openError ?? t('{agent} 未就绪', { agent: agentLabel(agent) }))
        }
        const session = get().sessions[key]
        if (!session) throw new Error(t('{agent} 未就绪', { agent: agentLabel(agent) }))
        const previousConfig = context.sessions[key]?.openedConfig
        if (threadId && previousConfig && previousConfig.directory !== session.openedConfig?.directory) {
          throw new Error(t('{agent} 配置目录已切换，请重新选择会话再发送', { agent: agentLabel(agent) }))
        }
        if (!threadId) {
          const created = await startThread(session.rpc, context.currentCwd ? { cwd: context.currentCwd } : {})
          const createdThreadId = created.thread.id
          flushDeltas(key)
          set((state) => {
            const value = state.sessions[key]
            const address = { targetId, agent, threadId: createdThreadId }
            return {
              access: rememberAccessMode(state.access, address, draftMode),
              sendingMessage: { key: pendingSendKey(address) },
              ...(value ? { sessions: { ...state.sessions, [key]: {
                ...value,
                state: moveOptimisticUsers(loadThread(value.state, created.thread), DRAFT_THREAD_ID, createdThreadId),
              } } } : {}),
            }
          })
          useModels.getState().rememberThreadPrefs(targetId, agent, createdThreadId, usedPrefs)
          options?.onThreadCreated?.(createdThreadId)
          threadId = createdThreadId
          chat = { targetId, agent, threadId: createdThreadId }
          chatKey = pendingSendKey(chat)
          // 首轮结束前 thread/list 可能查不到新会话，先用本地摘要占位，侧栏能立即看到。
          if (!options?.sideKey) {
            localThreads.set(chatKey, { targetId, summary: {
              id: createdThreadId,
              title: trimmed.split('\n')[0]?.trim() || t('未命名会话'),
              preview: trimmed,
              cwd: created.thread.cwd || context.currentCwd || '',
              updatedAt: Date.now(),
              agent,
            } })
          }
          submitting.add(chatKey)
          const current = get()
          if (
            current.currentTargetId === targetId && current.currentCwd === context.currentCwd && !current.currentThreadId &&
            current.access.draftRevision === context.access.draftRevision
          ) {
            set({ currentThreadId: createdThreadId, currentAgent: agent, access: resetDraftAccess(current.access) })
          }
          // 用户已切走时也要刷新该目标下的项目列表，让新会话出现在侧栏。
          if (!options?.sideKey) refreshThreadListsFor(targetId, agent, createdThreadId, created.thread.cwd || context.currentCwd || undefined)
        }
        if (!threadId) return false
        const view = get().sessions[key]?.state.threads[threadId]
        if (view?.status === 'running') {
          if (mode === 'queue' && chat) {
            rollback()
            return enqueue(chat)
          }
          const turnId = view.activeTurnId
          if (!turnId) throw new Error(t('暂未收到当前轮次，请稍后重试'))
          if (mode === 'steer') {
            // https://developers.openai.com/codex/app-server#steer-an-active-turn
            if (agent !== 'codex') throw new Error(t('当前 Agent 不支持引导'))
            commitPreview(threadId)
            await steerTurn(session.rpc, threadId, turnId, adaptTurnInput(agent, input))
            return true
          }
          if (chatKey) replacing.add(chatKey)
          await interruptAndWait(session, threadId, turnId)
          if (chatKey) replacing.delete(chatKey)
          if (get().sessions[key]?.state.threads[threadId]?.status === 'running') {
            throw new Error(t('会话已开始另一轮，请检查后再发送'))
          }
        }
        commitPreview(threadId)
        await startTurn(session, threadId, input, overrides, pendingUser)
        return true
      } catch (err) {
        rollback()
        report(friendlyError(err, t('发送消息失败')))
        if (chat && mode === 'immediate') pausePending(chat, t('立即发送未完成，队列已暂停'))
        return false
      } finally {
        if (chatKey) {
          submitting.delete(chatKey)
          replacing.delete(chatKey)
        }
        set({ sending: false, sendingMessage: null })
        if (chat) void flushPending(chat)
      }
    },

    removePendingSend: (chat, id) => {
      updatePending(chat, (list) => {
        const head = list[0]
        const remaining = list.filter((item) => item.id !== id || item.sending)
        if (head?.id === id && head.error && remaining[0] && !head.sending) {
          remaining[0] = { ...remaining[0], error: t('队列已暂停') }
        }
        return remaining
      })
    },

    retryPendingSend: (chat) => {
      void ensureOpen(chat.targetId, chat.agent).then((ok) => {
        if (ok) void flushPending(chat, true)
        else pausePending(chat, t('连接未就绪，请重新连接后继续'))
      })
    },

    holdPendingSend: (chat, id) => {
      const item = get().pendingSends[pendingSendKey(chat)]?.find((entry) => entry.id === id)
      if (!item || item.sending || holdingPending.has(id)) return null
      holdingPending.add(id)
      return (resume = true) => {
        if (holdingPending.delete(id) && resume) void flushPending(chat)
      }
    },

    editPendingSend: (chat, id, text) => {
      const item = get().pendingSends[pendingSendKey(chat)]?.find((entry) => entry.id === id)
      if (!item || item.sending || !holdingPending.has(id)) return false
      const input = replacePendingText(item.input, item.text, text)
      if (!input || turnInputSizeProblem(adaptTurnInput(chat.agent, input))) return false
      updatePending(chat, (list) => list.map((entry) => entry.id === id ? { ...entry, text, input } : entry))
      return true
    },

    steerPendingSend: async (chat, id) => {
      const key = pendingSendKey(chat)
      const state = get()
      const session = state.sessions[sessionKey(chat.targetId, chat.agent)]
      const view = session?.state.threads[chat.threadId]
      const turnId = view?.status === 'running' ? view.activeTurnId : null
      const item = state.pendingSends[key]?.find((entry) => entry.id === id)
      if (!canSteerQueued(chat.agent) || !session?.opened || !turnId || !item || item.sending ||
        submitting.has(key) || holdingPending.has(id)) return false
      submitting.add(key)
      updatePending(chat, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: true, error: undefined } : entry))
      const pendingUser = userItemFromInput(`local-user-${++nextPendingId}`, item.input)
      addPendingUser(session.key, chat.threadId, pendingUser)
      try {
        // https://developers.openai.com/codex/app-server#steer-an-active-turn
        await steerTurn(session.rpc, chat.threadId, turnId, adaptTurnInput(chat.agent, item.input))
        updatePending(chat, (list) => list.filter((entry) => entry.id !== id))
        return true
      } catch (err) {
        removePendingUser(session.key, [chat.threadId], pendingUser.id)
        const error = friendlyError(err, t('引导未成功，排队消息已保留'))
        updatePending(chat, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: false, error } : entry))
        return false
      } finally {
        submitting.delete(key)
        void flushPending(chat)
      }
    },

    sendPendingInNewThread: async (chat, id, mode) => {
      const key = pendingSendKey(chat)
      const state = get()
      const session = state.sessions[sessionKey(chat.targetId, chat.agent)]
      const item = state.pendingSends[key]?.find((entry) => entry.id === id)
      if ((mode === 'continue' && !canContinueQueued(chat.agent)) || !item || item.sending ||
        submitting.has(key) || holdingPending.has(id) || changingParentThreads.has(key)) return false
      if (!session?.opened) {
        updatePending(chat, (list) => list.map((entry) => entry.id === id ? { ...entry, error: t('连接未就绪，请重新连接后再试') } : entry))
        return false
      }
      const token = openThreadToken
      const cwd = currentThreads(state).find((thread) => thread.id === chat.threadId && thread.agent === chat.agent)?.cwd ||
        state.currentCwd
      let created: string | null = null
      let pendingUser: PendingUser | null = null
      submitting.add(key)
      updatePending(chat, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: true, error: undefined } : entry))
      try {
        let thread
        if (mode === 'continue') {
          // 只分叉到最后一个已结束的轮次，不带入原会话正在执行的工作。
          const lastTurn = session.state.threads[chat.threadId]?.turns?.filter((turn) => turn.outcome).at(-1)
          if (!lastTurn) throw new Error(t('当前还没有已结束的一轮，可用「新会话开始」'))
          ;({ thread } = await forkThread(session.rpc, chat.threadId, lastTurn.id))
          // 分支会复制原标题，自动加 (n) 后缀区分；改名失败不影响发送。
          const title = thread?.id ? forkedThreadTitle(get(), chat.targetId, chat.agent, chat.threadId) : null
          if (title) await setThreadName(session.rpc, thread.id, title).catch(() => undefined)
        } else {
          ;({ thread } = await startThread(session.rpc, cwd ? { cwd } : {}))
        }
        if (!thread?.id || thread.id === chat.threadId) throw new Error(t('未确认新会话已创建，排队消息已保留'))
        const threadId = thread.id
        created = threadId
        patchSession(session.key, (value) => ({ ...value, state: loadThread(value.state, thread) }))
        pendingUser = userItemFromInput(`local-user-${++nextPendingId}`, item.input)
        addPendingUser(session.key, threadId, pendingUser)
        // 用户仍停在原会话时跟随切过去；期间打开过别的会话则只在后台发送。
        if (token === openThreadToken && isMainChat(get(), chat)) set({ currentThreadId: threadId, error: null })
        // 新会话不继承原会话的单独授权，按权限总控发送。
        await startTurn(session, threadId, item.input, item.overrides, pendingUser)
        updatePending(chat, (list) => list.filter((entry) => entry.id !== id))
        return true
      } catch (err) {
        if (created && pendingUser) removePendingUser(session.key, [created], pendingUser.id)
        const error = friendlyError(err, created ? t('新会话已创建但消息未发送，排队消息已保留') : t('新会话发送失败，排队消息已保留'))
        updatePending(chat, (list) => list.map((entry) => entry.id === id ? { ...entry, sending: false, error } : entry))
        // 已切到新会话时原队列不在眼前，错误要显示在当前界面上。
        if (created && isMainChat(get(), { ...chat, threadId: created })) set({ error })
        return false
      } finally {
        submitting.delete(key)
        if (created) void get().refreshThreads({ targetId: chat.targetId, cwd })
        void flushPending(chat)
      }
    },

    openSideChat: (quote) => {
      const state = get()
      if (!state.currentTargetId || !state.currentThreadId) return
      if (changingParentThreads.has(pendingSendKey({
        targetId: state.currentTargetId, agent: state.currentAgent, threadId: state.currentThreadId,
      }))) return
      const key = currentChatKey(state)
      const parent = currentThreads(state).find((thread) => thread.id === state.currentThreadId && thread.agent === state.currentAgent)
      const side = state.sideChats[key] ?? {
        targetId: state.currentTargetId, cwd: parent?.cwd || state.currentCwd, agent: state.currentAgent,
        parentThreadId: state.currentThreadId,
        threadId: null, draft: '', annotations: [], firstMessage: '', error: null, expired: false, busy: false,
      }
      const annotations = quote?.trim() ? [...side.annotations, sideAnnotation(quote)] : side.annotations
      set({ sideChats: { ...state.sideChats, [key]: { ...side, open: true, annotations } } })
    },

    addSideAnnotation: (quote, comment) => {
      const state = get()
      const side = currentSideChat(state)
      if (side && quote.trim()) {
        patchSide(currentChatKey(state), { annotations: [...side.annotations, sideAnnotation(quote, comment)] })
      }
    },
    editSideAnnotation: (id, quote) => {
      const state = get()
      const side = currentSideChat(state)
      if (side && !side.busy) {
        patchSide(currentChatKey(state), {
          annotations: side.annotations.map((annotation) => annotation.id === id ? { ...annotation, quote } : annotation),
        })
      }
    },
    removeSideAnnotation: (id) => {
      const state = get()
      const side = currentSideChat(state)
      if (side && !side.busy) {
        patchSide(currentChatKey(state), { annotations: side.annotations.filter((annotation) => annotation.id !== id) })
      }
    },

    sendSide: async (text, mode) => {
      const key = currentChatKey(get())
      const side = get().sideChats[key]
      if (!side || side.busy || side.expired ||
        changingParentThreads.has(pendingSendKey(parentAddress(side)))) return
      const message = buildAnnotatedMessage(side.annotations, text)
      if (!message) return
      patchSide(key, { busy: true, error: null })
      const { targetId, agent } = side
      try {
        let threadId = side.threadId
        if (!threadId) {
          threadId = await createSideThread(side)
          patchSide(key, { threadId })
        }
        if (get().sending) throw new Error(t('正在提交另一条消息，请稍后重试'))
        if (get().sideChats[key]?.expired) return
        const sent = await get().send(message, { targetId, agent, threadId, sideKey: key, mode })
        const latest = get().sideChats[key]
        if (sent && latest) {
          const sentAnnotations = new Set(side.annotations.map((annotation) => annotation.id))
          patchSide(key, {
            firstMessage: latest.firstMessage || message,
            draft: latest.draft === text ? '' : latest.draft,
            annotations: latest.annotations.filter((annotation) => !sentAnnotations.has(annotation.id)),
          })
        }
      } catch (err) {
        patchSide(key, { error: friendlyError(err, t('侧聊发送失败')) })
      } finally {
        patchSide(key, { busy: false })
      }
    },

    setSideDraft: (draft) => patchSide(currentChatKey(get()), { draft }),
    clearSideError: () => patchSide(currentChatKey(get()), { error: null }),
    closeSideChat: () => patchSide(currentChatKey(get()), { open: false }),
    restartSideChat: async () => {
      const state = get()
      const side = currentSideChat(state)
      if (!side?.expired || !side.threadId || side.busy ||
        changingParentThreads.has(pendingSendKey(parentAddress(side)))) return
      const key = currentChatKey(state)
      const oldKey = pendingSendKey({ ...side, threadId: side.threadId })
      if (submitting.has(oldKey)) return
      if (!state.pendingSends[oldKey]?.length) {
        forgetSideTranscript(side)
        patchSide(key, {
          threadId: null, expired: false, error: null, firstMessage: '',
          draft: side.annotations.length ? side.draft : side.draft || side.firstMessage,
        })
        return
      }
      patchSide(key, { busy: true })
      try {
        // 保留提交顺序，并让用户决定何时在新的上下文里继续发送。
        const threadId = await createSideThread(side)
        const newKey = pendingSendKey({ ...side, threadId })
        set((state) => {
          const { [oldKey]: queue, ...pendingSends } = state.pendingSends
          if (queue?.length) {
            pendingSends[newKey] = queue.map((item, index) => index === 0
              ? { ...item, error: t('侧聊已重开，检查后可继续发送') }
              : item)
          }
          return { pendingSends }
        })
        if (side.threadId !== threadId) forgetSideTranscript(side)
        patchSide(key, { threadId, firstMessage: '', expired: false, busy: false, error: null })
      } catch (err) {
        patchSide(key, { busy: false, error: friendlyError(err, t('重新开始侧聊失败')) })
      }
    },
    endSideChat: async () => {
      const key = currentChatKey(get())
      const side = get().sideChats[key]
      if (!side || changingParentThreads.has(pendingSendKey(parentAddress(side)))) return
      if (sideHasWork(side)) {
        patchSide(key, { error: t('请先停止当前轮次并处理审批或排队消息') })
        return
      }
      const { targetId, agent, threadId } = side
      patchSide(key, { busy: true })
      try {
        if (threadId && !side.expired) {
          const session = get().sessions[sessionKey(targetId, agent)]
          if (!session) throw new Error(t('侧聊连接已断开'))
          await session.rpc.request('thread/unsubscribe', { threadId })
        }
        dropSide(key, side)
      } catch (err) {
        patchSide(key, { busy: false, error: friendlyError(err, t('结束侧聊失败')) })
      }
    },

    interrupt: async () => {
      const { currentTargetId, currentThreadId, currentAgent } = get()
      if (!currentTargetId || !currentThreadId) {
        set({ notice: t('当前没有运行中的 turn') })
        return
      }
      await interruptFor(currentTargetId, currentAgent, currentThreadId)
    },

    interruptSide: async () => {
      const side = currentSideChat(get())
      if (side?.threadId) await interruptFor(side.targetId, side.agent, side.threadId)
    },

    respondApproval: (chat, requestId, decision) => {
      const state = get()
      const main = isMainChat(state, chat)
      const side = currentSideChat(state)
      const inSide = side?.open && !side.expired && side.targetId === chat.targetId
        && side.agent === chat.agent && side.threadId === chat.threadId
      // 旧卡片可能在切换会话后才触发事件，审批仍须来自当前可见会话。
      if (openingAnotherChat(state) || (!main && !inSide)) return

      const report = (error: string | null) => main ? set({ error }) : patchSide(currentChatKey(state), { error })
      const key = sessionKey(chat.targetId, chat.agent)
      const session = state.sessions[key]
      const approval = session?.state.threads[chat.threadId]?.pendingApprovals.find((item) => item.requestId === requestId)
      if (!session || !approval) {
        report(t('该审批请求已失效'))
        return
      }
      try {
        session.rpc.respond(approval.requestId, approvalResponse(approval, decision))
        patchSession(key, (value) => ({
          ...value,
          state: resolveServerRequest(value.state, approval.requestId),
        }))
        report(null)
      } catch (err) {
        report(friendlyError(err, t('提交审批失败')))
      }
    },

    renameThread: async (threadId, agent, name) => {
      const targetId = get().currentTargetId
      const ok = await withSession(agent, t('重命名失败'), (session) => setThreadName(session.rpc, threadId, name).then(() => true))
      if (ok === null) return false
      if (targetId) refreshThreadListsFor(targetId, agent, threadId)
      return true
    },

    archiveThread: (threadId, agent) => removeParentThread(threadId, agent, 'archive'),

    deleteThread: (threadId, agent) => removeParentThread(threadId, agent, 'delete'),

    forkThread: async (threadId, agent, lastTurnId) => {
      const { currentTargetId: targetId, currentCwd: cwd } = get()
      const token = openThreadToken
      const result = await withSession(agent, t('创建分支失败'), (session) => forkThread(session.rpc, threadId, lastTurnId))
      if (!result || !targetId) return false
      // 分支沿用原会话的模型与推理强度。
      useModels.getState().rememberThreadPrefs(targetId, agent, result.thread.id, prefsFor(useModels.getState(), targetId, agent, threadId))
      patchSession(sessionKey(targetId, agent), (value) => ({
        ...value,
        state: loadThread(value.state, result.thread),
      }))
      // 分支会复制原标题，自动加 (n) 后缀区分；改名失败只保留原标题。
      const title = forkedThreadTitle(get(), targetId, agent, threadId)
      const session = get().sessions[sessionKey(targetId, agent)]
      if (title && session) await setThreadName(session.rpc, result.thread.id, title).catch(() => undefined)
      if (token === openThreadToken) {
        set({ currentThreadId: result.thread.id, currentAgent: agent, error: null, notice: t('已创建聊天分支') })
      }
      void get().refreshThreads({ targetId, cwd })
      return true
    },

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  }
})
