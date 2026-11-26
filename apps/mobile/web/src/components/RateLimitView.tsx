import {
  compactText,
  formatReset,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  tightestPercent,
  windowLabel,
  type RateLimitWindow,
} from '@qn/codex-client'
import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { Badge, Button } from './ui'

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

export function RateLimitBadge({
  targetId,
  onToggle,
  hideWhenEmpty = false,
}: {
  targetId: string | null
  onToggle?: () => void
  hideWhenEmpty?: boolean
}) {
  const entry = useApp((s) => (targetId ? s.rateLimits[targetId] : undefined))
  const snapshot = entry?.snapshot
  const level = severity(snapshot)
  const hasWindow = Boolean(snapshot?.primary || snapshot?.secondary)
  const reached = snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true
  if (!targetId || (hideWhenEmpty && !hasWindow && !reached)) return null
  const text = hasWindow ? compactText(snapshot, 'remaining') : reached ? '已达额度上限' : '额度'
  if (!onToggle) return <Badge tone={level === 'ok' ? 'muted' : level}>{text}</Badge>
  return (
    <button type="button" className={`qn-badge qn-badge-button ${toneText(level)}`} onClick={onToggle}
      aria-label={`Codex 额度详情，${hasWindow || reached ? text : '暂无额度数据'}`}>
      {text}
    </button>
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

export function RateLimitDetails({ targetId }: { targetId: string | null }) {
  const entry = useApp((s) => (targetId ? s.rateLimits[targetId] : undefined))
  const refresh = useApp((s) => s.refreshRateLimits)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const snapshot = entry?.snapshot
  const account = entry?.account ?? null
  const level = severity(snapshot)
  const tightest = tightestPercent(snapshot)

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        {tightest !== null && (
          <Badge tone={level === 'ok' ? 'muted' : level}>
            最低剩余 {Math.round(remainingQuotaPercent(tightest))}%
          </Badge>
        )}
        <Button className="ml-auto px-2 py-1 text-xs" onClick={() => targetId && void refresh(targetId)} disabled={!targetId || entry?.loading}>
          {entry?.loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {entry?.error && <p className="mb-2 text-xs text-qn-danger">{entry.error}</p>}
      {snapshot?.primary && (
        <WindowRow label={windowLabel(snapshot.primary.windowDurationMins ?? 300)} window={snapshot.primary} now={now} />
      )}
      {snapshot?.secondary && (
        <WindowRow label={windowLabel(snapshot.secondary.windowDurationMins ?? 10080)} window={snapshot.secondary} now={now} />
      )}
      {!snapshot?.primary && !snapshot?.secondary && !entry?.loading && !entry?.error && (
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
