import { X } from 'lucide-react'
import {
  compactText,
  formatReset,
  severity,
  severityForPercent,
  tightestPercent,
  windowLabel,
  type RateLimitSnapshot,
  type RateLimitWindow,
} from '@qn/codex-client'
import { useEffect, useState } from 'react'
import { useApp, type RateLimitEntry } from '../store'
import { Badge, Button, Card, Empty } from './ui'

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

export function barWidth(percent: number | null | undefined): number {
  return typeof percent === 'number' && Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0
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
  const level = severity(entry?.snapshot)
  const text = entry?.snapshot ? compactText(entry.snapshot) : '暂无额度数据'
  if (hideWhenEmpty && !entry?.snapshot) return null
  if (!onToggle) return <Badge tone={level === 'ok' ? 'muted' : level}>{text}</Badge>
  return (
    <button type="button" className={`qn-badge qn-badge-button ${toneText(level)}`} onClick={onToggle}>
      {text}
    </button>
  )
}

function WindowRow({ title, window, now }: { title: string; window: RateLimitWindow | null; now: number }) {
  const percent = window?.usedPercent ?? null
  const level = severityForPercent(percent)
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span>
          {title} · {window ? windowLabel(window.windowDurationMins) : '未知窗口'}
        </span>
        <span className={toneText(level)}>{percent === null ? '—' : `${Math.round(percent)}%`}</span>
      </div>
      <div className="qn-bar">
        <div
          className="qn-bar-fill"
          style={{ width: `${barWidth(percent)}%`, background: barColor(level) }}
        />
      </div>
      <div className="mt-1 text-[11px] text-qn-muted">
        {window ? formatReset(window.resetsAt, now) : '暂无数据'}
      </div>
    </div>
  )
}

function snapshotOf(entry: RateLimitEntry | undefined): RateLimitSnapshot | null {
  return entry?.snapshot ?? null
}

export function RateLimitDetails({
  targetId,
  onClose,
}: {
  targetId: string | null
  onClose: () => void
}) {
  const entry = useApp((s) => (targetId ? s.rateLimits[targetId] : undefined))
  const refresh = useApp((s) => s.refreshRateLimits)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const snapshot = snapshotOf(entry)
  const account = entry?.account ?? null
  const level = severity(snapshot)

  return (
    <Card className="mb-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">Codex 额度</span>
        <Badge tone={level === 'ok' ? 'muted' : level}>
          {entry?.loading
            ? '刷新中…'
            : tightestPercent(snapshot) === null
              ? '详情'
              : `最紧张 ${Math.round(tightestPercent(snapshot) ?? 0)}%`}
        </Badge>
        <Button className="px-2 py-1 text-xs" onClick={() => targetId && void refresh(targetId)} disabled={!targetId}>
          刷新
        </Button>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose} aria-label="关闭">
          <X size={15} />
        </Button>
      </div>
      {entry?.error && <p className="mb-2 text-xs text-qn-danger">{entry.error}</p>}
      {!snapshot ? (
        <Empty>codex.open 后会自动读取额度；若目标未登录 Codex，这里保持为空。</Empty>
      ) : (
        <>
          <WindowRow title="主窗口" window={snapshot.primary} now={now} />
          <WindowRow title="次窗口" window={snapshot.secondary} now={now} />
          {snapshot.credits?.hasCredits === true && (
            <p className="mb-2 text-xs text-qn-muted">余额：{snapshot.credits.balance ?? '—'}</p>
          )}
          {snapshot.rateLimitReachedType && (
            <p className="mb-2 text-xs text-qn-danger">已触发限额：{snapshot.rateLimitReachedType}</p>
          )}
        </>
      )}
      <div className="mt-2 border-t border-qn-border pt-2 text-[11px] text-qn-muted">
        {account ? (
          <>
            <div>账号：{account.email ?? account.type}</div>
            <div>套餐：{account.planType ?? '—'}</div>
          </>
        ) : (
          <div>账号信息不可用</div>
        )}
        <div>最后更新：{entry?.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString('zh-CN') : '—'}</div>
      </div>
    </Card>
  )
}
