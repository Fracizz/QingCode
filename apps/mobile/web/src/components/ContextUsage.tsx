import { contextUsage, contextUsageDetails, estimatedTurnUsage, formatTokenCount, t, type AgentKind, type ThreadView } from '@qn/codex-client'
import { useState } from 'react'
import { Button, Dialog, LoadingIcon } from './ui'

export function ContextUsage({ tokenUsage, agent, thread, compact, panel: controlledPanel, onPanelChange }: {
  tokenUsage: unknown
  agent: AgentKind
  thread?: ThreadView
  /** 压缩不再二次确认：点按钮即关闭面板并开始压缩。 */
  compact?: { busy: boolean; blockedReason: string | null; willQueue?: boolean; onCompact: () => void }
  panel?: 'usage' | null
  onPanelChange?: (panel: 'usage' | null) => void
}) {
  const [ownPanel, setOwnPanel] = useState<'usage' | null>(null)
  const panel = controlledPanel === undefined ? ownPanel : controlledPanel
  const setPanel = onPanelChange ?? setOwnPanel
  const usage = contextUsage(tokenUsage)
  const turn = estimatedTurnUsage(tokenUsage)
  if (!usage && !turn && !compact && !panel) return null

  const percent = usage?.percent ?? 0
  const label = usage ? t('上下文已用 {percent}%', { percent }) : t('暂无上下文用量')
  const sessionUsage = turn !== null
  const color = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-muted'
  // 进度条正常时用品牌色，接近上限才换成警示色。
  const meterColor = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-accent'
  const busy = compact?.busy === true
  const details = panel ? contextUsageDetails(tokenUsage, agent, thread) : null
  return (
    <>
      <Button variant="ghost" className="qn-icon-button"
        aria-label={busy ? t('正在压缩会话') : !usage && sessionUsage ? t('查看会话用量') : t('查看上下文，{label}', { label })}
        aria-haspopup="dialog" onClick={() => setPanel('usage')}>
        {/* 与电脑版使用相同环径，压缩时把加载图标放在同一位置。 */}
        <span className={`relative grid size-[26px] shrink-0 place-items-center ${color}`} aria-hidden>
          {busy ? <LoadingIcon size={18} /> : (
            <>
              <ProgressRing percent={percent} />
              {usage && (
                <span className="absolute inset-0 grid place-items-center text-2xs leading-none font-medium tabular-nums">
                  {percent}
                </span>
              )}
            </>
          )}
        </span>
      </Button>
      {details && (
        <Dialog title={t('会话用量')} onClose={() => setPanel(null)}>
          <div className="qn-ctx-sheet">
            {details.overview && (
              <section className="qn-ctx" aria-label={t('上下文占用')}>
                <div className="qn-ctx-head">
                  <h3>{t('上下文占用')}
                    <span className="ml-2 text-xs font-normal text-qn-muted">tokens</span>
                    {details.overview.estimated && <span className="ml-2 text-xs font-normal text-qn-muted">{t('估算')}</span>}
                  </h3>
                  <span className={`shrink-0 tabular-nums ${percent >= 75 ? color : ''}`}>{percent}%</span>
                </div>
                <progress className={`qn-meter ${meterColor}`} aria-label={label} max={100} value={percent} />
                <dl className="qn-settings-group grid grid-cols-3 gap-2 px-3 py-2" aria-label="Tokens">
                  {details.overview.stats.map(({ label, count }) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-xs text-qn-muted">{label}</dt>
                      <dd className="text-sm font-medium tabular-nums wrap-anywhere">{formatTokenCount(count)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {details.recent && (
              <section className="space-y-1.5">
                <div className="qn-ctx-head flex-wrap">
                  <h3>{details.recent.title}</h3>
                  <span className="text-xs font-normal tabular-nums text-qn-muted">
                    {details.recent.tokens === null ? 'tokens' : `${formatTokenCount(details.recent.tokens)} tokens`}
                  </span>
                </div>
                {details.recent.rows.length > 0 && (
                  <dl className="qn-settings-group space-y-1 px-3 py-2">
                    {details.recent.rows.map(({ label, count, included }) => (
                      <div key={label} className={`flex justify-between gap-3 ${included ? 'pl-3 text-xs text-qn-muted' : 'text-sm'}`}>
                        <dt>{label}</dt>
                        <dd className="shrink-0 tabular-nums">{formatTokenCount(count)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            )}
            {details.tools && (
              <section className="space-y-1.5" aria-label={details.tools.title}>
                <div className="qn-ctx-head">
                  <h3>{details.tools.title}</h3>
                  <span className="tabular-nums">{formatTokenCount(details.tools.total)}</span>
                </div>
                <dl className="qn-settings-group grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-xs">
                  {details.tools.rows.map(({ label, count }, index) => (
                    <div key={`${label}-${index}`} className="flex min-w-0 items-baseline justify-between gap-2">
                      <dt className="line-clamp-2 min-w-0 wrap-anywhere text-qn-muted" title={label}>{label}</dt>
                      <dd className="shrink-0 tabular-nums">{formatTokenCount(count)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {!details.overview && !details.recent && !details.tools && (
              <p className="qn-ctx-note">{t('尚无用量数据')}</p>
            )}
            {compact && (
              <div className="grid gap-2">
                <Button disabled={busy || !!compact.blockedReason} onClick={() => {
                  setPanel(null)
                  compact.onCompact()
                }}>
                  {busy ? t('正在压缩会话…') : compact.willQueue ? t('排队压缩') : t('压缩会话')}
                </Button>
                <p className="qn-ctx-note">
                  {!busy && compact.blockedReason ? compact.blockedReason
                    : !busy && compact.willQueue ? t('当前一轮和已排队的内容处理完后开始压缩。')
                    : t('压缩会总结较早的对话，让后续回复使用更短的上下文。账号已用额度不会恢复。')}
                </p>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}

/** 描边向内加粗，外径保持 26px。 */
function ProgressRing({ percent }: { percent: number }) {
  const strokeWidth = 2.5
  const radius = 13 - strokeWidth / 2
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" className="-rotate-90" data-testid="context-ring"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <circle cx="13" cy="13" r={radius} opacity="0.25" />
      <circle cx="13" cy="13" r={radius} pathLength="100" strokeDasharray={`${percent} 100`} />
    </svg>
  )
}
