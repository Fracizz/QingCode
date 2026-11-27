import {
  compactText,
  formatReset,
  isClaudeStatusLine,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  tightestPercent,
  windowLabel,
  type RateLimitSnapshot,
  type RateLimitWindow,
} from '@qn/codex-client'
import { useEffect, useState } from 'react'
import { agentLabel, enabledAgents, sessionKey } from '../agents'
import { useApp } from '../store'
import { Badge, Button, Dialog } from './ui'

type QuotaAgent = 'codex' | 'claude'

function claudeQuotaSummary(snapshot: RateLimitSnapshot | undefined): string | null {
  if (snapshot?.rateLimitReachedType || snapshot?.spendControlReached) return '已达额度上限'
  if (isClaudeStatusLine(snapshot)) return compactText(snapshot, 'remaining')
  const used = snapshot?.primary?.usedPercent
  return used == null ? null : `上报剩余 ${Math.round(remainingQuotaPercent(used))}%`
}

const claudeQuotaNote = 'Claude 只在接近或触发限额时上报。'

function ClaudeQuotaDetails({ snapshot }: { snapshot?: RateLimitSnapshot }) {
  const now = Date.now()
  if (isClaudeStatusLine(snapshot)) {
    return (
      <div>
        {snapshot?.primary && <WindowRow label="5 小时" window={snapshot.primary} now={now} />}
        {snapshot?.secondary && <WindowRow label="每周" window={snapshot.secondary} now={now} />}
        <p className="text-xs text-qn-muted">来源为 Claude CLI 状态栏</p>
      </div>
    )
  }
  return (
    <div className="space-y-1 text-sm">
      <p className={toneText(severity(snapshot))}>{claudeQuotaSummary(snapshot) ?? '暂无限额上报'}</p>
      {snapshot?.primary?.resetsAt != null && <p className="text-xs text-qn-muted">{formatReset(snapshot.primary.resetsAt, now)}</p>}
      <p className="text-xs text-qn-muted">{claudeQuotaNote}</p>
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
      aria-haspopup="dialog" aria-label={`${name} 额度详情${summary ? `，${summary}` : ''}`}>
      {name} {summary ?? '额度'}
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
    ? '已达额度上限'
    : codex?.primary || codex?.secondary ? compactText(codex, 'remaining') : null
  const claudeSummary = claudeQuotaSummary(claude)
  const showCodex = agents.includes('codex') && (available || codexSummary !== null)
  const showClaude = agents.includes('claude') && (claudeOpened || claudeSummary !== null)
  if (!showCodex && !showClaude) return null

  return (
    <div className="flex w-full flex-wrap gap-2 pl-4" role="group" aria-label={`${targetName} 的 CLI 额度`}>
      {showCodex && <QuotaButton agent="codex" summary={codexSummary} level={severity(codex)} onClick={() => setOpen('codex')} />}
      {showClaude && <QuotaButton agent="claude" summary={claudeSummary} level={severity(claude)} onClick={() => setOpen('claude')} />}
      {open && (open === 'codex' ? showCodex : showClaude) && (
        <Dialog title={`${targetName} · ${agentLabel(open)} 额度`} onClose={() => setOpen(null)}>
          {open === 'codex' ? <RateLimitDetails targetId={targetId} available={available} /> : <ClaudeQuotaDetails snapshot={claude} />}
        </Dialog>
      )}
    </div>
  )
}

/** 对话里模型弹层下方的额度区：只看当前目标、当前 Agent，比在连接页单独开入口更贴近使用场景。 */
export function AgentQuota({ targetId, agent }: { targetId: string; agent: string }) {
  const opened = useApp((s) => s.sessions[sessionKey(targetId, 'codex')]?.opened === true)
  const claude = useApp((s) => s.claudeRateLimits[targetId])
  if (agent === 'codex') {
    return (
      <section className="mb-3" aria-label="Codex 额度">
        <div className="qn-label">额度</div>
        <RateLimitDetails targetId={targetId} available={opened} />
      </section>
    )
  }
  if (agent !== 'claude') return null
  return (
    <section className="mb-3 space-y-1 text-sm" aria-label="Claude 额度">
      <div className="qn-label">额度</div>
      <ClaudeQuotaDetails snapshot={claude} />
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
        <span className={toneText(level)}>剩余 {Math.round(remaining)}%</span>
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
            最低剩余 {Math.round(remainingQuotaPercent(tightest))}%
          </Badge>
        )}
        <Button className="ml-auto px-2 py-1 text-xs" onClick={refresh} disabled={!available || loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error && <p className="mb-2 text-xs text-qn-danger">{error}</p>}
      {snapshot?.primary && (
        <WindowRow label={windowLabel(snapshot.primary.windowDurationMins ?? 300)} window={snapshot.primary} now={now} />
      )}
      {snapshot?.secondary && (
        <WindowRow label={windowLabel(snapshot.secondary.windowDurationMins ?? 10080)} window={snapshot.secondary} now={now} />
      )}
      {!snapshot?.primary && !snapshot?.secondary && !loading && !error && (
        <p className="mb-2 text-sm text-qn-muted">暂无额度数据</p>
      )}
      {snapshot?.credits?.hasCredits && (
        <p className="mb-2 text-xs text-qn-muted">积分：{snapshot.credits.unlimited ? '不限量' : (snapshot.credits.balance ?? '有余额')}</p>
      )}
      {(snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true) && (
        <p className="mb-2 text-xs text-qn-danger">已达额度上限{snapshot.rateLimitReachedType ? `（${snapshot.rateLimitReachedType}）` : ''}</p>
      )}
      <div className="mt-2 border-t border-qn-border pt-2 text-[11px] text-qn-muted">
        {account ? (
          <>
            <div>账号：{account.email ?? account.type}</div>
            <div>套餐：{account.planType ?? '—'}</div>
            {account.workspaceName && <div className="break-words">工作区：{account.workspaceName}</div>}
          </>
        ) : (
          <div>账号信息不可用</div>
        )}
        <div>最后更新：{entry?.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString('zh-CN') : '—'}</div>
      </div>
    </div>
  )
}
