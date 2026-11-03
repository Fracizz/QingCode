import { AlertCircle, CheckCircle2, LoaderCircle } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n'

export default function ServerOperationProgress({ name, status, label, step, startedAt, finishedAt, error, actions, compact = false }: {
  name: string
  status: string
  label: string
  step: number
  startedAt: number
  finishedAt?: number
  error?: string
  actions?: ReactNode
  compact?: boolean
}) {
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (finishedAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [finishedAt])
  const elapsed = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1000))
  const complete = Boolean(finishedAt && !error)
  const active = Math.min(4, Math.max(1, step))
  return (
    <section className={`server-operation-card w-full min-w-0 ${compact ? 'rounded-lg border border-dialog-border bg-dialog-sidebar p-3 text-ui-sm' : 'rounded-xl border border-border-strong bg-bg-elevated p-4 text-ui shadow-elevation-3'}`} aria-label={name} style={{ '--server-operation-accent': 'color-mix(in srgb, var(--color-accent) 65%, var(--color-fg))' } as CSSProperties}>
      <div className={compact ? 'sr-only' : 'flex items-center justify-between gap-3 border-b border-border pb-3'}>
        <span className="min-w-0 truncate font-medium text-fg">{name}</span>
        <span className={`shrink-0 text-ui-sm ${error ? 'text-danger' : complete ? 'text-ok' : 'text-[var(--server-operation-accent)]'}`}>{t(error ? '需要处理' : complete ? '已完成' : status)}</span>
      </div>
      <div className={compact ? '' : `mt-3 rounded-lg p-3 ${error ? 'bg-danger/10' : 'bg-accent/10'}`}>
        <div role="status" aria-live="polite" className={`flex items-center gap-2 ${error ? 'text-danger' : 'text-[var(--server-operation-accent)]'}`}>
          {error ? <AlertCircle size={16} className="shrink-0" aria-hidden /> : complete ? <CheckCircle2 size={16} className="shrink-0" aria-hidden /> : <LoaderCircle size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
          <span className="min-w-0 break-words">{t(complete ? 'Server 已就绪' : label)}</span>
        </div>
        <div role="progressbar" aria-label={t('Server 安装与更新进度')} aria-valuemin={0} aria-valuemax={4} aria-valuenow={complete ? 4 : active - 1} aria-valuetext={t('第 {step}/4 步', { step: String(active) })} className="mt-3 flex gap-1.5">
          {[1, 2, 3, 4].map(index => <span key={index} className={`h-1.5 flex-1 rounded-full ${complete || index < active ? 'bg-[var(--server-operation-accent)]' : index === active ? 'bg-[var(--server-operation-accent)]/70' : 'bg-fg-muted/20'}`} />)}
        </div>
        <p className="mt-2 text-ui-sm text-fg-muted" aria-live="off">{t('第 {step}/4 步 · 已用 {seconds} 秒', { step: String(complete ? 4 : active), seconds: String(elapsed) })}</p>
        {error && <p role="alert" className="mt-2 max-h-32 select-text overflow-y-auto whitespace-pre-wrap break-words text-ui-sm text-danger">{error}</p>}
      </div>
      {actions && <div className="mt-3 flex justify-end gap-2">{actions}</div>}
    </section>
  )
}
