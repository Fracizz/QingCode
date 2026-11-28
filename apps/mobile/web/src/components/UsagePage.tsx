import {
  CLAUDE_WAITING_FOR_QUOTA,
  claudeHasWindows,
  claudeQuotaReportedAt,
  claudeQuotaResetAt,
  claudeQuotaSource,
  claudeQuotaSummary,
  formatReset,
  formatTokens,
  getLocale,
  recentUsageDays,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  sumUsageTokens,
  t,
  tightestPercent,
  translateMessage,
  windowLabel,
  type AccountUsage,
  type ClaudeRateLimitSnapshot,
  type RateLimitSeverity,
  type RateLimitSnapshot,
  type RateLimitWindow,
} from '@qn/codex-client'
import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { agentLabel, enabledAgents, sessionKey } from '../agents'
import { formatAddress } from '../link'
import { pageName } from '../names'
import { useApp } from '../store'
import type { Target, TargetState } from '../types'
import { registerBackHandler } from '../workspace'
import { PullToRefresh } from './PullToRefresh'
import { AgentTag, Button, Empty, Header, Loading, Note, StatusDot } from './ui'

type QuotaAgent = 'codex' | 'claude'

/** 与 Agent 适配规范「刷新频率」一致：界面可见时额度最多 60 秒读一次。 */
const RATE_REFRESH_MIN_MS = 60_000
/** 切换页面与下拉刷新的防抖间隔。 */
const REFRESH_DEBOUNCE_MS = 5_000
const USAGE_DAYS = 7

const refreshedAt = new Map<string, number>()

/** 间隔内的重复触发直接忽略；切页自动刷新与下拉刷新用不同的键，互不吞掉。 */
async function debounced(key: string, run: () => Promise<void>): Promise<void> {
  const now = Date.now()
  const last = refreshedAt.get(key)
  if (last !== undefined && now - last < REFRESH_DEBOUNCE_MS) return
  refreshedAt.set(key, now)
  await run()
}

/**
 * 读取一台主机已打开会话的额度，不为此启动 Agent（适配规范 R9）。
 * 自动刷新时 Codex 额度距上次读取不足 60 秒就跳过；返回 Claude 是否读取失败。
 */
async function readQuota(targetId: string, manual: boolean): Promise<boolean> {
  const app = useApp.getState()
  const agents = quotaAgents(enabledAgents(app.agentSettings, targetId))
  const opened = (agent: QuotaAgent) => agents.includes(agent) && app.sessions[sessionKey(targetId, agent)]?.opened === true
  const tasks: Promise<void>[] = []
  if (opened('codex')) {
    const last = app.rateLimits[targetId]?.updatedAt
    if (manual || last == null || Date.now() - last >= RATE_REFRESH_MIN_MS) tasks.push(app.refreshRateLimits(targetId))
    tasks.push(app.refreshAccountUsage(targetId))
  }
  const claude = opened('claude') ? app.refreshClaudeRateLimits(targetId) : null
  const [claudeOk] = await Promise.all([claude, ...tasks])
  return claudeOk === false
}

async function refreshHosts(manual: boolean): Promise<void> {
  const app = useApp.getState()
  await Promise.all([app.loadTargets(), app.loadAgentSettings()])
  const state = useApp.getState()
  await Promise.all(state.targets.filter((target) => targetAvailable(state, target))
    .map((target) => readQuota(target.id, manual)))
}

const toneText: Record<RateLimitSeverity, string> = {
  ok: 'text-qn-muted',
  warn: 'text-qn-warn',
  danger: 'text-qn-danger',
}
const barColor: Record<RateLimitSeverity, string> = {
  ok: 'var(--color-qn-accent)',
  warn: 'var(--color-qn-warn)',
  danger: 'var(--color-qn-danger)',
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** 目标是否可读额度：与「目标与额度」页的判断保持一致。 */
function targetAvailable(app: ReturnType<typeof useApp.getState>, target: Target): boolean {
  const state: TargetState = app.targetStates[target.id]?.state ?? 'idle'
  const repair = app.activeId ? app.needsRepair[app.activeId] : undefined
  const canOpen = target.kind === 'local' || state === 'ready'
  return app.eventsConnected && !repair && canOpen && state !== 'connecting' && state !== 'deploying'
}

function useTargetAvailability(target: Target) {
  const state: TargetState = useApp((s) => s.targetStates[target.id]?.state ?? 'idle')
  const eventsConnected = useApp((s) => s.eventsConnected)
  const available = useApp((s) => targetAvailable(s, target))
  const busy = state === 'connecting' || state === 'deploying'
  const tone = target.kind === 'local' && state === 'idle' && eventsConnected ? 'ok'
    : state === 'ready' ? 'ok' : state === 'error' ? 'danger' : busy ? 'accent' : 'muted'
  return { available, tone } as const
}

function targetKindLabel(target: Target): string {
  return target.kind === 'ssh' ? t('远端') : target.kind === 'direct' ? t('直连') : t('本机')
}

function quotaAgents(agents: readonly string[]): QuotaAgent[] {
  return agents.filter((agent): agent is QuotaAgent => agent === 'codex' || agent === 'claude')
}

/** 「用量」标签页：每台主机一张卡片，概览各 Agent 的最低剩余额度；点进去看详情。 */
export function UsageHome() {
  const targets = useApp((s) => s.targets)
  const activeId = useApp((s) => s.activeId)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const eventsError = useApp((s) => s.eventsError)
  const error = useApp((s) => s.error)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = targets.find((target) => target.id === selectedId)

  const onList = !selected
  // 切到用量页或从详情返回时自动刷新。
  useEffect(() => {
    if (onList && eventsConnected) void debounced(`auto:${activeId}`, () => refreshHosts(false))
  }, [onList, eventsConnected, activeId])
  const refresh = useCallback(() => debounced(`pull:${activeId}`, () => refreshHosts(true)), [activeId])
  // 详情是标签页内的二级视图，系统返回键先回到主机列表。
  useEffect(() => selected ? registerBackHandler(() => setSelectedId(null)) : undefined, [selected])

  if (selected) return <UsageDetail target={selected} onBack={() => setSelectedId(null)} />

  return (
    <PullToRefresh className="qn-body qn-scroll qn-workspace qn-workspace-home qn-rise" label={pageName('usage')}
      disabled={!activeId} onRefresh={refresh} scrollKey={JSON.stringify(['workspace', 'usage', activeId])}>
      {targets.length === 0 ? (eventsError || error ? <Empty>{t('没有可用的目标。')}</Empty> : <Loading text={t('正在读取目标…')} />) : (
        <>
          <div className="qn-list-label"><span>{t('{count} 台主机', { count: targets.length })}</span></div>
          <div className="qn-usage-hosts">
            {targets.map((target) => <UsageHostCard key={target.id} target={target} onOpen={() => setSelectedId(target.id)} />)}
          </div>
        </>
      )}
    </PullToRefresh>
  )
}

function UsageHostCard({ target, onOpen }: { target: Target; onOpen: () => void }) {
  const settings = useApp((s) => s.agentSettings)
  const codex = useApp((s) => s.rateLimits[target.id]?.snapshot)
  const claude = useApp((s) => s.claudeRateLimits[target.id])
  const { tone } = useTargetAvailability(target)
  const agents = quotaAgents(enabledAgents(settings, target.id))
  return (
    <button type="button" className="qn-usage-host qn-pressable" onClick={onOpen}
      aria-label={t('查看 {name} 的用量', { name: target.name })}>
      <span className="qn-usage-host-head">
        <StatusDot tone={tone} />
        <span className="min-w-0 flex-1">
          <span className="qn-usage-host-name">{target.name}</span>
          {target.kind !== 'local' && <span className="qn-subtitle block truncate">{formatAddress(target.host, target.port)}</span>}
        </span>
        {/* 本机目标的名称就是「本机」，再加来源标签只是重复。 */}
        {target.kind !== 'local' && <span className="qn-source-tag" data-kind={target.kind}>{targetKindLabel(target)}</span>}
        <ChevronRight size={18} className="shrink-0 text-qn-muted" aria-hidden />
      </span>
      {agents.length > 0 ? (
        <span className="qn-usage-host-meters">
          {agents.map((agent) => <HostMeter key={agent} agent={agent} snapshot={agent === 'codex' ? codex : claude} />)}
        </span>
      ) : <span className="qn-usage-host-empty">{t('未启用支持额度的 Agent')}</span>}
    </button>
  )
}

/** 主机卡片里的一行迷你额度条：显示最紧张窗口的剩余比例。 */
function HostMeter({ agent, snapshot }: { agent: QuotaAgent; snapshot?: RateLimitSnapshot | null }) {
  const tightest = agent === 'claude' && !claudeHasWindows(snapshot) ? null : tightestPercent(snapshot)
  const level = severity(snapshot)
  const reached = Boolean(snapshot?.rateLimitReachedType || snapshot?.spendControlReached)
  const remaining = tightest === null ? null : remainingQuotaPercent(tightest)
  const text = reached ? t('已达额度上限')
    : remaining !== null ? t('剩余 {percent}%', { percent: Math.round(remaining) })
      : agent === 'claude' ? claudeQuotaSummary(snapshot) ?? t('暂无数据') : t('暂无数据')
  return (
    <span className="qn-usage-meter">
      <span className="qn-usage-meter-name">{agentLabel(agent)}</span>
      <span className="qn-bar flex-1" aria-hidden>
        <span className="qn-bar-fill block" style={{ width: `${reached ? 0 : remaining ?? 0}%`, background: barColor[level] }} />
      </span>
      <span className={`qn-usage-meter-value ${remaining === null && !reached ? 'text-qn-muted' : toneText[level]}`}>{text}</span>
    </span>
  )
}

function UsageDetail({ target, onBack }: { target: Target; onBack: () => void }) {
  const settings = useApp((s) => s.agentSettings)
  const codexOpened = useApp((s) => s.sessions[sessionKey(target.id, 'codex')]?.opened === true)
  const claudeOpened = useApp((s) => s.sessions[sessionKey(target.id, 'claude')]?.opened === true)
  const { available } = useTargetAvailability(target)
  const agents = quotaAgents(enabledAgents(settings, target.id))
  const [claudeFailed, setClaudeFailed] = useState(false)

  useEffect(() => {
    // 打开详情即用户主动查看：补读已打开会话的额度和总用量。
    if (!available || (!codexOpened && !claudeOpened)) return
    void debounced(`auto:${target.id}:${codexOpened}:${claudeOpened}`, async () => { await readQuota(target.id, false) })
  }, [available, codexOpened, claudeOpened, target.id])

  const refresh = () => debounced(`pull:${target.id}`, async () => {
    setClaudeFailed(false)
    // 用户下拉刷新才打开尚未运行的 Codex，打开后由会话通道发起首次读取。
    const open = agents.includes('codex') && !codexOpened ? useApp.getState().ensureOpen(target.id, 'codex') : null
    const [failed] = await Promise.all([readQuota(target.id, true), open])
    setClaudeFailed(failed)
  })

  return (
    <>
      <Header title={target.name} onBack={onBack}
        subtitle={target.kind === 'local' ? undefined : `${targetKindLabel(target)} · ${formatAddress(target.host, target.port)}`} />
      <PullToRefresh className="qn-body qn-scroll qn-usage-detail qn-rise" label={pageName('usage')}
        disabled={!available} onRefresh={refresh}>
        {!available && <Note message={t('主机未连接，显示的是上次读取的数据。')} />}
        {agents.length === 0 && <Empty>{t('未启用支持额度的 Agent')}</Empty>}
        {agents.includes('codex') && (
          <>
            <CodexQuotaCard targetId={target.id} available={available} opened={codexOpened} />
            <CodexUsageCard targetId={target.id} opened={codexOpened} />
            <CodexAccountCard targetId={target.id} />
          </>
        )}
        {agents.includes('claude') && (
          <ClaudeQuotaCard targetId={target.id} opened={claudeOpened} failed={claudeFailed && available} />
        )}
      </PullToRefresh>
    </>
  )
}

function UsageCard({ agent, title, badge, children }: { agent?: QuotaAgent; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="qn-usage-card" aria-label={agent ? `${agentLabel(agent)} ${title}` : title}>
      <header className="qn-usage-card-head">
        {agent && <AgentTag agent={agent} />}
        <h2>{title}</h2>
        {badge}
      </header>
      {children}
    </section>
  )
}

function SeverityBadge({ level, children }: { level: RateLimitSeverity; children: ReactNode }) {
  return <span className="qn-usage-badge" data-level={level}>{children}</span>
}

/** 单个额度窗口：大号剩余百分比 + 进度条 + 重置时间。 */
function QuotaWindow({ label, window, now }: { label: string; window: RateLimitWindow; now: number }) {
  const level = severityForPercent(window.usedPercent)
  const remaining = remainingQuotaPercent(window.usedPercent)
  return (
    <div className="qn-usage-window">
      <div className="qn-usage-window-top">
        <span className="qn-usage-window-label">{label}</span>
        <span className="qn-usage-window-value">
          <strong className={level === 'ok' ? undefined : toneText[level]}>{Math.round(remaining)}</strong>
          <span>{t('% 剩余')}</span>
        </span>
      </div>
      <div className="qn-bar qn-usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}
        aria-label={t('{label}剩余 {percent}%', { label, percent: Math.round(remaining) })}>
        <div className="qn-bar-fill" style={{ width: `${remaining}%`, background: barColor[level] }} />
      </div>
      <div className="qn-usage-window-foot">
        <span>{t('已用 {percent}%', { percent: Math.round(window.usedPercent) })}</span>
        {window.resetsAt !== null && <span>{formatReset(window.resetsAt, now)}</span>}
      </div>
    </div>
  )
}

function CodexQuotaCard({ targetId, available, opened }: { targetId: string; available: boolean; opened: boolean }) {
  const entry = useApp((s) => s.rateLimits[targetId])
  const session = useApp((s) => s.sessions[sessionKey(targetId, 'codex')])
  const now = useNow()
  const snapshot = entry?.snapshot
  const tightest = tightestPercent(snapshot)
  const level = severity(snapshot)
  const error = session?.openError ?? entry?.error
  const loading = entry?.loading || session?.opening
  const hasWindows = Boolean(snapshot?.primary || snapshot?.secondary)
  return (
    <UsageCard agent="codex" title={t('额度')} badge={tightest !== null && (
      <SeverityBadge level={level}>{t('最低剩余 {percent}%', { percent: Math.round(remainingQuotaPercent(tightest)) })}</SeverityBadge>
    )}>
      {error && <p className="qn-usage-error">{translateMessage(error)}</p>}
      {snapshot?.primary && <QuotaWindow label={windowLabel(snapshot.primary.windowDurationMins ?? 300)} window={snapshot.primary} now={now} />}
      {snapshot?.secondary && <QuotaWindow label={windowLabel(snapshot.secondary.windowDurationMins ?? 10080)} window={snapshot.secondary} now={now} />}
      {!hasWindows && !error && (
        <div className="qn-usage-empty">
          <p>{loading ? t('正在读取额度…') : opened ? t('暂无额度数据') : t('Codex 尚未打开，点击读取额度')}</p>
          {!opened && !loading && (
            <Button className="px-3 py-1.5 text-sm" disabled={!available} onClick={() => void useApp.getState().ensureOpen(targetId, 'codex')}>
              {t('读取额度')}
            </Button>
          )}
        </div>
      )}
      {(snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true) && (
        <p className="qn-usage-error">{snapshot.rateLimitReachedType
          ? t('已达额度上限（{type}）', { type: snapshot.rateLimitReachedType }) : t('已达额度上限')}</p>
      )}
    </UsageCard>
  )
}

function CodexUsageCard({ targetId, opened }: { targetId: string; opened: boolean }) {
  const usage = useApp((s) => s.rateLimits[targetId]?.usage)
  const loading = useApp((s) => s.rateLimits[targetId]?.usageLoading === true)
  const error = useApp((s) => s.rateLimits[targetId]?.usageError ?? null)
  return (
    <UsageCard agent="codex" title={t('总用量')} badge={loading && <span className="qn-usage-note ml-auto">{t('刷新中…')}</span>}>
      {error && <p className="qn-usage-error">{translateMessage(error)}</p>}
      {usage ? <UsageStats usage={usage} /> : !loading && !error && (
        <p className="qn-usage-empty-text">{opened ? t('暂无用量数据') : t('打开 Codex 后可查看')}</p>
      )}
    </UsageCard>
  )
}

function UsageStats({ usage }: { usage: AccountUsage }) {
  const days = recentUsageDays(usage, USAGE_DAYS)
  const tiles: Array<{ label: string; value: string; unit?: string }> = []
  if (usage.lifetimeTokens !== null) tiles.push({ label: t('累计'), value: formatTokens(usage.lifetimeTokens), unit: 'tokens' })
  if (days.length > 0) tiles.push({ label: t('近 {days} 天', { days: days.length }), value: formatTokens(sumUsageTokens(days)), unit: 'tokens' })
  if (usage.peakDailyTokens !== null) tiles.push({ label: t('单日峰值'), value: formatTokens(usage.peakDailyTokens), unit: 'tokens' })
  if (usage.currentStreakDays !== null) {
    tiles.push({
      label: usage.longestStreakDays !== null ? t('连续使用（最长 {days} 天）', { days: usage.longestStreakDays }) : t('连续使用'),
      value: String(usage.currentStreakDays),
      unit: t('天'),
    })
  }
  return (
    <>
      <dl className="qn-usage-stats">
        {tiles.map((tile) => (
          <div key={tile.label} className="qn-usage-stat">
            <dt>{tile.label}</dt>
            <dd><strong>{tile.value}</strong>{tile.unit && <span>{tile.unit}</span>}</dd>
          </div>
        ))}
      </dl>
      {days.length > 1 && <DailyChart days={days} />}
    </>
  )
}

/** 近几天每日 token 柱状图：单系列不需要图例；点按柱子查看当天数值。 */
function DailyChart({ days }: { days: AccountUsage['daily'] }) {
  const [active, setActive] = useState<number | null>(null)
  const max = Math.max(1, ...days.map((day) => day.tokens))
  const shown = active === null ? null : days[active]
  return (
    <figure className="qn-usage-chart">
      <figcaption>
        <span>{t('每日用量')}</span>
        <span className="tabular-nums">{shown ? `${shortDate(shown.date)} · ${formatTokens(shown.tokens)} tokens` : t('点按柱子查看当天')}</span>
      </figcaption>
      <div className="qn-usage-bars" role="img" aria-label={t('近 {days} 天每日用量：{list}', {
        days: days.length,
        list: days.map((day) => `${shortDate(day.date)} ${formatTokens(day.tokens)}`).join(', '),
      })}>
        {days.map((day, index) => (
          <button type="button" key={day.date} className="qn-usage-bar-slot" aria-pressed={active === index}
            aria-label={`${shortDate(day.date)} ${formatTokens(day.tokens)} tokens`}
            onClick={() => setActive(active === index ? null : index)}>
            <span className="qn-usage-bar-col" data-empty={day.tokens === 0 || undefined}
              style={{ height: `${Math.max(4, (day.tokens / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="qn-usage-axis" aria-hidden>
        {days.map((day, index) => <span key={day.date} data-active={active === index || undefined}>{weekday(day.date)}</span>)}
      </div>
    </figure>
  )
}

function parseDay(date: string): Date | null {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function shortDate(date: string): string {
  const day = parseDay(date)
  if (!day) return date
  return getLocale() === 'en'
    ? day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : `${day.getMonth() + 1}/${day.getDate()}`
}

function weekday(date: string): string {
  const day = parseDay(date)
  if (!day) return date.slice(5)
  return day.toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { weekday: 'narrow' })
}

function CodexAccountCard({ targetId }: { targetId: string }) {
  const entry = useApp((s) => s.rateLimits[targetId])
  const account = entry?.account ?? null
  const rows: Array<[string, string]> = account ? [
    [t('账号'), account.email ?? account.type],
    [t('套餐'), account.planType ?? '—'],
    ...(account.workspaceName ? [[t('工作区'), account.workspaceName] as [string, string]] : []),
  ] : []
  const updated = entry?.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString(getLocale() === 'en' ? 'en-US' : 'zh-CN') : '—'
  return (
    <UsageCard agent="codex" title={t('账号')}>
      {account ? (
        <dl className="qn-usage-rows">
          {rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
          <div><dt>{t('最后更新')}</dt><dd>{updated}</dd></div>
        </dl>
      ) : <p className="qn-usage-empty-text">{t('账号信息不可用')}</p>}
    </UsageCard>
  )
}

function ClaudeQuotaCard({ targetId, opened, failed }: { targetId: string; opened: boolean; failed: boolean }) {
  const snapshot: ClaudeRateLimitSnapshot | undefined = useApp((s) => s.claudeRateLimits[targetId])
  const now = useNow()
  const live = claudeHasWindows(snapshot)
  const reset = claudeQuotaResetAt(snapshot)
  const source = claudeQuotaSource(snapshot)
  const tightest = live ? tightestPercent(snapshot) : null
  const level = severity(snapshot)
  return (
    <UsageCard agent="claude" title={t('额度')} badge={tightest !== null && (
      <SeverityBadge level={level}>{t('最低剩余 {percent}%', { percent: Math.round(remainingQuotaPercent(tightest)) })}</SeverityBadge>
    )}>
      {failed && <p className="qn-usage-error">{t('读取额度失败')}</p>}
      {live ? (
        <>
          {snapshot?.primary && <QuotaWindow label={t('5 小时')} window={snapshot.primary} now={now} />}
          {snapshot?.secondary && <QuotaWindow label={t('每周')} window={snapshot.secondary} now={now} />}
        </>
      ) : (
        <div className="qn-usage-empty">
          <p className={toneText[level]}>{claudeQuotaSummary(snapshot) ?? (opened ? CLAUDE_WAITING_FOR_QUOTA : t('Claude 会话打开后上报额度'))}</p>
          {reset !== null && <p className="qn-usage-note">{formatReset(reset, now)}</p>}
        </div>
      )}
      {(source || snapshot) && (
        <p className="qn-usage-note">{[source, claudeQuotaReportedAt(snapshot)].filter(Boolean).join(' · ')}</p>
      )}
    </UsageCard>
  )
}
