import type { InfoTipDetails } from '../infoTip'

/** `shell_prewarm_status` 返回的单个预热池状态。 */
export interface PrewarmPoolStatus {
  target?: number
  ready?: number
  preparing?: number
  reserved?: number
  reason?: string | null
}

/** 普通 Shell 池状态，设了 CLI 预热时附带 `profile`（CLI 池）。 */
export interface PrewarmStatus extends PrewarmPoolStatus {
  profile?: PrewarmPoolStatus
}

/** 最近新建终端的领取情况，见 `recentShellOpenCounts`。 */
export interface PrewarmRecent {
  hit: number
  miss: number
  missReasons: Record<string, number>
}

export interface PrewarmBadge {
  pool: 'cli' | 'shell'
  ready: number
  target: number
  /** full：已补满；filling：补充中；paused：有暂停原因。 */
  tone: 'full' | 'filling' | 'paused'
  reason: string | null
}

type Translate = (key: string, params?: Record<string, string | number>) => string

const target = (pool?: PrewarmPoolStatus) => Math.max(0, pool?.target ?? 0)

export function hasPrewarmTarget(status: PrewarmStatus | null | undefined): boolean {
  return !!status && (target(status) > 0 || target(status.profile) > 0)
}

function poolBadge(pool: PrewarmPoolStatus | undefined, kind: PrewarmBadge['pool']): PrewarmBadge | null {
  const goal = target(pool)
  if (!pool || goal === 0) return null
  const ready = Math.max(0, pool.ready ?? 0)
  const reason = pool.reason ?? null
  return { pool: kind, ready, target: goal, tone: reason ? 'paused' : ready >= goal ? 'full' : 'filling', reason }
}

/**
 * 主机分组标题上的预热徽标：普通 Shell 池与 CLI 池各一枚（先 Shell 后 CLI），各自按就绪/暂停着色；
 * 目标为 0（预热关闭、未受信任、不支持的主机等）的池不显示。
 */
export function prewarmBadges(status: PrewarmStatus | null | undefined): PrewarmBadge[] {
  if (!status) return []
  return [poolBadge(status, 'shell'), poolBadge(status.profile, 'cli')].filter((b): b is PrewarmBadge => !!b)
}

const TONE_RANK: Record<PrewarmBadge['tone'], number> = { full: 0, filling: 1, paused: 2 }

/** 两个池合起来的状态：任一暂停即暂停，任一补充中即补充中。 */
function overallTone(badges: PrewarmBadge[]): PrewarmBadge['tone'] | null {
  if (badges.length === 0) return null
  return badges.reduce((worst, b) => (TONE_RANK[b.tone] > TONE_RANK[worst] ? b.tone : worst), badges[0].tone)
}

function poolSummary(pool: PrewarmPoolStatus, translate: Translate): string {
  const parts = [translate('就绪 {ready}/{target}', { ready: pool.ready ?? 0, target: target(pool) })]
  if (pool.preparing) parts.push(translate('准备中'))
  if (pool.reserved) parts.push(translate('已预留 {count}', { count: pool.reserved }))
  if (pool.reason) parts.push(translate('暂停：{reason}', { reason: pool.reason }))
  return parts.join(' · ')
}

/** 徽标悬停详情：两个池各自的就绪、准备中、预留与暂停原因，以及最近的领取情况。 */
export function prewarmBadgeDetails(
  status: PrewarmStatus,
  recent: PrewarmRecent | null,
  translate: Translate,
): InfoTipDetails {
  const tone = overallTone(prewarmBadges(status))
  const rows: { label: string; value: string; mono?: boolean }[] = []
  if (target(status) > 0) rows.push({ label: translate('Shell 预热'), value: poolSummary(status, translate) })
  if (status.profile && target(status.profile) > 0) {
    rows.push({ label: translate('CLI 预热'), value: poolSummary(status.profile, translate) })
  }
  if (recent && recent.hit + recent.miss > 0) {
    const reasons = Object.entries(recent.missReasons).map(([reason, count]) => `${reason}×${count}`).join(', ')
    rows.push({
      label: translate('最近新建'),
      value: translate('命中 {hit} · 未命中 {miss}', { hit: recent.hit, miss: recent.miss }) + (reasons ? `（${reasons}）` : ''),
    })
  }
  rows.push({ label: translate('操作'), value: translate('双击重新触发预热') })
  const status_ = tone && {
    full: { text: translate('已就绪'), tone: 'ok' as const },
    filling: { text: translate('补充中'), tone: 'muted' as const },
    paused: { text: translate('已暂停'), tone: 'warn' as const },
  }[tone]
  return { title: translate('终端预热'), ...(status_ && { status: status_ }), rows }
}
