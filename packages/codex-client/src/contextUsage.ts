export type ContextUsage = { percent: number; used: number; window: number }

/** 缺少本轮 token 数或上下文窗口时无法估计占用。 */
export function contextUsage(value: unknown): ContextUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as { modelContextWindow?: unknown; last?: { totalTokens?: unknown } }
  const window = usage.modelContextWindow
  const used = usage.last?.totalTokens
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0
    || typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  return { used, window, percent: Math.min(100, Math.round((used / window) * 100)) }
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`
  return String(value)
}
