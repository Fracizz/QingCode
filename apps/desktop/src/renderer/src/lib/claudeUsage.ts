import { CLAUDE_WAITING_FOR_QUOTA, claudeQuotaSummary, type RateLimitSnapshot } from '@qn/codex-client'

export type ClaudeCostEvent = { threadId: string; usd: number; estimated: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Claude 桥把 SDK 的 total_cost_usd 作为估算值放在 tokenUsage 通知里。 */
export function costFromNotification(msg: unknown): ClaudeCostEvent | null {
  const record = asRecord(msg)
  if (record?.method !== 'thread/tokenUsage/updated') return null
  const params = asRecord(record.params)
  const threadId = text(params?.threadId)
  const usage = asRecord(params?.tokenUsage)
  const usd = finite(usage?.estimatedCostUsd)
  if (!threadId || usd === null || usd < 0) return null
  return { threadId, usd, estimated: usage?.estimated !== false }
}

export function claudeRateLimitStatus(snapshot: RateLimitSnapshot | null): string {
  return claudeQuotaSummary(snapshot) ?? CLAUDE_WAITING_FOR_QUOTA
}
