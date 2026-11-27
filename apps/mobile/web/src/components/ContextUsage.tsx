import { contextUsage, formatTokens, getLocale, t } from '@qn/codex-client'
import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { Button, Dialog, LoadingIcon } from './ui'

export function ContextUsage({ tokenUsage, estimatedCostUsd, compact }: {
  tokenUsage: unknown
  estimatedCostUsd?: number
  compact?: { busy: boolean; blockedReason: string | null; onConfirm: () => void }
}) {
  const [panel, setPanel] = useState<'usage' | 'confirm' | null>(null)
  const usage = contextUsage(tokenUsage)
  if (!usage && !compact && estimatedCostUsd == null) return null

  const percent = usage?.percent ?? 0
  const label = usage ? t('上下文已用 {percent}%', { percent }) : t('暂无上下文用量')
  const color = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-muted'
  const confirming = panel === 'confirm'
  const busy = compact?.busy === true
  return (
    <>
      <Button variant="ghost" className="qn-icon-button px-1!"
        aria-label={busy ? t('正在压缩会话') : estimatedCostUsd != null ? t('查看会话用量') : t('查看上下文，{label}', { label })}
        aria-haspopup="dialog" onClick={() => setPanel('usage')}>
        <span className={`flex items-center gap-1 text-[11px] ${color}`} aria-hidden>
          {busy ? <LoadingIcon size={16} /> : <Gauge size={16} />}
          {usage && `${percent}%`}
        </span>
      </Button>
      {panel && (
        <Dialog title={confirming ? t('确认压缩会话') : estimatedCostUsd != null ? t('会话用量') : t('上下文用量')} onClose={() => setPanel(null)}>
          {confirming && compact ? (
            <>
              <p className="text-sm leading-6 text-qn-muted">{t('Codex 会总结较早的对话，让后续回复使用更短的上下文。')}</p>
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
              {(usage || compact) && <p className={`mb-2 text-sm ${color}`}>{label}</p>}
              {usage && (
                <>
                  <progress className="mb-2 w-full accent-current" aria-label={t('上下文占用')} max={100} value={percent} />
                  <p className="text-sm text-qn-muted">{formatTokens(usage.used)} / {formatTokens(usage.window)} tokens</p>
                </>
              )}
              {estimatedCostUsd != null && (
                <p className="mt-2 text-sm text-qn-muted">
                  {t('本设备已收到的会话费用估算')} {new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(estimatedCostUsd)}
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
