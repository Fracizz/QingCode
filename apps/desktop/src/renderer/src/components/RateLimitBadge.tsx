import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Gauge, RefreshCw, X } from 'lucide-react'
import {
  compactText,
  formatReset,
  severity,
  severityForPercent,
  windowLabel,
  type RateLimitWindow,
} from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import {
  CLAUDE_RATE_LIMIT_NOTE,
  claudeCompactText,
  claudeRateLimitStatus,
  formatCost,
  sumCost,
} from '../lib/claudeUsage'
import {
  barWidth,
  severityBarClass,
  severityTextClass,
  updatedAtText,
} from '../lib/rateLimitView'
import { entryFor, type RateLimitEntry } from '../lib/rateLimitsEntry'
import { agentLabel, DEFAULT_AGENT } from '../lib/agents'
import { useRateLimits } from '../store/rateLimits'

function percentClass(percent: number): string {
  const level = severityForPercent(percent)
  if (level === 'danger') return 'text-qn-danger'
  if (level === 'warn') return 'text-amber-300'
  return ''
}

function WindowRow({
  label,
  value,
  now,
}: {
  label: string
  value: RateLimitWindow
  now: number
}) {
  return (
    <div className="rounded border border-qn-border/70 p-2">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className={`font-mono ${percentClass(value.usedPercent)}`}>
          {Math.round(value.usedPercent)}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-white/10">
        <div
          className={`h-full ${severityBarClass(severityForPercent(value.usedPercent))}`}
          style={{ width: `${barWidth(value.usedPercent)}%` }}
        />
      </div>
      {value.resetsAt !== null && (
        <div className="mt-1.5 text-[11px] leading-4 text-qn-muted">
          {formatReset(value.resetsAt, now)}
        </div>
      )}
    </div>
  )
}

function Body({
  targetId,
  agent,
  threadId,
  entry,
  now,
  onClose,
}: {
  targetId: string
  agent: AgentKind
  threadId: string | null
  entry: RateLimitEntry | undefined
  now: number
  onClose: () => void
}) {
  const snapshot = entry?.snapshot ?? null
  const refresh = useRateLimits((s) => s.refresh)

  return (
    <div className="absolute right-0 top-9 z-40 w-80 rounded-lg border border-qn-border bg-qn-panel p-3 text-xs shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">{agentLabel(agent)} 额度</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-[11px]"
            disabled={entry?.loading === true}
            onClick={() => void refresh(targetId, agent)}
            title="刷新额度"
          >
            <RefreshCw size={12} className={entry?.loading ? 'animate-spin' : ''} /> 刷新
          </button>
          <button
            type="button"
            className="rounded p-1 text-qn-muted hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="关闭额度详情"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {agent === 'claude' ? (
        <div className="space-y-2">
          <div className="rounded border border-qn-border/70 p-2">
            <div className="flex items-center justify-between">
              <span>最近限额事件</span>
              <span className={percentClass(snapshot?.primary?.usedPercent ?? 0)}>
                {claudeRateLimitStatus(snapshot)}
              </span>
            </div>
            {snapshot?.primary?.resetsAt !== null && snapshot?.primary?.resetsAt !== undefined && (
              <div className="mt-1.5 text-[11px] text-qn-muted">
                {formatReset(snapshot.primary.resetsAt, now)}
              </div>
            )}
          </div>
          <div className="rounded border border-qn-border/70 p-2">
            <div className="flex items-center justify-between">
              <span>{threadId ? '本会话累计费用' : '累计费用'}</span>
              <span className="font-mono">
                ≈{formatCost(sumCost(entry?.costByThread, threadId))}（估算）
              </span>
            </div>
            <div className="mt-1 text-[11px] text-qn-muted">{CLAUDE_RATE_LIMIT_NOTE}</div>
          </div>
        </div>
      ) : (
        <>
          {entry?.account && (
            <div className="mb-2 space-y-0.5 rounded bg-black/20 p-2 text-[11px] text-qn-muted">
              <div>套餐：{entry.account.planType ?? '未知'}</div>
              {entry.account.email && <div className="truncate">账号：{entry.account.email}</div>}
              {entry.account.workspaceName && (
                <div className="truncate">工作区：{entry.account.workspaceName}</div>
              )}
            </div>
          )}

          {snapshot?.primary || snapshot?.secondary ? (
            <div className="space-y-2">
              {snapshot.primary && (
                <WindowRow
                  label={windowLabel(snapshot.primary.windowDurationMins ?? 300)}
                  value={snapshot.primary}
                  now={now}
                />
              )}
              {snapshot.secondary && (
                <WindowRow
                  label={windowLabel(snapshot.secondary.windowDurationMins ?? 10080)}
                  value={snapshot.secondary}
                  now={now}
                />
              )}
            </div>
          ) : (
            <div className="rounded border border-qn-border/70 p-3 text-center text-qn-muted">
              暂无额度数据
            </div>
          )}

          {snapshot?.credits?.hasCredits && (
            <div className="mt-2 text-[11px] text-qn-muted">
              积分：{snapshot.credits.unlimited ? '不限量' : (snapshot.credits.balance ?? '有余额')}
            </div>
          )}
          {(snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true) && (
            <div className="mt-2 text-[11px] text-qn-danger">
              已达额度上限{snapshot.rateLimitReachedType ? `（${snapshot.rateLimitReachedType}）` : ''}
            </div>
          )}
        </>
      )}
      {entry?.error && <div className="mt-2 text-[11px] text-qn-danger">{entry.error}</div>}

      <div className="mt-3 flex items-center justify-between border-t border-qn-border pt-2 text-[11px] text-qn-muted">
        <span>{updatedAtText(entry?.updatedAt, now)}</span>
        <span>可见时每 60 秒刷新</span>
      </div>
    </div>
  )
}

export function RateLimitBadge({
  targetId,
  agent = DEFAULT_AGENT,
  threadId = null,
}: {
  targetId: string | null
  agent?: AgentKind
  threadId?: string | null
}) {
  const entry = useRateLimits((s) => entryFor(s.byTarget, s.byAgent, targetId, agent))
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return
    // 倒计时与"最后更新"需要在弹层停留时继续走动。
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      clearInterval(timer)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!targetId) return null
  const snapshot = entry?.snapshot ?? null
  const level = severity(snapshot)
  const cost = sumCost(entry?.costByThread, threadId)
  const text = agent === 'claude' ? claudeCompactText(snapshot, cost) : compactText(snapshot)

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] leading-4 hover:bg-white/5 ${severityTextClass(level)}`}
        onClick={() => {
          setNow(Date.now())
          setOpen((value) => !value)
        }}
        title={`查看 ${agentLabel(agent)} 额度详情`}
      >
        <Gauge size={12} />
        <span>{text}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <Body
          targetId={targetId}
          agent={agent}
          threadId={threadId}
          entry={entry}
          now={now}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
