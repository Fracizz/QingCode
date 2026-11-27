import { getLocale, t, type RateLimitSeverity } from '@qn/codex-client'

export type RateLimitNotificationKind = 'updated' | 'turnCompleted' | 'tokenUsage' | null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 额度 store 只关心两种通知，其余交给对话 reducer。 */
export function notificationKind(msg: unknown): RateLimitNotificationKind {
  if (!isRecord(msg)) return null
  if (msg.method === 'account/rateLimits/updated') return 'updated'
  if (msg.method === 'thread/tokenUsage/updated') return 'tokenUsage'
  if (msg.method === 'turn/completed') return 'turnCompleted'
  return null
}

export function severityTextClass(level: RateLimitSeverity): string {
  if (level === 'danger') return 'border-qn-border-strong text-qn-danger'
  if (level === 'warn') return 'border-qn-border-strong text-amber-300'
  return 'border-qn-border text-qn-muted'
}

export function severityBarClass(level: RateLimitSeverity): string {
  if (level === 'danger') return 'bg-qn-danger'
  if (level === 'warn') return 'bg-amber-400'
  return 'bg-qn-accent'
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function updatedAtText(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return t('尚未更新')
  const date = new Date(ts)
  const nowDate = new Date(now)
  if (Number.isNaN(date.getTime()) || Number.isNaN(nowDate.getTime())) return t('尚未更新')
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  const sameDay =
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate()
  if (sameDay) return t('最后更新 {time}', { time: clock })
  const day = getLocale() === 'en'
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : `${date.getMonth() + 1}月${date.getDate()}日` // i18n-ignore: 中文日期格式
  return t('最后更新 {time}', { time: `${day} ${clock}` })
}
