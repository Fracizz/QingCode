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

/** 传入 threadId 时只统计本会话；否则汇总目标上的所有会话。 */
export function sumCost(
  costByThread: Readonly<Record<string, number>> | undefined,
  threadId?: string | null,
): number {
  if (!costByThread) return 0
  const values =
    threadId === undefined || threadId === null
      ? Object.values(costByThread)
      : [costByThread[threadId] ?? 0]
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return `$${Number(usd.toFixed(4))}`
  if (usd < 1) return `$${Number(usd.toFixed(3))}`
  return `$${Number(usd.toFixed(2))}`
}

export function claudeRateLimitStatus(snapshot: RateLimitSnapshot | null): string {
  return claudeQuotaSummary(snapshot) ?? CLAUDE_WAITING_FOR_QUOTA
}

export function claudeCompactText(snapshot: RateLimitSnapshot | null, costUsd: number): string {
  const limit = claudeRateLimitStatus(snapshot)
  const cost = costUsd > 0 ? `≈${formatCost(costUsd)}（估算）` : ''
  return cost ? `${limit} · ${cost}` : limit
}
