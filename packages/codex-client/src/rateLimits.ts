// 额度展示的纯逻辑：桌面端与手机端共用，输入允许是线上 JSON 的任意形状。
import { getLocale, t } from '../../protocol/src/i18n'
import type { RateLimitSnapshot, RateLimitWindow } from './codex-types'

export type RateLimitSeverity = 'ok' | 'warn' | 'danger'
export type ClaudeRateLimitSnapshot = RateLimitSnapshot & {
  /** 目标机接受该读数的毫秒时间戳。旧 daemon 不会上报。 */
  observedAt?: number
  /** SDK 拒绝时可能只给重置时间和状态。 */
  rejectionResetsAt?: number
}

export const WARN_PERCENT = 80
export const DANGER_PERCENT = 95

type JsonRecord = Record<string, unknown>
type Credits = NonNullable<RateLimitSnapshot['credits']>
type SpendControl = NonNullable<RateLimitSnapshot['individualLimit']>

export type AccountSummary = {
  type: string
  email: string | null
  planType: string | null
  workspaceName: string | null
}

const SNAPSHOT_KEYS = [
  'limitId',
  'limitName',
  'normalModelSlug',
  'primary',
  'secondary',
  'credits',
  'individualLimit',
  'spendControlReached',
  'planType',
  'rateLimitReachedType',
]

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

// 重置时间约定为秒；部分来源给毫秒，按量级兼容。
function toSeconds(value: unknown): number | null {
  const num = finite(value)
  if (num === null) return null
  return Math.abs(num) > 1e11 ? num / 1000 : num
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(1)))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function emptySnapshot(): RateLimitSnapshot {
  return {
    limitId: null,
    limitName: null,
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  }
}

function mergeWindow(
  base: RateLimitWindow | null,
  value: unknown,
): RateLimitWindow | null {
  const patch = asRecord(value)
  if (!patch) return base
  const usedPercent = finite(patch.usedPercent) ?? base?.usedPercent ?? null
  // 缺少 usedPercent 的稀疏窗口无法独立成立，保留旧值。
  if (usedPercent === null) return base
  return {
    usedPercent,
    windowDurationMins: finite(patch.windowDurationMins) ?? base?.windowDurationMins ?? null,
    resetsAt: toSeconds(patch.resetsAt) ?? base?.resetsAt ?? null,
  }
}

function mergeCredits(base: Credits | null, value: unknown): Credits | null {
  const patch = asRecord(value)
  if (!patch) return base
  const hasCredits = boolean(patch.hasCredits)
  const unlimited = boolean(patch.unlimited)
  const balance = text(patch.balance)
  if (base === null && hasCredits === null && unlimited === null && balance === null) return null
  return {
    hasCredits: hasCredits ?? base?.hasCredits ?? false,
    unlimited: unlimited ?? base?.unlimited ?? false,
    balance: balance ?? base?.balance ?? null,
  }
}

function mergeSpendControl(base: SpendControl | null, value: unknown): SpendControl | null {
  const patch = asRecord(value)
  if (!patch) return base
  const remainingPercent = finite(patch.remainingPercent)
  if (base === null && remainingPercent === null) return null
  return {
    limit: text(patch.limit) ?? base?.limit ?? '',
    used: text(patch.used) ?? base?.used ?? '',
    remainingPercent: remainingPercent ?? base?.remainingPercent ?? 0,
    resetsAt: toSeconds(patch.resetsAt) ?? base?.resetsAt ?? 0,
  }
}

/**
 * 稀疏更新只覆盖非 null 字段：滚动通知里的 null 表示"本次不可用"，不能清掉已读到的值。
 */
export function mergeSnapshot(
  prev: RateLimitSnapshot | null,
  sparse: unknown,
): RateLimitSnapshot | null {
  const patch = asRecord(sparse)
  if (!patch) return prev
  const base = prev ?? emptySnapshot()
  return {
    limitId: text(patch.limitId) ?? base.limitId,
    limitName: text(patch.limitName) ?? base.limitName,
    normalModelSlug: text(patch.normalModelSlug) ?? base.normalModelSlug,
    primary: mergeWindow(base.primary, patch.primary),
    secondary: mergeWindow(base.secondary, patch.secondary),
    credits: mergeCredits(base.credits, patch.credits),
    individualLimit: mergeSpendControl(base.individualLimit, patch.individualLimit),
    spendControlReached: boolean(patch.spendControlReached) ?? base.spendControlReached,
    planType: (text(patch.planType) as RateLimitSnapshot['planType']) ?? base.planType,
    rateLimitReachedType:
      (text(patch.rateLimitReachedType) as RateLimitSnapshot['rateLimitReachedType']) ??
      base.rateLimitReachedType,
  }
}

/** account/rateLimits/read 的响应优先取 codex 计量桶，兼容旧的单桶视图与裸 snapshot。 */
export function pickSnapshot(resp: unknown): RateLimitSnapshot | null {
  const record = asRecord(resp)
  if (!record) return null
  const byId = asRecord(record.rateLimitsByLimitId)
  const source =
    asRecord(byId?.codex) ??
    asRecord(record.rateLimits) ??
    (SNAPSHOT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(record, key)) ? record : null)
  return source === null ? null : mergeSnapshot(null, source)
}

export function isClaudeStatusLine(snapshot: RateLimitSnapshot | null | undefined): boolean {
  return snapshot?.limitId === 'claude-statusline'
}

/** Claude 读取结果与通知都是完整快照，缺失窗口由 daemon 判定。 */
export function pickClaudeSnapshot(message: unknown): ClaudeRateLimitSnapshot | null {
  const record = asRecord(message)
  const payload = record?.method === 'account/rateLimits/updated' ? asRecord(record.params) : record
  const byId = asRecord(payload?.rateLimitsByLimitId)
  const raw = asRecord(byId?.claude) ?? asRecord(payload?.rateLimits)
  const snapshot = mergeSnapshot(null, raw)
  if (!snapshot) return null
  const observedAt = finite(raw?.observedAt)
  const rejectionResetsAt = toSeconds(raw?.rejectionResetsAt)
  return {
    ...snapshot,
    ...(observedAt !== null && observedAt > 0 ? { observedAt } : {}),
    ...(rejectionResetsAt !== null && rejectionResetsAt > 0 ? { rejectionResetsAt } : {}),
  }
}

export function claudeQuotaResetAt(snapshot: ClaudeRateLimitSnapshot | null | undefined): number | null {
  return snapshot?.rejectionResetsAt ?? snapshot?.primary?.resetsAt ?? null
}

export function claudeQuotaBlocked(snapshot: ClaudeRateLimitSnapshot | null | undefined, now = Date.now()): boolean {
  const reset = claudeQuotaResetAt(snapshot)
  return Boolean((snapshot?.rateLimitReachedType || snapshot?.spendControlReached) && (reset === null || reset * 1000 > now))
}

export const CLAUDE_WAITING_FOR_QUOTA = t('等待 Claude CLI 上报')

export function claudeQuotaSummary(snapshot: RateLimitSnapshot | null | undefined): string | null {
  if (snapshot?.rateLimitReachedType || snapshot?.spendControlReached) return t('已达额度上限')
  if (isClaudeStatusLine(snapshot) && (snapshot?.primary || snapshot?.secondary)) return compactText(snapshot, 'remaining')
  const used = snapshot?.primary?.usedPercent
  return used == null ? null : t('上报剩余 {percent}%', { percent: Math.round(remainingQuotaPercent(used)) })
}

export function claudeQuotaSource(snapshot: RateLimitSnapshot | null | undefined): string | null {
  if (claudeQuotaSummary(snapshot) === null) return null
  return isClaudeStatusLine(snapshot) ? t('来源为 Claude CLI 状态栏') : t('来源为 Claude SDK 限额事件')
}

export function claudeQuotaReportedAt(snapshot: ClaudeRateLimitSnapshot | null | undefined): string | null {
  const at = snapshot?.observedAt
  if (at == null) return null
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  return t('上报时间 {time}', { time: `${monthDayText(date)} ${clock}` })
}

/** 从 account/rateLimits/updated 通知中把稀疏更新并入当前快照。 */
export function applyRateLimitsUpdate(
  prev: RateLimitSnapshot | null,
  msg: unknown,
): RateLimitSnapshot | null {
  const record = asRecord(msg)
  if (!record || record.method !== 'account/rateLimits/updated') return prev
  const params = asRecord(record.params)
  return mergeSnapshot(prev, params?.rateLimits ?? record.rateLimits)
}

/** account/read 的账号信息只用于展示，登录态缺失时返回 null。 */
export function pickAccount(resp: unknown): AccountSummary | null {
  const account = asRecord(asRecord(resp)?.account)
  if (!account) return null
  return {
    type: text(account.type) ?? 'unknown',
    email: text(account.email),
    planType: text(account.planType),
    workspaceName: text(account.workspaceName),
  }
}

// 单位短语不进词典：同一单位在各处的英文写法不同，过短的模板还会误匹配 translateMessage。
function durationText(count: string, chinese: string, english: string): string {
  if (getLocale() !== 'en') return `${count} ${chinese}`
  return `${count} ${english}${count === '1' ? '' : 's'}`
}

/** 按窗口时长命名；300 分钟与 10080 分钟沿用 Codex 桌面版的固定叫法。 */
export function windowLabel(mins: number | null | undefined): string {
  const value = finite(mins)
  if (value === null || value <= 0) return t('未知窗口')
  if (value === 300) return t('5 小时')
  if (value === 10080) return t('每周')
  if (value >= 1440 && value % 1440 === 0) return durationText(trimNumber(value / 1440), '天', 'day') // i18n-ignore: 单位见 durationText
  if (value >= 60) return durationText(trimNumber(value / 60), '小时', 'hour') // i18n-ignore: 单位见 durationText
  return durationText(trimNumber(value), '分钟', 'minute') // i18n-ignore: 单位见 durationText
}

/** 徽标里的短名；时长缺省时按主/次窗口的常见含义回退。 */
export function windowShortLabel(
  mins: number | null | undefined,
  fallback = t('额度'),
): string {
  const value = finite(mins)
  if (value === null || value <= 0) return fallback
  if (value === 10080) return t('周')
  if (value >= 1440 && value % 1440 === 0) return `${trimNumber(value / 1440)}d`
  if (value >= 60) return `${trimNumber(value / 60)}h`
  return `${trimNumber(value)}m`
}

export function severityForPercent(percent: number | null | undefined): RateLimitSeverity {
  const value = finite(percent)
  if (value === null) return 'ok'
  if (value >= DANGER_PERCENT) return 'danger'
  if (value >= WARN_PERCENT) return 'warn'
  return 'ok'
}

export function severity(snapshot: RateLimitSnapshot | null | undefined): RateLimitSeverity {
  if (!snapshot) return 'ok'
  // 后端显式上报限额耗尽时优先标红，不能靠百分比推断恢复。
  if (snapshot.rateLimitReachedType || snapshot.spendControlReached === true) return 'danger'
  const levels = [
    severityForPercent(snapshot.primary?.usedPercent),
    severityForPercent(snapshot.secondary?.usedPercent),
  ]
  if (levels.includes('danger')) return 'danger'
  if (levels.includes('warn')) return 'warn'
  return 'ok'
}

/** 目标列表只展示最紧张的一个百分比。 */
export function tightestPercent(snapshot: RateLimitSnapshot | null | undefined): number | null {
  const values = [snapshot?.primary?.usedPercent, snapshot?.secondary?.usedPercent].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  return values.length === 0 ? null : Math.max(...values)
}

export function remainingQuotaPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent))
}

function countdownText(diffSeconds: number): string {
  const en = getLocale() === 'en'
  const second = en ? 's' : ' 秒' // i18n-ignore: 紧凑时长单位
  const minute = en ? 'm' : ' 分' // i18n-ignore: 紧凑时长单位
  const hour = en ? 'h' : ' 小时' // i18n-ignore: 紧凑时长单位
  const day = en ? 'd' : ' 天' // i18n-ignore: 紧凑时长单位
  if (diffSeconds < 60) return `${diffSeconds}${second}`
  const mins = Math.floor(diffSeconds / 60)
  if (diffSeconds < 3600) return `${mins}${minute}`
  const hours = Math.floor(diffSeconds / 3600)
  const restMins = Math.floor((diffSeconds % 3600) / 60)
  if (diffSeconds < 86400) return restMins > 0 ? `${hours}${hour} ${restMins}${minute}` : `${hours}${hour}`
  const days = Math.floor(diffSeconds / 86400)
  const restHours = Math.floor((diffSeconds % 86400) / 3600)
  return restHours > 0 ? `${days}${day} ${restHours}${hour}` : `${days}${day}`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayText(target: Date, now: Date): string {
  // 按日历日比较而非 24 小时，跨过午夜仍应显示"明天"。
  const days = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000)
  if (days === 0) return t('今天')
  if (days === 1) return t('明天')
  if (days === -1) return t('昨天')
  return monthDayText(target)
}

function monthDayText(date: Date): string {
  if (getLocale() === 'en') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${date.getMonth() + 1}月${date.getDate()}日` // i18n-ignore: 中文日期格式
}

/** resetsAt 为秒级时间戳；now 允许毫秒或秒，便于界面直接传 Date.now()。 */
export function formatReset(resetsAt: number | null | undefined, now: number): string {
  const target = toSeconds(resetsAt)
  const current = toSeconds(now)
  if (target === null || current === null) return t('重置时间未知')
  const targetDate = new Date(target * 1000)
  const nowDate = new Date(current * 1000)
  if (Number.isNaN(targetDate.getTime()) || Number.isNaN(nowDate.getTime())) return t('重置时间未知')
  const clock = `${pad2(targetDate.getHours())}:${pad2(targetDate.getMinutes())}`
  const when = `${dayText(targetDate, nowDate)} ${clock}`
  const diff = Math.round(target - current)
  if (diff <= 0) return t('重置时间已过（{when}）', { when })
  return t('{countdown}后重置（{when}）', { countdown: countdownText(diff), when })
}

export function compactText(
  snapshot: RateLimitSnapshot | null | undefined,
  mode: 'used' | 'remaining' = 'used',
): string {
  if (!snapshot) return t('暂无额度数据')
  const displayPercent = mode === 'remaining' ? remainingQuotaPercent : (used: number) => used
  const parts: string[] = []
  const primary = snapshot.primary
  const secondary = snapshot.secondary
  if (primary) {
    parts.push(
      `${windowShortLabel(primary.windowDurationMins, '5h')} ${Math.round(displayPercent(primary.usedPercent))}%`,
    )
  }
  if (secondary) {
    parts.push(
      `${windowShortLabel(secondary.windowDurationMins, t('周'))} ${Math.round(displayPercent(secondary.usedPercent))}%`,
    )
  }
  if (parts.length === 0) return t('暂无额度数据')
  const text = parts.join(' · ')
  return mode === 'remaining' ? t('剩余 {text}', { text }) : text
}
