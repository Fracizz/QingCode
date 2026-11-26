import { create } from 'zustand'
import {
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
  interruptTurn,
  listThreads,
  loadThread,
  moveOptimisticUsers,
  readThread,
  requestSubagents,
  resolveServerRequest,
  resumeThread,
  sendInput,
  setThreadName,
  startThread,
  steerTurn,
  supportsSubagentRequests,
  userItemFromInput,
  type ApprovalDecision,
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
import { attachResult, BackendCodexTransport, maxSeq, openSeq } from '../lib/codexTransport'
import { describeCodexOpenError, friendlyError, isActiveWriterError } from '../lib/errors'
import { mergeThreadSummaries, toThreadSummaries, type ThreadSummary } from '../lib/threads'
import {
  AGENTS,
  DEFAULT_AGENT,
  agentLabel,
  classifyAgentOpenError,
  emptyAgentStatus,
  preferredAgent,
  sessionKey,
  type AgentAvailability,
} from '../lib/agents'
import { quoteBlock } from '../lib/annotations'
import { agentPrefs } from '../features/settings/settingsModel'
import { useSettings } from '../features/settings/settingsStore'
import { adaptTurnInput } from '../features/composer/agentInput'
import {
  emptyAccessMemory,
  getAccessMode,
  rememberAccessMode,
  resetDraftAccess,
  resetTargetAccess,
  targetAgentKeyPrefix,
  turnAccessOverride,
  type AccessAddress,
  type AccessMemory,
  type AccessMode,
} from '../features/access/accessModel'
import { configuredAgentOpen } from '../features/access/openConfig'
import { useAgentPrefs } from './agentPrefs'
import { overridesFor } from './models'
import { useTargets } from './targets'

type TargetSession = {
  key: string
  targetId: string
  agent: AgentKind
  rpc: CodexRpc
  transport: BackendCodexTransport
  state: ConversationState
  threadsAwaitingResume: ReadonlySet<string>
  opened: boolean
  openedConfig: { directory: string | undefined; accessModes: boolean } | null
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

type CodexState = {
  sessions: Record<string, TargetSession>
  agents: Record<string, Record<AgentKind, AgentAvailability>>
  currentTargetId: string | null
  currentCwd: string | null
  currentThreadId: string | null
  currentAgent: AgentKind
  threads: ThreadSummary[]
  threadsLoading: boolean
  threadsError: string | null
  sending: boolean
  sendingMessage: { key: string; preview?: PendingUser } | null
  access: AccessMemory
  pendingSends: Record<string, PendingSend[]>
  error: string | null
  notice: string | null
  sideOpen: boolean
  sideTargetId: string | null
  sideCwd: string | null
  sideAgent: AgentKind | null
  sideThreadId: string | null
  sideDraft: string
  sideError: string | null
  init: () => () => void
  setContext: (targetId: string | null, cwd: string | null, refresh?: boolean) => void
  ensureOpen: (targetId: string, agent?: AgentKind) => Promise<boolean>
  probeAgents: (targetId: string) => Promise<void>
  refreshThreads: () => Promise<void>
  newThread: (agent?: AgentKind) => Promise<void>
  /** 回到"新会话"草稿态（参考 Codex 的 New thread）：不立即建会话，发第一条消息时再创建，避免留下空会话。 */
  startDraft: (agent?: AgentKind) => void
  /** 草稿态下切换下一条消息使用的 Agent；已打开会话时 Agent 跟随会话，不可切换。 */
  setDraftAgent: (agent: AgentKind) => void
  setAccessMode: (address: AccessAddress, draftRevision: number, mode: AccessMode) => void
  openThread: (threadId: string, agent?: AgentKind) => Promise<void>
  /** 返回是否成功提交；失败时调用方要把输入框内容还回去。 */
  send: (text: string, options?: SendOptions) => Promise<boolean>
  sendSide: (text: string, mode: SendMode) => Promise<void>
  removePendingSend: (chat: ChatAddress, id: number) => void
  retryPendingSend: (chat: ChatAddress) => void
  openSideChat: (quote: string) => Promise<void>
  setSideDraft: (draft: string) => void
  clearSideError: () => void
  closeSideChat: () => void
  interrupt: () => Promise<void>
  interruptSide: () => Promise<void>
  respondApproval: (requestId: RequestId, decision: ApprovalDecision) => void
  /** 以下会话管理操作只对支持对应 RPC 的 agent（Codex）生效；成功返回 true 并刷新列表。 */
  renameThread: (threadId: string, agent: AgentKind, name: string) => Promise<boolean>
  archiveThread: (threadId: string, agent: AgentKind) => Promise<boolean>
  deleteThread: (threadId: string, agent: AgentKind) => Promise<boolean>
  /** 分叉出新会话并切换过去。 */
  /** lastTurnId：只分叉到该轮为止（含），用于"从这条回复分支"。 */
  forkThread: (threadId: string, agent: AgentKind, lastTurnId?: string) => Promise<boolean>
  clearError: () => void
  clearNotice: () => void
}

let subscribed = false
let offEvents: Array<() => void> = []

export const useCodex = create<CodexState>((set, get) => {
  const opening = new Map<string, Promise<boolean>>()
  const probing = new Map<string, Promise<void>>()
  const submitting = new Set<string>()
  const replacing = new Set<string>()
  let nextPendingId = 0
  let refreshToken = 0

  const patchSession = (key: string, update: (session: TargetSession) => TargetSession): void => {
    set((state) => {
      const session = state.sessions[key]
      if (!session) return state
      const next = update(session)
      if (next === session) return state
      return { sessions: { ...state.sessions, [key]: next } }
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
      return { sessions, access: resetDraftAccess(state.access) }
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
      patchSession(key, (current) => ({
        ...current,
        state: applyNotification(current.state, notification),
      }))
      if (notification.method === 'turn/completed' && notification.params?.threadId && notification.params.turn) {
        const chat = { targetId, agent, threadId: notification.params.threadId }
        if (notification.params.turn.status === 'completed') void flushPending(chat)
        else if (!replacing.has(pendingSendKey(chat))) pausePending(chat, '上一轮未完成，队列已暂停', true)
      }
      const method = (notification as { method?: unknown }).method
      if (
        method === 'turn/completed' ||
        method === 'thread/started' ||
        method === 'thread/name/updated'
      ) {
        if (get().currentTargetId === targetId) void get().refreshThreads()
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
          throw new Error('目标服务暂不支持 Agent 配置目录，请升级目标服务后重试')
        }
        const replaced = agent === 'codex' && session.openedConfig !== null && session.openedConfig.directory !== directory
        if (replaced) {
          const prefix = targetAgentKeyPrefix(targetId, agent)
          patchSession(key, (value) => ({ ...value, state: emptyState(), threadsAwaitingResume: new Set() }))
          set((state) => ({
            access: resetTargetAccess(state.access, targetId, agent),
            pendingSends: Object.fromEntries(Object.entries(state.pendingSends).filter(([key]) => !key.startsWith(prefix))),
            ...(state.currentTargetId === targetId ? {
              threads: state.threads.filter((thread) => thread.agent !== agent),
              ...(state.currentAgent === agent && state.currentThreadId !== null ? {
                currentThreadId: null,
                notice: 'Codex 配置目录已切换，请重新选择会话',
              } : {}),
            } : {}),
            ...(state.sideTargetId === targetId && state.sideAgent === agent ? { sideOpen: false, sideThreadId: null } : {}),
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
            set({ notice: `${agentLabel(agent)} 历史缓冲已裁剪，请重新打开会话加载完整记录` })
          }
        } catch {
          // 旧版 daemon 没有 attach 时仍能正常对话。
        }

        session.transport.setLastSeq(lastSeq)
        patchSession(key, (value) => ({
          ...value,
          opened: true,
          openedConfig: { directory, accessModes: capabilities?.accessModes === true },
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
            : friendlyError(err, agent === 'pi' ? '打开 pi 失败' : '打开 Claude 失败')
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
      set({ error: get().sessions[key]?.openError ?? `${agentLabel(agent)} 未就绪` })
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
      set({ error: friendlyError(err, '新建会话失败') })
      return null
    }
  }

  const interruptFor = async (
    targetId: string,
    agent: AgentKind,
    threadId: string | null,
  ): Promise<void> => {
    if (!threadId) {
      set({ notice: '当前没有运行中的 turn' })
      return
    }
    const session = get().sessions[sessionKey(targetId, agent)]
    if (!session) return
    const view = session.state.threads[threadId]
    const turnId = view?.activeTurnId
    if (!turnId) {
      set({ notice: '当前没有运行中的 turn' })
      return
    }
    try {
      await interruptTurn(session.rpc, threadId, turnId)
      set({ notice: '已请求中断当前 turn' })
    } catch (err) {
      set({ error: friendlyError(err, '中断失败') })
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
      set({ error: '请先选择目标' })
      return null
    }
    if (!(await ensureOpen(targetId, agent))) {
      set({ error: get().sessions[sessionKey(targetId, agent)]?.openError ?? `${agentLabel(agent)} 未就绪` })
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
      const { thread } = await resumeThread(session.rpc, threadId)
      patchSession(session.key, (value) => {
        const threadsAwaitingResume = new Set(value.threadsAwaitingResume)
        threadsAwaitingResume.delete(threadId)
        const state = loadThread(value.state, thread)
        return {
          ...value,
          threadsAwaitingResume,
          state: addOptimisticUser(state, threadId, pendingUser),
        }
      })
      if (get().sessions[session.key]?.state.threads[threadId]?.status === 'running') {
        throw new Error('会话已有正在执行的轮次，请等待完成后再发送')
      }
    }
    const observed = new Set<string>()
    const unsubscribe = session.rpc.onNotification((note) => {
      if ((note.method === 'turn/started' || note.method === 'turn/completed') && note.params?.threadId === threadId) {
        if (note.params.turn?.id) observed.add(note.params.turn.id)
      }
    })
    try {
      const mode = getAccessMode(get().access, { targetId: session.targetId, agent: session.agent, threadId })
      const access = turnAccessOverride(session.agent, mode)
      if (access && session.openedConfig?.accessModes !== true) {
        throw new Error('目标服务暂不支持当前访问模式，请升级目标服务后重试')
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
          pausePending({ targetId: session.targetId, agent: session.agent, threadId }, '上一轮未完成，队列已暂停', true)
        }
      }
    } finally {
      unsubscribe()
    }
  }

  async function flushPending(chat: ChatAddress, retry = false): Promise<void> {
    const key = pendingSendKey(chat)
    const session = get().sessions[sessionKey(chat.targetId, chat.agent)]
    const view = session?.state.threads[chat.threadId]
    const next = get().pendingSends[key]?.[0]
    if (!session?.opened || !view || !next || submitting.has(key)) return
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
      pausePending(chat, friendlyError(err, '排队消息未发送'))
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
      if (!(await finished)) throw new Error('未确认当前一轮已停止，请检查会话后重试')
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  }

  return {
    sessions: {},
    agents: {},
    currentTargetId: null,
    currentCwd: null,
    currentThreadId: null,
    currentAgent: DEFAULT_AGENT,
    threads: [],
    threadsLoading: false,
    threadsError: null,
    sending: false,
    sendingMessage: null,
    access: emptyAccessMemory,
    pendingSends: {},
    error: null,
    notice: null,
    sideOpen: false,
    sideTargetId: null,
    sideCwd: null,
    sideAgent: null,
    sideThreadId: null,
    sideDraft: '',
    sideError: null,

    init: () => {
      if (subscribed) return () => undefined
      subscribed = true
      offEvents = [
        on('server.evt', (payload) => {
          if (payload.name !== 'codex.exited') return
          const exitedAgent = (payload.payload as { agent?: unknown } | null)?.agent
          const keys = Object.entries(get().sessions)
            .filter(([, session]) => session.targetId === payload.targetId)
            .filter(([, session]) => exitedAgent === undefined || exitedAgent === session.agent)
            .map(([key]) => key)
          for (const key of keys) {
            const agent = get().sessions[key]?.agent
            patchSession(key, (value) => ({
              ...value,
              opened: false,
              openError: `${agentLabel(value.agent)} 进程已退出，下次操作将重新启动`,
            }))
            if (agent) patchAgent(payload.targetId, agent, { state: 'unknown' })
          }
          if (get().currentTargetId === payload.targetId) {
            set({ notice: 'Agent 进程已退出，请重试' })
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
          // 连接就绪后检测两个 agent，用于新建会话的可选项与占位符。
          void get().probeAgents(payload.id)
        }),
      ]
      return () => {
        for (const off of offEvents) off()
        offEvents = []
        subscribed = false
      }
    },

    setContext: (targetId, cwd, refresh = false) => {
      clearAllDrafts()
      set({
        currentTargetId: targetId,
        currentCwd: cwd,
        currentThreadId: null,
        currentAgent: targetId ? defaultFor(targetId) : DEFAULT_AGENT,
        threads: [],
        threadsError: null,
        error: null,
        sideOpen: false,
        sideThreadId: null,
        sideDraft: '',
        sideError: null,
      })
      if (refresh && targetId) void get().refreshThreads()
    },

    ensureOpen,
    probeAgents,

    refreshThreads: async () => {
      const token = ++refreshToken
      const targetId = get().currentTargetId
      if (!targetId) {
        set({ threads: [], threadsLoading: false, threadsError: null })
        return
      }
      await get().probeAgents(targetId)
      if (token !== refreshToken || get().currentTargetId !== targetId) return
      set({ threadsLoading: true, threadsError: null })
      const lists = await Promise.all(
        AGENTS.map(async (agent) => {
          const key = sessionKey(targetId, agent)
          const session = get().sessions[key]
          if (statusFor(targetId, agent)?.state !== 'ready' || !session?.opened) return []
          try {
            return toThreadSummaries(
              await listThreads(session.rpc, get().currentCwd ?? undefined),
              agent,
            )
          } catch (err) {
            const detail = `${agentLabel(agent)}：${friendlyError(err, '加载会话列表失败')}`
            set((state) => ({ threadsError: state.threadsError ?? detail }))
            return []
          }
        }),
      )
      if (token !== refreshToken || get().currentTargetId !== targetId) return
      set({ threads: mergeThreadSummaries(lists), threadsLoading: false })
    },

    newThread: async (agent) => {
      const targetId = get().currentTargetId
      if (!targetId) {
        set({ error: '请先选择目标' })
        return
      }
      const picked = agent ?? get().currentAgent
      const reason = statusFor(targetId, picked)
      if (reason?.state === 'unavailable') {
        set({ error: `${agentLabel(picked)} 不可用：${reason.detail ?? '未安装'}` })
        return
      }
      const threadId = await startNewThread(targetId, picked, {
        cwd: get().currentCwd,
        ephemeral: false,
      })
      if (!threadId) return
      clearAllDrafts()
      set({ currentThreadId: threadId, currentAgent: picked, error: null })
      void get().refreshThreads()
    },

    startDraft: (agent) => {
      clearAllDrafts()
      const targetId = get().currentTargetId
      // 设过默认的连接，新会话回到默认；没设过则沿用当前 Agent。
      const chosen = targetId && useAgentPrefs.getState().byTarget[targetId] ? defaultFor(targetId) : null
      set((state) => ({
        currentThreadId: null,
        currentAgent: agent ?? chosen ?? state.currentAgent,
        error: null,
      }))
    },

    setDraftAgent: (agent) => {
      set((state) => {
        if (state.currentThreadId || state.currentAgent === agent) return state
        return { currentAgent: agent, error: null, access: resetDraftAccess(state.access) }
      })
    },

    setAccessMode: (address, draftRevision, mode) => {
      set((state) => {
        const { targetId, agent, threadId } = address
        const session = state.sessions[sessionKey(targetId, agent)]
        if (
          state.currentTargetId !== targetId || state.currentAgent !== agent || state.currentThreadId !== threadId ||
          session?.openedConfig?.accessModes !== true ||
          state.sending || (threadId === null && state.access.draftRevision !== draftRevision) ||
          (threadId !== null && (session.state.threads[threadId]?.status === 'running' || submitting.has(pendingSendKey({ targetId, agent, threadId }))))
        ) return state
        return { access: rememberAccessMode(state.access, address, mode) }
      })
    },

    openThread: async (threadId, agent) => {
      clearAllDrafts()
      const targetId = get().currentTargetId
      if (!targetId) {
        set({ error: '请先选择目标' })
        return
      }
      const picked = agent ?? get().currentAgent
      const key = sessionKey(targetId, picked)
      if (!(await ensureOpen(targetId, picked))) {
        set({ error: get().sessions[key]?.openError ?? `${agentLabel(picked)} 未就绪` })
        return
      }
      const session = get().sessions[key]
      if (!session) return
      try {
        let result: { thread: Parameters<typeof loadThread>[1] }
        let writerConflict = false
        try {
          result = await resumeThread(session.rpc, threadId)
        } catch (err) {
          writerConflict = picked === 'codex' && isActiveWriterError(err)
          result = await readThread(session.rpc, threadId)
        }
        patchSession(key, (value) => {
          const threadsAwaitingResume = new Set(value.threadsAwaitingResume)
          if (writerConflict) threadsAwaitingResume.add(threadId)
          else threadsAwaitingResume.delete(threadId)
          return { ...value, threadsAwaitingResume, state: loadThread(value.state, result.thread) }
        })
        set({ currentThreadId: threadId, currentAgent: picked, error: null })
        const chat = { targetId, agent: picked, threadId }
        if (writerConflict) {
          const message = '会话被另一个 Codex 进程占用，当前可查看历史。释放会话后可再次发送'
          pausePending(chat, message)
          set({ notice: message })
        } else {
          void flushPending(chat)
        }
      } catch (err) {
        set({ error: friendlyError(err, '打开会话失败') })
      }
    },

    send: async (text, options) => {
      const trimmed = text.trim()
      const userInput: UserInput[] = options?.input ?? (trimmed ? [{ type: 'text', text: trimmed, text_elements: [] }] : [])
      const context = get()
      if (userInput.length === 0 || context.sending) return false
      const targetId = options?.targetId ?? context.currentTargetId
      if (!targetId) {
        set({ error: '请先选择目标' })
        return false
      }
      const agent = options?.agent ?? context.currentAgent
      const input = options?.delegate && supportsSubagentRequests(agent) ? requestSubagents(userInput) : userInput
      const key = sessionKey(targetId, agent)
      let threadId = options?.threadId ?? context.currentThreadId
      const draftMode = getAccessMode(context.access, { targetId, agent, threadId: null })
      let chat = threadId ? { targetId, agent, threadId } : null
      let chatKey = chat ? pendingSendKey(chat) : null
      const mode = options?.mode ?? 'queue'
      const overrides = overridesFor(targetId, agent)
      const errorField = options?.targetId ? 'sideError' : 'error'
      set({ [errorField]: null })

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
        set({ [errorField]: '正在发送另一条消息，请稍后重试' })
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
          throw new Error(get().sessions[key]?.openError ?? `${agentLabel(agent)} 未就绪`)
        }
        const session = get().sessions[key]
        if (!session) throw new Error(`${agentLabel(agent)} 未就绪`)
        const previousConfig = context.sessions[key]?.openedConfig
        if (agent === 'codex' && threadId && previousConfig && previousConfig.directory !== session.openedConfig?.directory) {
          throw new Error('Codex 配置目录已切换，请重新选择会话再发送')
        }
        if (!threadId) {
          const created = await startThread(session.rpc, context.currentCwd ? { cwd: context.currentCwd } : {})
          const createdThreadId = created.thread.id
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
          threadId = createdThreadId
          chat = { targetId, agent, threadId: createdThreadId }
          chatKey = pendingSendKey(chat)
          submitting.add(chatKey)
          const current = get()
          if (
            current.currentTargetId === targetId && current.currentCwd === context.currentCwd && !current.currentThreadId &&
            current.access.draftRevision === context.access.draftRevision
          ) {
            set({ currentThreadId: createdThreadId, currentAgent: agent, access: resetDraftAccess(current.access) })
            void get().refreshThreads()
          }
        }
        if (!threadId) return false
        const view = get().sessions[key]?.state.threads[threadId]
        if (view?.status === 'running') {
          if (mode === 'queue' && chat) {
            rollback()
            return enqueue(chat)
          }
          const turnId = view.activeTurnId
          if (!turnId) throw new Error('暂未收到当前轮次，请稍后重试')
          if (mode === 'steer') {
            // https://developers.openai.com/codex/app-server#steer-an-active-turn
            if (agent !== 'codex') throw new Error('当前 Agent 不支持引导')
            commitPreview(threadId)
            await steerTurn(session.rpc, threadId, turnId, adaptTurnInput(agent, input))
            return true
          }
          if (chatKey) replacing.add(chatKey)
          await interruptAndWait(session, threadId, turnId)
          if (chatKey) replacing.delete(chatKey)
          if (get().sessions[key]?.state.threads[threadId]?.status === 'running') {
            throw new Error('会话已开始另一轮，请检查后再发送')
          }
        }
        commitPreview(threadId)
        await startTurn(session, threadId, input, overrides, pendingUser)
        return true
      } catch (err) {
        rollback()
        set({ [errorField]: friendlyError(err, '发送消息失败') })
        if (chat && mode === 'immediate') pausePending(chat, '立即发送未完成，队列已暂停')
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
          remaining[0] = { ...remaining[0], error: '队列已暂停' }
        }
        return remaining
      })
    },

    retryPendingSend: (chat) => {
      void ensureOpen(chat.targetId, chat.agent).then((ok) => {
        if (ok) void flushPending(chat, true)
        else pausePending(chat, '连接未就绪，请重新连接后继续')
      })
    },

    sendSide: async (text, mode) => {
      const { sideTargetId, sideAgent, sideThreadId } = get()
      if (!sideTargetId || !sideAgent || !sideThreadId) return
      const value = text.trim()
      if (!value) return
      const sent = await get().send(value, {
        targetId: sideTargetId,
        agent: sideAgent,
        threadId: sideThreadId,
        mode,
      })
      if (sent && get().sideThreadId === sideThreadId && get().sideDraft === text) set({ sideDraft: '' })
    },

    openSideChat: async (quote) => {
      const targetId = get().currentTargetId
      if (!targetId) {
        set({ error: '请先选择目标' })
        return
      }
      const agent = get().currentAgent
      const cwd = get().currentCwd
      const threadId = await startNewThread(targetId, agent, { cwd, ephemeral: true })
      if (!threadId) {
        set({ sideError: get().error ?? '创建临时会话失败' })
        return
      }
      set({
        sideOpen: true,
        sideTargetId: targetId,
        sideCwd: cwd,
        sideAgent: agent,
        sideThreadId: threadId,
        sideDraft: quoteBlock(quote),
        sideError: null,
      })
    },

    setSideDraft: (draft) => set({ sideDraft: draft }),

    clearSideError: () => set({ sideError: null }),

    closeSideChat: () => set({ sideOpen: false }),

    interrupt: async () => {
      const { currentTargetId, currentThreadId, currentAgent } = get()
      if (!currentTargetId || !currentThreadId) {
        set({ notice: '当前没有运行中的 turn' })
        return
      }
      await interruptFor(currentTargetId, currentAgent, currentThreadId)
    },

    interruptSide: async () => {
      const { sideTargetId, sideAgent, sideThreadId } = get()
      if (!sideTargetId || !sideAgent) {
        set({ notice: '当前没有运行中的 turn' })
        return
      }
      await interruptFor(sideTargetId, sideAgent, sideThreadId)
    },

    respondApproval: (requestId, decision) => {
      const targets = [...new Set([get().currentTargetId, get().sideTargetId].filter(
        (value): value is string => typeof value === 'string',
      ))]
      for (const [key, session] of Object.entries(get().sessions)) {
        if (!targets.includes(session.targetId)) continue
        const approval = Object.values(session.state.threads)
          .flatMap((thread) => thread.pendingApprovals)
          .find((item) => item.requestId === requestId)
        if (!approval) continue
        try {
          session.rpc.respond(approval.requestId, approvalResponse(approval, decision))
          patchSession(key, (value) => ({
            ...value,
            state: resolveServerRequest(value.state, approval.requestId),
          }))
          set({ error: null })
          return
        } catch (err) {
          set({ error: friendlyError(err, '提交审批失败') })
          return
        }
      }
      set({ error: '该审批请求已失效' })
    },

    renameThread: async (threadId, agent, name) => {
      const ok = await withSession(agent, '重命名失败', (session) => setThreadName(session.rpc, threadId, name).then(() => true))
      if (ok === null) return false
      void get().refreshThreads()
      return true
    },

    archiveThread: async (threadId, agent) => {
      const ok = await withSession(agent, '归档失败', (session) => archiveThread(session.rpc, threadId).then(() => true))
      if (ok === null) return false
      leaveIfCurrent(threadId, agent)
      set((state) => ({ threads: state.threads.filter((t) => !(t.id === threadId && t.agent === agent)) }))
      void get().refreshThreads()
      return true
    },

    deleteThread: async (threadId, agent) => {
      const ok = await withSession(agent, '删除失败', (session) => deleteThread(session.rpc, threadId).then(() => true))
      if (ok === null) return false
      leaveIfCurrent(threadId, agent)
      set((state) => ({ threads: state.threads.filter((t) => !(t.id === threadId && t.agent === agent)) }))
      void get().refreshThreads()
      return true
    },

    forkThread: async (threadId, agent, lastTurnId) => {
      const targetId = get().currentTargetId
      const result = await withSession(agent, '创建分支失败', (session) => forkThread(session.rpc, threadId, lastTurnId))
      if (!result || !targetId) return false
      patchSession(sessionKey(targetId, agent), (value) => ({
        ...value,
        state: loadThread(value.state, result.thread),
      }))
      set({ currentThreadId: result.thread.id, currentAgent: agent, error: null, notice: '已创建聊天分支' })
      void get().refreshThreads()
      return true
    },

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  }
})
