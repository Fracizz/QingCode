import {
  CLAUDE_WAITING_FOR_QUOTA,
  claudeQuotaReportedAt,
  claudeQuotaResetAt,
  claudeQuotaSource,
  claudeQuotaSummary,
  compactText,
  formatTokens,
  formatReset,
  claudeHasWindows,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  tightestPercent,
  recentUsageDays,
  sumUsageTokens,
  windowLabel,
  type AccountUsage,
  type ClaudeRateLimitSnapshot,
  type RateLimitWindow,
  getLocale,
  t,
  translateMessage,
} from '@qn/codex-client'
import { useEffect, useState } from 'react'
import { agentLabel, enabledAgents, sessionKey } from '../agents'
import { useApp } from '../store'
import { Badge, Button, Dialog } from './ui'

type QuotaAgent = 'codex' | 'claude'

function ClaudeQuotaDetails({ targetId, snapshot, available }: {
  targetId: string
  snapshot?: ClaudeRateLimitSnapshot
  available: boolean
}) {
  const refreshQuota = useApp((s) => s.refreshClaudeRateLimits)
  const [loading, setLoading] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const reset = claudeQuotaResetAt(snapshot)
  const live = claudeHasWindows(snapshot)
  const source = claudeQuotaSource(snapshot)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  async function refresh() {
    setLoading(true)
    setReadFailed(false)
    try {
      setReadFailed(!await refreshQuota(targetId))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-end">
        <Button className="px-2 py-1 text-xs" disabled={!available || loading} onClick={() => void refresh()}>
          {loading ? t('刷新中…') : t('刷新')}
        </Button>
      </div>
      {readFailed && available && <p className="text-xs text-qn-danger">{t('读取额度失败')}</p>}
      {live ? (
        <>
          {snapshot?.primary && <WindowRow label={t('5 小时')} window={snapshot.primary} now={now} />}
          {snapshot?.secondary && <WindowRow label={t('每周')} window={snapshot.secondary} now={now} />}
        </>
      ) : (
        <>
          <p className={toneText(severity(snapshot))}>{claudeQuotaSummary(snapshot) ?? CLAUDE_WAITING_FOR_QUOTA}</p>
          {reset !== null && <p className="text-xs text-qn-muted">{formatReset(reset, now)}</p>}
        </>
      )}
      {source && <p className="text-xs text-qn-muted">{source}</p>}
      <p className="text-xs text-qn-muted">{claudeQuotaReportedAt(snapshot) ?? t('暂无上报时间')}</p>
    </div>
  )
}

function toneText(level: 'ok' | 'warn' | 'danger'): string {
  return level === 'danger' ? 'text-qn-danger' : level === 'warn' ? 'text-qn-warn' : 'text-qn-muted'
}

function barColor(level: 'ok' | 'warn' | 'danger'): string {
  return level === 'danger'
    ? 'var(--color-qn-danger)'
    : level === 'warn'
      ? 'var(--color-qn-warn)'
      : 'var(--color-qn-accent)'
}

function QuotaButton({ agent, summary, level, onClick }: {
  agent: QuotaAgent
  summary: string | null
  level: ReturnType<typeof severity>
  onClick: () => void
}) {
  const name = agentLabel(agent)
  return (
    <button type="button" className={`qn-badge qn-badge-button ${toneText(level)}`} onClick={onClick}
      aria-haspopup="dialog" aria-label={summary ? t('{name} 额度详情，{summary}', { name, summary }) : t('{name} 额度详情', { name })}>
      {name} {summary ?? t('额度')}
    </button>
  )
}

export function TargetRateLimits({ targetId, targetName, available }: {
  targetId: string
  targetName: string
  available: boolean
}) {
  const settings = useApp((s) => s.agentSettings)
  const codex = useApp((s) => s.rateLimits[targetId]?.snapshot)
  const claude = useApp((s) => s.claudeRateLimits[targetId])
  const claudeOpened = useApp((s) => s.sessions[sessionKey(targetId, 'claude')]?.opened === true)
  const [open, setOpen] = useState<QuotaAgent | null>(null)
  const agents = enabledAgents(settings, targetId)
  const codexSummary = codex?.rateLimitReachedType || codex?.spendControlReached
    ? t('已达额度上限')
    : codex?.primary || codex?.secondary ? compactText(codex, 'remaining') : null
  const claudeSummary = claudeQuotaSummary(claude)
  const showCodex = agents.includes('codex') && (available || codexSummary !== null)
  const showClaude = agents.includes('claude') && (claudeOpened || claudeSummary !== null)
  if (!showCodex && !showClaude) return null

  return (
    <div className="flex w-full flex-wrap gap-2 pl-4" role="group" aria-label={t('{name} 的 CLI 额度', { name: targetName })}>
      {showCodex && <QuotaButton agent="codex" summary={codexSummary} level={severity(codex)} onClick={() => setOpen('codex')} />}
      {showClaude && <QuotaButton agent="claude" summary={claudeSummary} level={severity(claude)} onClick={() => setOpen('claude')} />}
      {open && (open === 'codex' ? showCodex : showClaude) && (
        <Dialog title={t('{target} · {agent} 额度', { target: targetName, agent: agentLabel(open) })} onClose={() => setOpen(null)}>
          {open === 'codex'
            ? <RateLimitDetails targetId={targetId} available={available} showUsage />
            : <ClaudeQuotaDetails targetId={targetId} snapshot={claude} available={available && claudeOpened} />}
        </Dialog>
      )}
    </div>
  )
}

/** 对话里模型弹层下方的额度区：只看当前目标、当前 Agent，比在连接页单独开入口更贴近使用场景。 */
export function AgentQuota({ targetId, agent, showUsage }: { targetId: string; agent: string; showUsage?: boolean }) {
  const opened = useApp((s) => s.sessions[sessionKey(targetId, 'codex')]?.opened === true)
  const claudeAvailable = useApp((s) => s.eventsConnected && s.sessions[sessionKey(targetId, 'claude')]?.opened === true)
  const claude = useApp((s) => s.claudeRateLimits[targetId])
  if (agent === 'codex') {
    return (
      <section className="mb-3" aria-label={t('Codex 额度')}>
        <div className="qn-label">{t('额度')}</div>
        <RateLimitDetails targetId={targetId} available={opened} showUsage={showUsage} />
      </section>
    )
  }
  if (agent !== 'claude') return null
  return (
    <section className="mb-3 space-y-1 text-sm" aria-label={t('Claude 额度')}>
      <div className="qn-label">{t('额度')}</div>
      <ClaudeQuotaDetails targetId={targetId} snapshot={claude} available={claudeAvailable} />
    </section>
  )
}

function WindowRow({ label, window, now }: { label: string; window: RateLimitWindow; now: number }) {
  const level = severityForPercent(window.usedPercent)
  const remaining = remainingQuotaPercent(window.usedPercent)
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className={toneText(level)}>{t('剩余 {percent}%', { percent: Math.round(remaining) })}</span>
      </div>
      <div className="qn-bar">
        <div
          className="qn-bar-fill"
          style={{ width: `${remaining}%`, background: barColor(level) }}
        />
      </div>
      {window.resetsAt !== null && (
        <div className="mt-1 text-[11px] text-qn-muted">{formatReset(window.resetsAt, now)}</div>
      )}
    </div>
  )
}

export function RateLimitDetails({ targetId, available, showUsage }: { targetId: string; available: boolean; showUsage?: boolean }) {
  const entry = useApp((s) => s.rateLimits[targetId])
  const session = useApp((s) => s.sessions[sessionKey(targetId, 'codex')])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const snapshot = entry?.snapshot
  const account = entry?.account ?? null
  const level = severity(snapshot)
  const tightest = tightestPercent(snapshot)
  const loading = entry?.loading || session?.opening
  const error = session?.openError ?? entry?.error

  function refresh() {
    const app = useApp.getState()
    if (app.sessions[sessionKey(targetId, 'codex')]?.opened) {
      void app.refreshRateLimits(targetId)
      if (showUsage) void app.refreshAccountUsage(targetId)
    } else {
      // 显式刷新才打开尚未运行的 Codex，打开后由会话通道发起首次读取。
      void app.ensureOpen(targetId, 'codex')
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        {tightest !== null && (
          <Badge tone={level === 'ok' ? 'muted' : level}>
            {t('最低剩余 {percent}%', { percent: Math.round(remainingQuotaPercent(tightest)) })}
          </Badge>
        )}
        <Button className="ml-auto px-2 py-1 text-xs" onClick={refresh} disabled={!available || loading}>
          {loading ? t('刷新中…') : t('刷新')}
        </Button>
      </div>
      {error && <p className="mb-2 text-xs text-qn-danger">{translateMessage(error)}</p>}
      {snapshot?.primary && (
        <WindowRow label={windowLabel(snapshot.primary.windowDurationMins ?? 300)} window={snapshot.primary} now={now} />
      )}
      {snapshot?.secondary && (
        <WindowRow label={windowLabel(snapshot.secondary.windowDurationMins ?? 10080)} window={snapshot.secondary} now={now} />
      )}
      {!snapshot?.primary && !snapshot?.secondary && !loading && !error && (
        <p className="mb-2 text-sm text-qn-muted">{t('暂无额度数据')}</p>
      )}
      {snapshot?.credits?.hasCredits && (
        <p className="mb-2 text-xs text-qn-muted">{t('积分：{value}', { value: snapshot.credits.unlimited ? t('不限量') : (snapshot.credits.balance ?? t('有余额')) })}</p>
      )}
      {(snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true) && (
        <p className="mb-2 text-xs text-qn-danger">{snapshot.rateLimitReachedType
          ? t('已达额度上限（{type}）', { type: snapshot.rateLimitReachedType }) : t('已达额度上限')}</p>
      )}
      {showUsage && <AccountUsageSummary targetId={targetId} available={available} />}
      <div className="mt-2 border-t border-qn-border pt-2 text-[11px] text-qn-muted">
        {account ? (
          <>
            <div>{t('账号：{value}', { value: account.email ?? account.type })}</div>
            <div>{t('套餐：{value}', { value: account.planType ?? '—' })}</div>
            {account.workspaceName && <div className="break-words">{t('工作区：{value}', { value: account.workspaceName })}</div>}
          </>
        ) : (
          <div>{t('账号信息不可用')}</div>
        )}
        <div>{t('最后更新：{time}', {
          time: entry?.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString(getLocale() === 'en' ? 'en-US' : 'zh-CN') : '—',
        })}</div>
      </div>
    </div>
  )
}

const USAGE_DAYS = 7

/** Codex 账号级总用量（官方 account/usage/read）。打开详情时读一次，之后跟随上方刷新按钮。 */
function AccountUsageSummary({ targetId, available }: { targetId: string; available: boolean }) {
  const usage = useApp((s) => s.rateLimits[targetId]?.usage)
  const loading = useApp((s) => s.rateLimits[targetId]?.usageLoading === true)
  const error = useApp((s) => s.rateLimits[targetId]?.usageError ?? null)
  const refreshUsage = useApp((s) => s.refreshAccountUsage)
  const opened = useApp((s) => s.sessions[sessionKey(targetId, 'codex')]?.opened === true)
  const loaded = usage !== undefined
  const ready = available && opened

  useEffect(() => {
    // 只在 Codex 会话已打开时读取，不为此启动 Agent；读到结果后不再自动重复请求。
    if (ready && !loaded) void refreshUsage(targetId)
  }, [ready, loaded, refreshUsage, targetId])

  return (
    <section className="mt-3 border-t border-qn-border pt-2" aria-label={t('Codex 总用量')}>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span>{t('总用量')}</span>
        {loading && <span className="text-qn-muted">{t('刷新中…')}</span>}
      </div>
      {error && <p className="mb-1 text-xs text-qn-danger">{translateMessage(error)}</p>}
      {usage ? <UsageStats usage={usage} /> : !loading && !error && (
        <p className="text-xs text-qn-muted">{ready ? t('暂无用量数据') : t('打开 Codex 后可查看')}</p>
      )}
    </section>
  )
}

function UsageStats({ usage }: { usage: AccountUsage }) {
  const days = recentUsageDays(usage, USAGE_DAYS)
  const max = Math.max(1, ...days.map((day) => day.tokens))
  const rows: Array<[string, string]> = []
  if (usage.lifetimeTokens !== null) rows.push([t('累计'), `${formatTokens(usage.lifetimeTokens)} tokens`])
  if (days.length > 0) rows.push([t('近 {days} 天', { days: days.length }), `${formatTokens(sumUsageTokens(days))} tokens`])
  if (usage.peakDailyTokens !== null) rows.push([t('单日峰值'), `${formatTokens(usage.peakDailyTokens)} tokens`])
  if (usage.currentStreakDays !== null) {
    rows.push([t('连续使用'), usage.longestStreakDays !== null
      ? t('{days} 天（最长 {longest} 天）', { days: usage.currentStreakDays, longest: usage.longestStreakDays })
      : t('{days} 天', { days: usage.currentStreakDays })])
  }
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-qn-muted">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {days.length > 1 && (
        <div className="mt-2 flex h-10 items-end gap-1" role="img"
          aria-label={t('近 {days} 天每日用量：{list}', {
            days: days.length,
            list: days.map((day) => `${day.date.slice(5)} ${formatTokens(day.tokens)}`).join(', '),
          })}>
          {days.map((day) => (
            <div key={day.date} className="flex-1 rounded-sm"
              style={{ height: `${Math.max(4, (day.tokens / max) * 100)}%`, background: day.tokens > 0 ? 'var(--color-qn-accent)' : 'var(--color-qn-border)' }} />
          ))}
        </div>
      )}
    </>
  )
}
