import {
  remainingQuotaPercent,
  severity,
  tightestPercent,
  type RateLimitSeverity,
} from '@qn/codex-client'
import { parseSessionKey } from '../lib/agents'
import { useRateLimits } from '../store/rateLimits'

function hintClass(level: RateLimitSeverity): string {
  if (level === 'danger') return 'text-qn-danger'
  if (level === 'warn') return 'text-amber-300'
  return 'text-qn-muted'
}

export function RateLimitHint({ targetId }: { targetId: string }) {
  const byTarget = useRateLimits((s) => s.byTarget)
  const byAgent = useRateLimits((s) => s.byAgent)
  const entries = [
    ...(byTarget[targetId] ? [byTarget[targetId]] : []),
    ...Object.entries(byAgent)
      .filter(([key]) => parseSessionKey(key).targetId === targetId)
      .map(([, value]) => value),
  ]
  const percents = entries
    .map((entry) => tightestPercent(entry.snapshot))
    .filter((value): value is number => value !== null)
  if (percents.length === 0) return null
  const level = entries.reduce<RateLimitSeverity>((worst, entry) => {
    const current = severity(entry.snapshot)
    if (worst === 'danger' || current === 'danger') return 'danger'
    if (worst === 'warn' || current === 'warn') return 'warn'
    return 'ok'
  }, 'ok')
  const remaining = remainingQuotaPercent(Math.max(...percents))
  return (
    <span className={hintClass(level)} title="所有 Agent 中剩余额度最低的窗口">
      {' · 剩余 '}
      {Math.round(remaining)}%
    </span>
  )
}
