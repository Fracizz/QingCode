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
  resetCreditExpiry,
  resetCreditText,
  unlistedResetCredits,
  type AccountUsage,
  type ClaudeRateLimitSnapshot,
  type RateLimitWindow,
  type ResetCredit,
  getLocale,
  t,
  translateMessage,
} from '@qn/codex-client'
import { useEffect, useState } from 'react'
import { agentLabel, enabledAgents, sessionKey } from '../agents'
import { useApp } from '../store'
import { Badge, Button, Dialog } from './ui'

type QuotaAgent = 'codex' | 'claude'

function ClaudeQuotaDetails({ targetId, snapshot, available, label }: {
  targetId: string
  snapshot?: ClaudeRateLimitSnapshot
  available: boolean
  /** 嵌在模型弹层时把「额度」标题与刷新按钮并成一行，省出高度，避免被吸底区遮住。 */
  label?: string
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
    <div className="qn-quota">
      <div className="qn-quota-head">
        {label && <h3 className="qn-quota-title">{label}</h3>}
        <Button className="qn-quota-refresh" disabled={!available || loading} onClick={() => void refresh()}>
          {loading ? t('刷新中…') : t('刷新')}
        </Button>
      </div>
      {readFailed && available && <p className="text-xs text-qn-danger">{t('读取额度失败')}</p>}
      <div className="qn-surface qn-quota-card">
        {live ? (
          <>
            {snapshot?.primary && <WindowRow label={t('5 小时')} window={snapshot.primary} now={now} />}
            {snapshot?.secondary && <WindowRow label={t('每周')} window={snapshot.secondary} now={now} />}
          </>
        ) : (
          <div>
            <p className={`text-sm ${toneText(severity(snapshot))}`}>{claudeQuotaSummary(snapshot) ?? CLAUDE_WAITING_FOR_QUOTA}</p>
            {reset !== null && <p className="qn-quota-sub">{formatReset(reset, now)}</p>}
          </div>
        )}
      </div>
      <p className="qn-quota-foot">
        {[source, claudeQuotaReportedAt(snapshot) ?? t('暂无上报时间')].filter(Boolean).join(' · ')}
      </p>
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
        <RateLimitDetails targetId={targetId} available={opened} showUsage={showUsage} label={t('额度')} />
      </section>
    )
  }
  if (agent !== 'claude') return null
  return (
    <section className="mb-3" aria-label={t('Claude 额度')}>
      <ClaudeQuotaDetails targetId={targetId} snapshot={claude} available={claudeAvailable} label={t('额度')} />
    </section>
  )
}

function WindowRow({ label, window, now }: { label: string; window: RateLimitWindow; now: number }) {
  const level = severityForPercent(window.usedPercent)
  const remaining = remainingQuotaPercent(window.usedPercent)
  return (
    <div className="qn-quota-window">
      <div className="qn-quota-window-head">
        <span>{label}</span>
        <span className={`tabular-nums ${toneText(level)}`}>{t('剩余 {percent}%', { percent: Math.round(remaining) })}</span>
      </div>
      <div className="qn-bar">
        <div
          className="qn-bar-fill"
          style={{ width: `${remaining}%`, background: barColor(level) }}
        />
      </div>
      {window.resetsAt !== null && (
        <div className="qn-quota-sub">{formatReset(window.resetsAt, now)}</div>
      )}
    </div>
  )
}

export function RateLimitDetails({ targetId, available, showUsage, label }: {
  targetId: string
  available: boolean
  showUsage?: boolean
  /** 嵌在模型弹层时显示「额度」小标题，与刷新按钮同一行。 */
  label?: string
}) {
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
  const windows = Boolean(snapshot?.primary || snapshot?.secondary)
  const empty = !windows && !loading && !error
  const reached = Boolean(snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true)

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
    <div className="qn-quota">
      <div className="qn-quota-head">
        {label && <h3 className="qn-quota-title">{label}</h3>}
        {tightest !== null && (
          <Badge tone={level === 'ok' ? 'muted' : level}>
            {t('最低剩余 {percent}%', { percent: Math.round(remainingQuotaPercent(tightest)) })}
          </Badge>
        )}
        <Button className="qn-quota-refresh" onClick={refresh} disabled={!available || loading}>
          {loading ? t('刷新中…') : t('刷新')}
        </Button>
      </div>
      {error && <p className="text-xs text-qn-danger">{translateMessage(error)}</p>}
      {/* 额度窗口与上限提示收进一张卡片，与下方重置卡、总用量同一层级。 */}
      {(windows || empty || reached) && (
        <div className="qn-surface qn-quota-card">
          {snapshot?.primary && (
            <WindowRow label={windowLabel(snapshot.primary.windowDurationMins ?? 300)} window={snapshot.primary} now={now} />
          )}
          {snapshot?.secondary && (
            <WindowRow label={windowLabel(snapshot.secondary.windowDurationMins ?? 10080)} window={snapshot.secondary} now={now} />
          )}
          {empty && <p className="text-sm text-qn-muted">{t('暂无额度数据')}</p>}
          {reached && (
            <p className="text-xs text-qn-danger">{snapshot?.rateLimitReachedType
              ? t('已达额度上限（{type}）', { type: snapshot.rateLimitReachedType }) : t('已达额度上限')}</p>
          )}
        </div>
      )}
      <ResetCreditsSummary targetId={targetId} available={available} now={now} />
      {showUsage && <AccountUsageSummary targetId={targetId} available={available} />}
      <div className="qn-quota-foot">
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

/** Codex 额度重置卡：查看与使用。使用必须经确认框，不做任何自动兑换。 */
function ResetCreditsSummary({ targetId, available, now }: { targetId: string; available: boolean; now: number }) {
  const entry = useApp((s) => s.rateLimits[targetId])
  const ready = useApp((s) => s.eventsConnected && s.sessions[sessionKey(targetId, 'codex')]?.opened === true)
  const consume = useApp((s) => s.consumeResetCredit)
  // credit 为 null 表示后端没给明细，由 Codex 选卡。
  const [confirm, setConfirm] = useState<{ targetId: string; credit: ResetCredit | null } | null>(null)
  const summary = entry?.resetCredits
  const notice = entry?.resetNotice
  const busy = entry?.resetting === true
  if (!summary && !notice) return null
  const unlisted = summary ? unlistedResetCredits(summary) : 0
  const pending = confirm?.targetId === targetId ? confirm : null
  const disabled = !available || !ready || busy

  const redeemButton = (credit: ResetCredit | null, label: string) => (
    <Button className="qn-quota-action" disabled={disabled || credit?.redeeming === true}
      onClick={() => setConfirm({ targetId, credit })}>
      {busy || credit?.redeeming ? t('使用中…') : label}
    </Button>
  )

  return (
    <section className="qn-quota-section" aria-label={t('重置卡')}>
      <div className="qn-quota-section-head">
        <h3 className="qn-quota-title">{t('重置卡')}</h3>
        {summary && <span className="tabular-nums">{t('可用 {count} 张', { count: summary.availableCount })}</span>}
      </div>
      {summary && (summary.credits.length > 0 || unlisted > 0) && (
        <ul className="qn-surface qn-quota-list">
          {summary.credits.map((credit) => {
            const { title, description } = resetCreditText(credit)
            return (
              <li key={credit.id} className="qn-quota-item">
                <div className="min-w-0 flex-1">
                  <div className="qn-quota-item-title">{title ?? t('额度重置卡')}</div>
                  {description && <div className="qn-quota-sub">{description}</div>}
                  <div className="qn-quota-sub">{resetCreditExpiry(credit.expiresAt, now)}</div>
                </div>
                {redeemButton(credit, t('使用'))}
              </li>
            )
          })}
          {unlisted > 0 && (summary.credits.length === 0
            ? <li className="qn-quota-item justify-end">{redeemButton(null, t('使用一张'))}</li>
            : <li className="qn-quota-item qn-quota-sub">{t('另有 {count} 张未列出明细', { count: unlisted })}</li>)}
        </ul>
      )}
      {notice && <p role="status" className={`text-xs ${notice.tone === 'ok' ? 'text-qn-ok' : toneText(notice.tone)}`}>{notice.text}</p>}
      {pending && (
        <Dialog title={t('使用重置卡？')} onClose={() => setConfirm(null)}>
          <p className="text-sm">{t('将消耗 1 张重置卡来重置当前账号的 Codex 额度，使用后无法撤销。')}</p>
          <div className="mt-2 text-xs text-qn-muted">
            {pending.credit
              ? <>
                <div>{resetCreditText(pending.credit).title ?? t('额度重置卡')}</div>
                <div>{resetCreditExpiry(pending.credit.expiresAt, now)}</div>
              </>
              : <div>{t('由 Codex 选择下一张可用的卡。')}</div>}
            {entry?.account?.email && <div className="break-all">{t('账号：{value}', { value: entry.account.email })}</div>}
          </div>
          <Button variant="primary" className="mt-3 w-full" disabled={disabled}
            onClick={() => {
              setConfirm(null)
              void consume(targetId, pending.credit?.id ?? null)
            }}>
            {t('确认使用')}
          </Button>
        </Dialog>
      )}
    </section>
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
    <section className="qn-quota-section" aria-label={t('Codex 总用量')}>
      <div className="qn-quota-section-head">
        <h3 className="qn-quota-title">{t('总用量')}</h3>
        {loading && <span>{t('刷新中…')}</span>}
      </div>
      {error && <p className="text-xs text-qn-danger">{translateMessage(error)}</p>}
      {usage ? <div className="qn-surface qn-quota-card"><UsageStats usage={usage} /></div> : !loading && !error && (
        <p className="qn-quota-sub px-1">{ready ? t('暂无用量数据') : t('打开 Codex 后可查看')}</p>
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
      <dl className="qn-quota-stats">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {days.length > 1 && (
        <div className="qn-quota-chart" role="img"
          aria-label={t('近 {days} 天每日用量：{list}', {
            days: days.length,
            list: days.map((day) => `${day.date.slice(5)} ${formatTokens(day.tokens)}`).join(', '),
          })}>
          {days.map((day) => (
            <div key={day.date} className="qn-quota-bar" data-empty={day.tokens > 0 ? undefined : 'true'}
              style={{ height: `${Math.max(6, (day.tokens / max) * 100)}%` }} />
          ))}
        </div>
      )}
    </>
  )
}
