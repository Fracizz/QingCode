import type { ClaudeRateLimitSnapshot, AccountSummary, ResetCreditNotice, ResetCredits } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { DEFAULT_AGENT, sessionKey } from './agents'

export type RateLimitEntry = {
  snapshot: ClaudeRateLimitSnapshot | null
  account: AccountSummary | null
  updatedAt: number | null
  loading: boolean
  error: string | null
  costByThread: Record<string, number>
  /** 仅 Codex：重置卡与最近一次兑换结果。 */
  resetCredits?: ResetCredits | null
  resetting?: boolean
  resetNotice?: ResetCreditNotice | null
}

/** byTarget 是 T13 的 Codex 入口；多 agent 数据统一按会话键存在 byAgent。 */
export function entryFor(
  byTarget: Readonly<Record<string, RateLimitEntry>>,
  byAgent: Readonly<Record<string, RateLimitEntry>>,
  targetId: string | null,
  agent: AgentKind,
): RateLimitEntry | undefined {
  if (!targetId) return undefined
  const key = sessionKey(targetId, agent)
  if (agent === DEFAULT_AGENT) return byTarget[targetId] ?? byAgent[key]
  return byAgent[key]
}
