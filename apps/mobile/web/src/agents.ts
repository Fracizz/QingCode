// 多 Agent 纯逻辑：会话键、事件路由、启用状态、会话列表合并。思路移植自桌面 lib/agents.ts，不跨包 import。
import { isGlobalAccessMode, type GlobalAccessMode } from '@qn/codex-client'
import type { ThreadSummary } from './state'
import type { AgentKind } from './types'

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const AGENTS: readonly AgentKind[] = ['codex', 'claude', 'pi'] as const
export const DEFAULT_AGENT: AgentKind = 'codex'

export function isAgentKind(value: unknown): value is AgentKind {
  return value === 'codex' || value === 'claude' || value === 'pi'
}

/** 与桌面一致：agent 在前，目标 id 本身允许包含冒号。 */
export function sessionKey(targetId: string, agent: AgentKind): string {
  return `${agent}:${targetId}`
}

export function agentLabel(agent: AgentKind): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'pi') return 'pi'
  return 'Codex'
}

export function agentPlaceholder(agent: AgentKind): string {
  return `和 ${agentLabel(agent)} 一起工作`
}

/** 旧 server / 旧桌面的 codex.recv 不带 agent，按 Codex 处理。 */
export function recvAgent(payload: unknown): AgentKind {
  const value = isRecord(payload) ? payload.agent : undefined
  return isAgentKind(value) ? value : DEFAULT_AGENT
}

/** codex.recv 事件应投递到的会话键；缺 targetId 的帧丢弃。 */
export function recvSessionKey(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.targetId !== 'string' || !payload.targetId) return null
  return sessionKey(payload.targetId, recvAgent(payload))
}

/** server.evt codex.exited 影响的 agent；缺省表示该目标的全部 agent（旧 server）。 */
export function exitedAgent(payload: unknown): AgentKind | null {
  const inner = isRecord(payload) && isRecord(payload.payload) ? payload.payload : null
  return isAgentKind(inner?.agent) ? inner.agent : null
}

/** 网关 mobile.agents 的裁剪结果；只含启用状态，不含路径。 */
export type MobileAgentSettings = {
  defaultAgent: AgentKind
  fastHistoryOpen?: true
  globalAccessMode?: GlobalAccessMode
  agents: Record<string, Partial<Record<AgentKind, { enabled: boolean }>>>
}

export function parseMobileAgents(value: unknown): MobileAgentSettings | null {
  if (!isRecord(value)) return null
  const agents: MobileAgentSettings['agents'] = {}
  const raw = isRecord(value.agents) ? value.agents : {}
  for (const [targetId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue
    const prefs: Partial<Record<AgentKind, { enabled: boolean }>> = {}
    for (const agent of AGENTS) {
      const item = entry[agent]
      if (isRecord(item) && typeof item.enabled === 'boolean') prefs[agent] = { enabled: item.enabled }
    }
    agents[targetId] = prefs
  }
  return {
    defaultAgent: isAgentKind(value.defaultAgent) ? value.defaultAgent : DEFAULT_AGENT,
    ...(value.fastHistoryOpen === true ? { fastHistoryOpen: true } : {}),
    ...(isGlobalAccessMode(value.globalAccessMode) ? { globalAccessMode: value.globalAccessMode } : {}),
    agents,
  }
}

/**
 * 某目标上启用的 Agent。拿不到设置（旧桌面版本）时只给 Codex；
 * 设置里没写过的 Agent 视为启用（与桌面 agentPrefs 默认一致）。
 */
export function enabledAgents(settings: MobileAgentSettings | null, targetId: string): AgentKind[] {
  if (!settings) return [DEFAULT_AGENT]
  const prefs = settings.agents[targetId] ?? {}
  return AGENTS.filter((agent) => prefs[agent]?.enabled !== false)
}

/** 新建会话默认 Agent：桌面设置的 defaultAgent，不可用时退回第一个可用的。 */
export function pickDefaultAgent(
  preferred: AgentKind | null | undefined,
  candidates: readonly AgentKind[],
  unavailable: ReadonlySet<AgentKind> = new Set(),
): AgentKind {
  const usable = candidates.filter((agent) => !unavailable.has(agent))
  if (preferred && usable.includes(preferred)) return preferred
  return usable[0] ?? candidates[0] ?? DEFAULT_AGENT
}

/** 各 Agent 会话按更新时间降序合并；同时间按 Agent 名排序保证稳定。 */
export function mergeThreadSummaries(lists: readonly ThreadSummary[][]): ThreadSummary[] {
  return lists
    .flat()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || a.agent.localeCompare(b.agent))
}

/** 不同 Agent 的会话 id 各自独立，列表 key 必须带 agent。 */
export function threadKey(agent: AgentKind, id: string): string {
  return `${agent}:${id}`
}

export function archivedThreadKey(desktopId: string, targetId: string, thread: Pick<ThreadSummary, 'agent' | 'id'>): string {
  return JSON.stringify([desktopId, targetId, thread.agent, thread.id])
}
