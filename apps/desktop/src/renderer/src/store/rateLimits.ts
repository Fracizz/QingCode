import { create } from 'zustand'
import {
  applyRateLimitsUpdate,
  pickAccount,
  pickSnapshot,
  type AccountSummary,
  type RateLimitSnapshot,
} from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { on } from '../lib/backend'
import { sessionsOf, sessionScope, type RpcLike } from '../lib/codexSessions'
import { friendlyError } from '../lib/errors'
import { notificationKind } from '../lib/rateLimitView'
import { costFromNotification } from '../lib/claudeUsage'
import { DEFAULT_AGENT, exitedAgentOf, parseSessionKey, sessionKey } from '../lib/agents'
import { useCodex } from './codex'

export type TargetRateLimits = {
  snapshot: RateLimitSnapshot | null
  account: AccountSummary | null
  updatedAt: number | null
  loading: boolean
  error: string | null
  /** Claude 桥的估算费用按会话累计，仅用于展示。 */
  costByThread: Record<string, number>
}

type RateLimitsState = {
  /** T13 的目标列表行内提示继续读取这里（Codex）。 */
  byTarget: Record<string, TargetRateLimits>
  /** 每个目标 × agent 各自一份，键与 codex store 的会话键一致。 */
  byAgent: Record<string, TargetRateLimits>
  activeTargetId: string | null
  init: () => () => void
  setActiveTarget: (targetId: string | null) => void
  refresh: (targetId: string, agent?: AgentKind) => Promise<void>
  handleNotification: (targetId: string, agent: AgentKind, msg: unknown) => void
  reset: (targetId: string, agent?: AgentKind) => void
}

function emptyTarget(): TargetRateLimits {
  return {
    snapshot: null,
    account: null,
    updatedAt: null,
    loading: false,
    error: null,
    costByThread: {},
  }
}

export const RATE_LIMIT_REFRESH_MINUTES = 5
let subscribed = false

export const useRateLimits = create<RateLimitsState>((set, get) => {
  const inFlight = new Map<string, Promise<void>>()

  const patch = (
    targetId: string,
    agent: AgentKind,
    changes: Partial<TargetRateLimits>,
  ): void => {
    set((state) => {
      const key = sessionKey(targetId, agent)
      const prev =
        state.byAgent[key] ??
        (agent === DEFAULT_AGENT ? state.byTarget[targetId] : undefined) ??
        emptyTarget()
      const next: TargetRateLimits = { ...prev, ...changes }
      return {
        byAgent: { ...state.byAgent, [key]: next },
        byTarget:
          agent === DEFAULT_AGENT
            ? { ...state.byTarget, [targetId]: next }
            : state.byTarget,
      }
    })
  }

  const refresh = async (targetId: string, agent: AgentKind = DEFAULT_AGENT): Promise<void> => {
    // pi 没有额度接口（capabilities.rateLimits=false），不去请求不存在的 account/* 方法。
    if (agent === 'pi') return
    const key = sessionKey(targetId, agent)
    const busy = inFlight.get(key)
    if (busy) return busy
    const session = useCodex.getState().sessions[key]
    if (!session?.opened) return

    patch(targetId, agent, { loading: true })
    const task = (async () => {
      try {
        // 账号读取失败不应挡住额度显示，两个请求彼此独立；Claude 只返回最近一次限额事件缓存。
        const [limits, account] = await Promise.allSettled([
          session.rpc.request('account/rateLimits/read', {}),
          session.rpc.request('account/read', {}),
        ])
        const snapshot = limits.status === 'fulfilled' ? pickSnapshot(limits.value) : null
        const accountInfo = account.status === 'fulfilled' ? pickAccount(account.value) : null
        const error =
          limits.status === 'rejected'
            ? friendlyError(limits.reason, '读取额度失败')
            : account.status === 'rejected' && snapshot === null
              ? friendlyError(account.reason, '读取账号失败')
              : null
        const changes: Partial<TargetRateLimits> = { loading: false, error }
        if (snapshot) changes.snapshot = snapshot
        if (accountInfo) changes.account = accountInfo
        if (snapshot || accountInfo) changes.updatedAt = Date.now()
        patch(targetId, agent, changes)
      } catch (err) {
        patch(targetId, agent, { loading: false, error: friendlyError(err, '读取额度失败') })
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, task)
    return task
  }

  return {
    byTarget: {},
    byAgent: {},
    activeTargetId: null,

    init: () => {
      if (subscribed) return () => undefined
      subscribed = true

      const listeners = new Map<string, { rpc: RpcLike; off: () => void }>()
      const syncSessions = (state: unknown, prev: unknown): void => {
        const current = sessionsOf(state)
        const before = sessionsOf(prev)
        for (const [key, session] of Object.entries(current)) {
          const { targetId, agent } = sessionScope(key)
          const registered = listeners.get(key)
          if (!registered || registered.rpc !== session.rpc) {
            registered?.off()
            listeners.set(key, {
              rpc: session.rpc,
              off: session.rpc.onNotification((msg) =>
                get().handleNotification(targetId, agent, msg),
              ),
            })
          }
          // codex.open 成功后立即读取，进程退出后清掉过期数据。
          if (session.opened && before[key]?.opened !== true) {
            void get().refresh(targetId, agent)
          }
          if (!session.opened && before[key]?.opened === true) get().reset(targetId, agent)
        }
        for (const key of [...listeners.keys()]) {
          if (!current[key]) {
            listeners.get(key)?.off()
            listeners.delete(key)
          }
        }
      }

      const unsubscribe = useCodex.subscribe((state, prev) => syncSessions(state, prev))
      syncSessions(useCodex.getState(), { sessions: {} })

      const refreshVisible = (): void => {
        for (const [key, session] of Object.entries(sessionsOf(useCodex.getState()))) {
          if (!session.opened) continue
          const { targetId, agent } = sessionScope(key)
          void get().refresh(targetId, agent)
        }
      }
      const isVisible = (): boolean =>
        typeof document === 'undefined' || document.visibilityState !== 'hidden'
      const onVisible = (): void => {
        if (isVisible()) refreshVisible()
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onVisible)
      }
      const timer = setInterval(() => {
        if (isVisible()) refreshVisible()
      }, RATE_LIMIT_REFRESH_MINUTES * 60_000)

      const offTargetState = on('target.state', (payload) => {
        if (payload.state === 'ready' && get().activeTargetId === payload.id) {
          for (const agent of ['codex', 'claude'] as const) void get().refresh(payload.id, agent)
        }
      })
      const offServerEvt = on('server.evt', (payload) => {
        const agent = exitedAgentOf(payload.name, payload.payload)
        if (agent) get().reset(payload.targetId, agent)
      })

      return () => {
        unsubscribe()
        for (const listener of listeners.values()) listener.off()
        listeners.clear()
        clearInterval(timer)
        offTargetState()
        offServerEvt()
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', onVisible)
        }
        subscribed = false
      }
    },

    setActiveTarget: (targetId) => {
      set({ activeTargetId: targetId })
      if (targetId) {
        for (const agent of ['codex', 'claude'] as const) void get().refresh(targetId, agent)
      }
    },

    refresh,

    handleNotification: (targetId, agent, msg) => {
      if (agent === 'pi') return
      const kind = notificationKind(msg)
      if (kind === 'updated') {
        const key = sessionKey(targetId, agent)
        const prev =
          get().byAgent[key]?.snapshot ??
          (agent === DEFAULT_AGENT ? get().byTarget[targetId]?.snapshot : null) ??
          null
        patch(targetId, agent, {
          snapshot: applyRateLimitsUpdate(prev, msg),
          updatedAt: Date.now(),
          error: null,
        })
        return
      }
      if (kind === 'tokenUsage') {
        const cost = costFromNotification(msg)
        if (!cost) return
        const key = sessionKey(targetId, agent)
        const costs = get().byAgent[key]?.costByThread ?? {}
        patch(targetId, agent, {
          costByThread: {
            ...costs,
            [cost.threadId]: (costs[cost.threadId] ?? 0) + cost.usd,
          },
          updatedAt: Date.now(),
        })
        return
      }
      // turn 完成后服务端额度可能刚变化，主动重新读一次。
      if (kind === 'turnCompleted') void get().refresh(targetId, agent)
    },

    reset: (targetId, agent) => {
      const keys = Object.keys(get().byAgent).filter((key) => {
        const scope = parseSessionKey(key)
        return scope.targetId === targetId && (!agent || scope.agent === agent)
      })
      for (const key of keys) inFlight.delete(key)
      set((state) => {
        const byAgent = { ...state.byAgent }
        for (const key of keys) delete byAgent[key]
        const byTarget =
          agent === undefined || agent === DEFAULT_AGENT
            ? { ...state.byTarget, [targetId]: emptyTarget() }
            : state.byTarget
        return { byAgent, byTarget }
      })
    },
  }
})
