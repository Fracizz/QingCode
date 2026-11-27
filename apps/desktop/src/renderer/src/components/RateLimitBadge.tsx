import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  t,
  translateMessage,
  claudeQuotaReportedAt,
  claudeQuotaResetAt,
  claudeQuotaSource,
  compactText,
  formatReset,
  claudeHasWindows,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  tightestPercent,
  windowLabel,
  type RateLimitWindow,
} from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import {
  claudeCompactText,
  claudeRateLimitStatus,
  formatCost,
  sumCost,
} from '../lib/claudeUsage'
import {
  severityBarClass,
  severityTextClass,
  updatedAtText,
} from '../lib/rateLimitView'
import { entryFor, type RateLimitEntry } from '../lib/rateLimitsEntry'
import { agentLabel, DEFAULT_AGENT, sessionKey } from '../lib/agents'
import { useCodex } from '../store/codex'
import { RATE_LIMIT_REFRESH_MINUTES, useRateLimits } from '../store/rateLimits'
import { RefreshIcon } from './LoadingIcon'
import { ProgressRing } from './ProgressRing'
import { PopoverContent, PopoverRoot, PopoverTrigger } from './primitives'

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
  const remaining = remainingQuotaPercent(value.usedPercent)
  return (
    <div className="rounded-lg border border-qn-border/70 p-2">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className={`font-mono ${percentClass(value.usedPercent)}`}>
          {t('剩余 {percent}%', { percent: Math.round(remaining) })}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-qn-fg/10">
        <div
          className={`h-full ${severityBarClass(severityForPercent(value.usedPercent))}`}
          style={{ width: `${remaining}%` }}
        />
      </div>
      {value.resetsAt !== null && (
        <div className="mt-1.5 text-ui-sm leading-4 text-qn-muted">
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
}: {
  targetId: string
  agent: AgentKind
  threadId: string | null
  entry: RateLimitEntry | undefined
  now: number
}) {
  const snapshot = entry?.snapshot ?? null
  const liveClaude = claudeHasWindows(snapshot)
  const singleReset = claudeQuotaResetAt(snapshot)
  const reportedAt = claudeQuotaReportedAt(snapshot)
  const source = claudeQuotaSource(snapshot)
  const opened = useCodex((state) => state.sessions[sessionKey(targetId, agent)]?.opened === true)
  const refresh = useRateLimits((s) => s.refresh)

  return (
    <div className="w-80 p-3 text-ui">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">{`${agentLabel(agent)} ${t('额度')}`}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-ui-sm"
            disabled={entry?.loading === true || (agent === 'claude' && !opened)}
            onClick={() => void refresh(targetId, agent)}
          >
            <RefreshIcon size={12} loading={entry?.loading} /> {t('刷新')}
          </button>
        </div>
      </div>

      {agent === 'claude' ? (
        <div className="space-y-2">
          {liveClaude ? (
            <>
              {snapshot?.primary && <WindowRow label={t('5 小时')} value={snapshot.primary} now={now} />}
              {snapshot?.secondary && <WindowRow label={t('每周')} value={snapshot.secondary} now={now} />}
            </>
          ) : (
            <div className="rounded-lg border border-qn-border/70 p-2">
              <div className="flex items-center justify-between">
                <span>{t('额度状态')}</span>
                <span className={percentClass(snapshot?.primary?.usedPercent ?? 0)}>
                  {claudeRateLimitStatus(snapshot)}
                </span>
              </div>
              {singleReset !== null && (
                <div className="mt-1.5 text-ui-sm text-qn-muted">
                  {formatReset(singleReset, now)}
                </div>
              )}
            </div>
          )}
          {source && <p className="text-ui-sm text-qn-muted">{source}</p>}
          <div className="rounded-lg border border-qn-border/70 p-2">
            <div className="flex items-center justify-between">
              <span>{threadId ? t('本会话累计费用') : t('累计费用')}</span>
              <span className="font-mono">
                {t('≈{cost}（估算）', { cost: formatCost(sumCost(entry?.costByThread, threadId)) })}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <>
          {entry?.account && (
            <div className="mb-2 space-y-0.5 rounded-lg bg-qn-inset p-2 text-ui-sm text-qn-muted">
              <div>{t('套餐：{plan}', { plan: entry.account.planType ?? t('未知') })}</div>
              {entry.account.email && <div className="truncate">{t('账号：{email}', { email: entry.account.email })}</div>}
              {entry.account.workspaceName && (
                <div className="truncate">{t('工作区：{name}', { name: entry.account.workspaceName })}</div>
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
            <div className="rounded-lg border border-qn-border/70 p-3 text-center text-qn-muted">
              {t('暂无额度数据')}
            </div>
          )}

          {snapshot?.credits?.hasCredits && (
            <div className="mt-2 text-ui-sm text-qn-muted">
              {t('积分：{balance}', {
                balance: snapshot.credits.unlimited ? t('不限量') : (snapshot.credits.balance ?? t('有余额')),
              })}
            </div>
          )}
          {(snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true) && (
            <div className="mt-2 text-ui-sm text-qn-danger">
              {snapshot.rateLimitReachedType
                ? t('已达额度上限（{type}）', { type: snapshot.rateLimitReachedType })
                : t('已达额度上限')}
            </div>
          )}
        </>
      )}
      {entry?.error && <div className="mt-2 text-ui-sm text-qn-danger">{translateMessage(entry.error)}</div>}

      <div className="mt-3 flex items-center justify-between border-t border-qn-border pt-2 text-ui-sm text-qn-muted">
        <span>{agent === 'claude' ? reportedAt ?? t('暂无上报时间') : updatedAtText(entry?.updatedAt, now)}</span>
        {agent === 'codex' && <span>{t('窗口可见时每 {minutes} 分钟刷新', { minutes: RATE_LIMIT_REFRESH_MINUTES })}</span>}
      </div>
    </div>
  )
}

export function RateLimitDetails({ targetId, agent, threadId }: {
  targetId: string; agent: AgentKind; threadId: string | null
}) {
  const entry = useRateLimits((s) => entryFor(s.byTarget, s.byAgent, targetId, agent))
  return <Body targetId={targetId} agent={agent} threadId={threadId} entry={entry} now={Date.now()} />
}

export function RateLimitBadge({
  targetId,
  agent = DEFAULT_AGENT,
  threadId = null,
  prefix,
}: {
  targetId: string | null
  agent?: AgentKind
  threadId?: string | null
  /** 标题栏胶囊里放在额度前的说明（如目标名）。 */
  prefix?: string
}) {
  const entry = useRateLimits((s) => entryFor(s.byTarget, s.byAgent, targetId, agent))
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return
    // 倒计时与"最后更新"需要在弹层停留时继续走动。
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [open])

  // pi 没有额度接口，不显示徽标也不留空胶囊。
  if (!targetId || agent === 'pi') return null
  const snapshot = entry?.snapshot ?? null
  const level = severity(snapshot)
  const cost = sumCost(entry?.costByThread, threadId)
  const text = agent === 'claude' ? claudeCompactText(snapshot, cost) : compactText(snapshot, 'remaining')
  const used = agent === 'codex' ? tightestPercent(snapshot) : null
  const remaining = used === null ? null : Math.round(remainingQuotaPercent(used))

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(value) => {
        if (value) setNow(Date.now())
        setOpen(value)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex h-6 items-center gap-1.5 rounded-md border border-qn-border-strong bg-qn-fg/[0.03] px-2 text-ui-sm leading-4 hover:bg-qn-hover data-[state=open]:bg-qn-hover ${severityTextClass(level)}`}
          aria-label={t('查看 {agent} 额度详情', { agent: agentLabel(agent) })}
        >
          {remaining !== null && <ProgressRing percent={remaining} size={13} />}
          {prefix && <span className="max-w-[8rem] truncate text-qn-text/85">{prefix}</span>}
          {prefix && <span className="text-qn-dim">·</span>}
          <span>{text}</span>
          <ChevronDown size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Body targetId={targetId} agent={agent} threadId={threadId} entry={entry} now={now} />
      </PopoverContent>
    </PopoverRoot>
  )
}
