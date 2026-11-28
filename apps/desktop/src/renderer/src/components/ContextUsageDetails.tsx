import { contextUsageDetails, formatTokenCount, t, type AgentKind, type ThreadView } from '@qn/codex-client'
import { cn } from '../lib/cn'

export function ContextUsageDetails({ thread, agent }: { thread?: ThreadView; agent: AgentKind }) {
  const { overview, recent, tools } = contextUsageDetails(thread?.tokenUsage, agent, thread)
  const percent = overview?.percent ?? 0
  return (
    <div className="space-y-3">
      {overview && (
        <section className="space-y-2" aria-label={t('上下文占用')}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-medium">{t('上下文占用')}
              <span className="ml-2 text-ui-xs font-normal text-qn-muted">tokens</span>
              {overview.estimated && <span className="ml-2 text-ui-xs font-normal text-qn-muted">{t('估算')}</span>}
            </h3>
            <span className={cn('text-ui-lg font-semibold tabular-nums', percent >= 90 ? 'text-qn-quota-danger'
              : percent >= 75 ? 'text-qn-quota-warn' : 'text-qn-text')}>{percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-qn-border-strong" role="progressbar"
            aria-label={t('上下文占用')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className={cn('h-full rounded-full', percent >= 90 ? 'bg-qn-danger' : percent >= 75 ? 'bg-qn-warn' : 'bg-qn-accent')}
              style={{ width: `${percent}%` }} />
          </div>
          <dl className="grid grid-cols-3 gap-3 rounded-lg border border-qn-border px-3 py-2" aria-label="Tokens">
            {overview.stats.map(({ label, count }) => (
              <div key={label} className="min-w-0">
                <dt className="text-ui-xs text-qn-muted">{label}</dt>
                <dd className="font-medium tabular-nums wrap-anywhere">{formatTokenCount(count)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {recent && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="font-medium">{recent.title}</h3>
            <span className="text-ui-xs tabular-nums text-qn-muted">{recent.tokens === null ? 'tokens' : `${formatTokenCount(recent.tokens)} tokens`}</span>
          </div>
          {recent.rows.length > 0 && (
            <dl className="space-y-1">
              {recent.rows.map(({ label, count, included }) => (
                <div key={label} className={cn('flex justify-between gap-3', included && 'pl-3 text-ui-xs text-qn-muted')}>
                  <dt>{label}</dt>
                  <dd className="shrink-0 tabular-nums">{formatTokenCount(count)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
      {tools && (
        <section className="space-y-1.5" aria-label={tools.title}>
          <div className="flex items-baseline justify-between gap-3 font-medium">
            <h3>{tools.title}</h3>
            <span className="tabular-nums">{formatTokenCount(tools.total)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-qn-border px-3 py-2 text-ui-sm">
            {tools.rows.map(({ label, count }, index) => (
              <div key={`${label}-${index}`} className="flex min-w-0 items-baseline justify-between gap-2">
                <dt className="line-clamp-2 min-w-0 wrap-anywhere text-qn-muted" title={label}>{label}</dt>
                <dd className="shrink-0 tabular-nums">{formatTokenCount(count)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {!overview && !recent && !tools && <p className="text-ui-sm text-qn-muted">{t('尚无用量数据')}</p>}
    </div>
  )
}
