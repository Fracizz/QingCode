import { contextUsage, estimatedTurnUsage, formatTokens, getLocale, t } from '@qn/codex-client'
import { useState } from 'react'
import { Button, Dialog, LoadingIcon } from './ui'

export function ContextUsage({ tokenUsage, estimatedCostUsd, compact, panel: controlledPanel, onPanelChange }: {
  tokenUsage: unknown
  estimatedCostUsd?: number
  compact?: { busy: boolean; blockedReason: string | null; onConfirm: () => void }
  panel?: 'usage' | 'confirm' | null
  onPanelChange?: (panel: 'usage' | 'confirm' | null) => void
}) {
  const [ownPanel, setOwnPanel] = useState<'usage' | 'confirm' | null>(null)
  const panel = controlledPanel === undefined ? ownPanel : controlledPanel
  const setPanel = onPanelChange ?? setOwnPanel
  const usage = contextUsage(tokenUsage)
  const turn = estimatedTurnUsage(tokenUsage)
  if (!usage && !turn && !compact && estimatedCostUsd == null && !panel) return null

  const percent = usage?.percent ?? 0
  const label = usage ? t('上下文已用 {percent}%', { percent }) : t('暂无上下文用量')
  const sessionUsage = turn !== null || estimatedCostUsd != null
  const color = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-muted'
  const confirming = panel === 'confirm'
  const busy = compact?.busy === true
  return (
    <>
      <Button variant="ghost" className="qn-icon-button px-1!"
        aria-label={busy ? t('正在压缩会话') : sessionUsage ? t('查看会话用量') : t('查看上下文，{label}', { label })}
        aria-haspopup="dialog" onClick={() => setPanel('usage')}>
        {/* 与电脑版输入区的上下文环一致；尚无窗口大小时显示空环，图标不随数据到达而变形。 */}
        <span className={`flex items-center ${color}`} aria-hidden>
          {busy ? <LoadingIcon size={16} /> : <ProgressRing percent={percent} size={16} />}
        </span>
      </Button>
      {panel && (
        <Dialog title={confirming ? t('确认压缩会话') : sessionUsage ? t('会话用量') : t('上下文用量')} onClose={() => setPanel(null)}>
          {confirming && compact ? (
            <>
              <p className="text-sm leading-6 text-qn-muted">{t('压缩会总结较早的对话，让后续回复使用更短的上下文。账号已用额度不会恢复。')}</p>
              {compact.blockedReason && <p className="mt-2 text-sm text-qn-warn">{compact.blockedReason}</p>}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button onClick={() => setPanel('usage')}>{t('取消')}</Button>
                <Button variant="primary" disabled={busy || !!compact.blockedReason} onClick={() => {
                  setPanel(null)
                  compact.onConfirm()
                }}>{t('确认压缩')}</Button>
              </div>
            </>
          ) : (
            <>
              {(usage || compact || !sessionUsage) && <p className={`mb-2 text-sm ${color}`}>{label}</p>}
              {usage && (
                <>
                  <progress className="mb-2 w-full accent-current" aria-label={t('上下文占用')} max={100} value={percent} />
                  <p className="text-sm text-qn-muted">{formatTokens(usage.used)} / {formatTokens(usage.window)} tokens</p>
                </>
              )}
              {turn && (
                <div className="space-y-1 text-sm">
                  <p>{t('最近上报的单轮用量')}</p>
                  {turn.tokens !== null && <p className="text-qn-muted">{formatTokens(turn.tokens)} tokens</p>}
                  {turn.costUsd !== null && <p className="text-qn-muted">{t('费用估算 {cost}', { cost: formatCost(turn.costUsd) })}</p>}
                </div>
              )}
              {estimatedCostUsd != null && (
                <p className="mt-2 text-sm text-qn-muted">
                  {t('本设备已收到的会话费用估算')} {formatCost(estimatedCostUsd)}
                </p>
              )}
              {compact && (
                <div className="mt-4 grid gap-2">
                  <Button disabled={busy || !!compact.blockedReason} onClick={() => setPanel('confirm')}>
                    {busy ? t('正在压缩会话…') : t('压缩会话')}
                  </Button>
                  {!busy && compact.blockedReason && <p className="text-xs text-qn-muted">{compact.blockedReason}</p>}
                </div>
              )}
            </>
          )}
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
