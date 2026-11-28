import { contextUsage, estimatedTurnUsage, formatTokens, getLocale, t } from '@qn/codex-client'
import { useState } from 'react'
import { Button, Dialog, LoadingIcon } from './ui'

export function ContextUsage({ tokenUsage, estimatedCostUsd, compact, panel: controlledPanel, onPanelChange }: {
  tokenUsage: unknown
  estimatedCostUsd?: number
  /** 压缩不再二次确认：点按钮即关闭面板并开始压缩。 */
  compact?: { busy: boolean; blockedReason: string | null; onCompact: () => void }
  panel?: 'usage' | null
  onPanelChange?: (panel: 'usage' | null) => void
}) {
  const [ownPanel, setOwnPanel] = useState<'usage' | null>(null)
  const panel = controlledPanel === undefined ? ownPanel : controlledPanel
  const setPanel = onPanelChange ?? setOwnPanel
  const usage = contextUsage(tokenUsage)
  const turn = estimatedTurnUsage(tokenUsage)
  if (!usage && !turn && !compact && estimatedCostUsd == null && !panel) return null

  const percent = usage?.percent ?? 0
  const label = usage ? t('上下文已用 {percent}%', { percent }) : t('暂无上下文用量')
  const sessionUsage = turn !== null || estimatedCostUsd != null
  const color = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-muted'
  // 进度条正常时用品牌色，接近上限才换成警示色。
  const meterColor = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-accent'
  const busy = compact?.busy === true
  const stats: { label: string; value: string }[] = []
  if (turn?.tokens != null) stats.push({ label: t('最近上报的单轮用量'), value: `${formatTokens(turn.tokens)} tokens` })
  if (turn?.costUsd != null) stats.push({ label: t('单轮费用估算'), value: formatCost(turn.costUsd) })
  if (estimatedCostUsd != null) stats.push({ label: t('本设备已收到的会话费用估算'), value: formatCost(estimatedCostUsd) })
  return (
    <>
      <Button variant="ghost" className="qn-icon-button px-1!"
        aria-label={busy ? t('正在压缩会话') : sessionUsage ? t('查看会话用量') : t('查看上下文，{label}', { label })}
        aria-haspopup="dialog" onClick={() => setPanel('usage')}>
        {/* 与电脑版输入区的上下文环一致；尚无窗口大小时显示空环，图标不随数据到达而变形。 */}
        <span className={`flex items-center ${color}`} aria-hidden>
          {busy ? <LoadingIcon size={18} /> : <ProgressRing percent={percent} size={18} />}
        </span>
      </Button>
      {panel && (
        <Dialog title={sessionUsage ? t('会话用量') : t('上下文用量')} onClose={() => setPanel(null)}>
          <div className="qn-ctx-sheet">
            {(usage || compact || !sessionUsage) && (
              <section className="qn-ctx" aria-label={t('上下文占用')}>
                {usage ? (
                  <>
                    <div className="qn-ctx-head">
                      <span>{t('上下文')}</span>
                      <span className={`tabular-nums ${percent >= 75 ? color : ''}`}>{percent}%</span>
                    </div>
                    <progress className={`qn-meter ${meterColor}`} aria-label={label} max={100} value={percent} />
                    <p className="qn-ctx-foot">{formatTokens(usage.used)} / {formatTokens(usage.window)} tokens</p>
                  </>
                ) : <p className="qn-ctx-foot">{label}</p>}
              </section>
            )}
            {stats.length > 0 && (
              <dl className="qn-settings-group">
                {stats.map((stat) => (
                  <div key={stat.label} className="qn-setting-row qn-ctx-stat">
                    <dt className="qn-setting-text">{stat.label}</dt>
                    <dd className="qn-setting-value">{stat.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {compact && (
              <div className="grid gap-2">
                <Button disabled={busy || !!compact.blockedReason} onClick={() => {
                  setPanel(null)
                  compact.onCompact()
                }}>
                  {busy ? t('正在压缩会话…') : t('压缩会话')}
                </Button>
                <p className="qn-ctx-note">
                  {!busy && compact.blockedReason ? compact.blockedReason : t('压缩会总结较早的对话，让后续回复使用更短的上下文。账号已用额度不会恢复。')}
                </p>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}

/** 与电脑版 ProgressRing 相同的占用环，颜色跟随文字色。 */
function ProgressRing({ percent, size }: { percent: number; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 13 13" className="shrink-0 -rotate-90" data-testid="context-ring">
      <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <circle cx="6.5" cy="6.5" r="5" pathLength="100" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeDasharray={`${percent} 100`} />
    </svg>
  )
}

function formatCost(usd: number): string {
  return new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(usd)
}
