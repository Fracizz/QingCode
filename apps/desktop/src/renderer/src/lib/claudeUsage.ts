import { t, type RateLimitSnapshot } from '@qn/codex-client'

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

export const CLAUDE_RATE_LIMIT_NOTE = t('Claude 只在接近/触发限额时上报')

export function claudeRateLimitStatus(snapshot: RateLimitSnapshot | null): string {
  if (snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true) return t('已达额度上限')
  const percent = snapshot?.primary?.usedPercent
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    return t('利用率 {percent}%（本次限额事件）', { percent: Math.round(percent) })
  }
  return t('暂无限额事件')
}

export function claudeCompactText(snapshot: RateLimitSnapshot | null, costUsd: number): string {
  const percent = snapshot?.primary?.usedPercent
  const limit =
    snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true
      ? t('已达上限')
      : typeof percent === 'number' && Number.isFinite(percent)
        ? t('限额 {percent}%', { percent: Math.round(percent) })
        : t('暂无限额事件')
  const cost = costUsd > 0 ? t('≈{cost}（估算）', { cost: formatCost(costUsd) }) : ''
  return cost ? `${limit} · ${cost}` : limit
}
