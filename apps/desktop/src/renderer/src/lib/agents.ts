import type { AgentKind } from '../../../shared/backendApi'

export const AGENTS: readonly AgentKind[] = ['codex', 'claude', 'pi'] as const
export const DEFAULT_AGENT: AgentKind = 'codex'

export function isAgentKind(value: unknown): value is AgentKind {
  return value === 'codex' || value === 'claude' || value === 'pi'
}

/** 一个目标上的每个 agent 使用独立的 key；目标 id 本身允许包含冒号。 */
export function sessionKey(targetId: string, agent: AgentKind): string {
  return `${agent}:${targetId}`
}

export function parseSessionKey(key: string): { targetId: string; agent: AgentKind } {
  for (const agent of AGENTS) {
    const prefix = `${agent}:`
    if (key.startsWith(prefix)) return { agent, targetId: key.slice(prefix.length) }
  }
  // 兼容 T6 时代按目标存放的会话形状。
  return { agent: DEFAULT_AGENT, targetId: key }
}

export function agentLabel(agent: AgentKind): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'pi') return 'pi'
  return 'Codex'
}

export function agentPlaceholder(agent: AgentKind): string {
  return `和 ${agentLabel(agent)} 一起工作`
}

export type AgentAvailabilityState = 'unknown' | 'checking' | 'ready' | 'unavailable' | 'error'

export type AgentAvailability = {
  state: AgentAvailabilityState
  detail?: string
  version?: string
}

export function emptyAgentStatus(): Record<AgentKind, AgentAvailability> {
  return {
    codex: { state: 'unknown' },
    claude: { state: 'unknown' },
    pi: { state: 'unknown' },
  }
}

function rawMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : ''
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * 只有"目标机上确实没有这个 agent"才置灰；连接未就绪属于暂时状态，不能把 Agent 永久隐藏。
 */
export function classifyAgentOpenError(agent: AgentKind, err: unknown): AgentAvailability {
  const raw = rawMessage(err)
  const code = errorCode(err)
  const missing =
    code === 'agent_unavailable' ||
    /未找到|未安装|未登录|not found|ENOENT|spawn|login/i.test(raw)
  if (missing) {
    return {
      state: 'unavailable',
      detail: raw || `未找到 ${agent}`,
    }
  }
  if (code === 'not_connected' || /未连接|连接中|deploying|connecting/i.test(raw)) {
    return { state: 'unknown', detail: raw || '目标尚未连接' }
  }
  return { state: 'error', detail: raw || '打开失败' }
}

/** `chosen` 是用户为该连接指定的默认 Agent：只要没有确认它不可用就用它。 */
export function preferredAgent(
  statuses: Partial<Record<AgentKind, AgentAvailability>> | undefined,
  chosen?: AgentKind,
): AgentKind {
  if (chosen && statuses?.[chosen]?.state !== 'unavailable') return chosen
  if (statuses) {
    for (const agent of AGENTS) if (statuses[agent]?.state === 'ready') return agent
    for (const agent of AGENTS) if (statuses[agent]?.state !== 'unavailable') return agent
  }
  return DEFAULT_AGENT
}

/** 解析本地保存的"连接 → 默认 Agent"；损坏或未知的条目直接丢弃。 */
export function parseDefaultAgents(raw: string | null): Record<string, AgentKind> {
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, AgentKind> = {}
  for (const [targetId, agent] of Object.entries(value)) {
    if (isAgentKind(agent)) result[targetId] = agent
  }
  return result
}

export function availabilityReason(agent: AgentKind, status: AgentAvailability | undefined): string {
  const state = status?.state ?? 'unknown'
  if (state === 'ready') return status?.version ? `已就绪 · ${status.version}` : '已就绪'
  if (state === 'checking') return '检测中…'
  if (state === 'unavailable') return status?.detail ?? `未找到 ${agent}`
  if (state === 'error') return status?.detail ?? '打开失败'
  return '等待连接后检测'
}
