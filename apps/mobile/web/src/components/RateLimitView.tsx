import {
  CLAUDE_WAITING_FOR_QUOTA,
  claudeQuotaReportedAt,
  claudeQuotaResetAt,
  claudeQuotaSource,
  claudeQuotaSummary,
  compactText,
  formatReset,
  isClaudeStatusLine,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  tightestPercent,
  windowLabel,
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
  const live = isClaudeStatusLine(snapshot)
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
            ? <RateLimitDetails targetId={targetId} available={available} />
            : <ClaudeQuotaDetails targetId={targetId} snapshot={claude} available={available && claudeOpened} />}
        </Dialog>
      )}
    </div>
  )
}

/** 对话里模型弹层下方的额度区：只看当前目标、当前 Agent，比在连接页单独开入口更贴近使用场景。 */
export function AgentQuota({ targetId, agent }: { targetId: string; agent: string }) {
  const opened = useApp((s) => s.sessions[sessionKey(targetId, 'codex')]?.opened === true)
  const claudeAvailable = useApp((s) => s.eventsConnected && s.sessions[sessionKey(targetId, 'claude')]?.opened === true)
  const claude = useApp((s) => s.claudeRateLimits[targetId])
  if (agent === 'codex') {
    return (
      <section className="mb-3" aria-label={t('Codex 额度')}>
        <div className="qn-label">{t('额度')}</div>
        <RateLimitDetails targetId={targetId} available={opened} />
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

export function RateLimitDetails({ targetId, available }: { targetId: string; available: boolean }) {
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
