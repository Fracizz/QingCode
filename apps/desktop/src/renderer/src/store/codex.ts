import { create } from 'zustand'
import {
  CodexRpc,
  applyNotification,
  applyServerRequest,
  approvalResponse,
  emptyState,
  interruptTurn,
  listThreads,
  loadThread,
  readThread,
  resolveServerRequest,
  resumeThread,
  sendText,
  startThread,
  type ApprovalDecision,
  type ConversationState,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
} from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { call, on } from '../lib/backend'
import { attachResult, BackendCodexTransport, maxSeq, openSeq } from '../lib/codexTransport'
import { describeCodexOpenError, friendlyError } from '../lib/errors'
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

type TargetSession = {
  key: string
  targetId: string
  agent: AgentKind
  rpc: CodexRpc
  transport: BackendCodexTransport
  state: ConversationState
  opened: boolean
  opening: boolean
  openError: string | null
  openFailure: unknown
  agentVersion: string | null
  lastSeq: number | null
  lastTurnId: string | null
}

export type SendOptions = {
  agent?: AgentKind
  targetId?: string
  threadId?: string
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
  openThread: (threadId: string, agent?: AgentKind) => Promise<void>
  send: (text: string, options?: SendOptions) => Promise<void>
  sendSide: (text: string) => Promise<void>
  openSideChat: (quote: string) => Promise<void>
  setSideDraft: (draft: string) => void
  clearSideError: () => void
  closeSideChat: () => void
  interrupt: () => Promise<void>
  interruptSide: () => Promise<void>
  respondApproval: (requestId: RequestId, decision: ApprovalDecision) => void
  clearError: () => void
  clearNotice: () => void
}

let subscribed = false
let offEvents: Array<() => void> = []

export const useCodex = create<CodexState>((set, get) => {
  const opening = new Map<string, Promise<boolean>>()
  const probing = new Map<string, Promise<void>>()
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

  const statusFor = (targetId: string, agent: AgentKind): AgentAvailability | undefined =>
    get().agents[targetId]?.[agent]

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
      opened: false,
      opening: false,
      openError: null,
      openFailure: null,
      agentVersion: null,
      lastSeq: null,
      lastTurnId: null,
    }
    set((state) => ({ sessions: { ...state.sessions, [key]: session } }))

    rpc.onNotification((notification: ServerNotification) => {
      patchSession(key, (current) => ({
        ...current,
        state: applyNotification(current.state, notification),
      }))
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
    if (current?.opened) return true
    const busy = opening.get(key)
    if (busy) return busy

    const session = sessionFor(targetId, agent)
    patchSession(key, (value) => ({ ...value, opening: true, openError: null }))

    const task = (async () => {
      try {
        const opened = await call('server.req', {
          targetId,
          method: 'codex.open',
          params: { agent },
        })
        const version =
          typeof (opened as { agentVersion?: unknown })?.agentVersion === 'string'
            ? ((opened as { agentVersion: string }).agentVersion)
            : null
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
          opening: false,
          openError: null,
          openFailure: null,
          agentVersion: version,
          lastSeq,
        }))
        return true
      } catch (err) {
        const message =
          agent === 'codex'
            ? describeCodexOpenError(err, targetId)
            : friendlyError(err, '打开 Claude 失败')
        patchSession(key, (value) => ({
          ...value,
          opened: false,
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
        if (session?.opened) {
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
        set({ currentAgent: preferredAgent(get().agents[targetId]) })
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
    const turnId = view?.activeTurnId ?? session.lastTurnId
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
          if (payload.state !== 'ready') return
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
      set({
        currentTargetId: targetId,
        currentCwd: cwd,
        currentThreadId: null,
        currentAgent: targetId ? preferredAgent(get().agents[targetId]) : DEFAULT_AGENT,
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
      set({ currentThreadId: threadId, currentAgent: picked, error: null })
      void get().refreshThreads()
    },

    openThread: async (threadId, agent) => {
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
        try {
          result = await resumeThread(session.rpc, threadId)
        } catch {
          result = await readThread(session.rpc, threadId)
        }
        patchSession(key, (value) => ({
          ...value,
          state: loadThread(value.state, result.thread),
        }))
        set({ currentThreadId: threadId, currentAgent: picked, error: null })
      } catch (err) {
        set({ error: friendlyError(err, '打开会话失败') })
      }
    },

    send: async (text, options) => {
      const trimmed = text.trim()
      if (!trimmed || get().sending) return
      const targetId = options?.targetId ?? get().currentTargetId
      if (!targetId) {
        set({ error: '请先选择目标' })
        return
      }
      const agent = options?.agent ?? get().currentAgent
      const key = sessionKey(targetId, agent)
      if (!(await ensureOpen(targetId, agent))) {
        set({ error: get().sessions[key]?.openError ?? `${agentLabel(agent)} 未就绪` })
        return
      }
      const session = get().sessions[key]
      if (!session) return
      set({ sending: true, error: null })
      try {
        let threadId = options?.threadId ?? get().currentThreadId
        if (!threadId) {
          const created = await startThread(
            session.rpc,
            get().currentCwd ? { cwd: get().currentCwd } : {},
          )
          patchSession(key, (value) => ({
            ...value,
            state: loadThread(value.state, created.thread),
          }))
          threadId = created.thread.id
          set({ currentThreadId: threadId, currentAgent: agent })
          void get().refreshThreads()
        }
        const started = await sendText(session.rpc, threadId, trimmed)
        // turn/started 通知可能晚于响应，先按返回值把状态置为运行中，保证中断按钮可用。
        const synthetic = {
          method: 'turn/started',
          params: { threadId, turnId: started.turn.id, turn: started.turn },
        } as unknown as ServerNotification
        patchSession(key, (value) => ({
          ...value,
          lastTurnId: started.turn.id || value.lastTurnId,
          state: applyNotification(value.state, synthetic),
        }))
        set({ sending: false })
      } catch (err) {
        set({ sending: false, error: friendlyError(err, '发送消息失败') })
      }
    },

    sendSide: async (text) => {
      const { sideTargetId, sideAgent, sideThreadId } = get()
      if (!sideTargetId || !sideAgent || !sideThreadId) return
      const value = text.trim()
      if (!value) return
      await get().send(value, {
        targetId: sideTargetId,
        agent: sideAgent,
        threadId: sideThreadId,
      })
      set({ sideDraft: '' })
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

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  }
})
