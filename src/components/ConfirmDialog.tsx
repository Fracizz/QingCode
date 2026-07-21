import { useEffect, useRef } from 'react'
import { AlertTriangle, Info, Trash2 } from 'lucide-react'
import { useConfirmStore, type ConfirmKind } from '../store/confirmStore'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'

const KIND_META: Record<
  ConfirmKind,
  { icon: typeof AlertTriangle; iconClass: string; confirmClass: string }
> = {
  warning: {
    icon: AlertTriangle,
    iconClass: 'text-warn',
    confirmClass: 'bg-accent hover:bg-accent/90 text-white',
  },
  danger: {
    icon: Trash2,
    iconClass: 'text-danger',
    confirmClass: 'bg-danger/90 hover:bg-danger text-white',
  },
  info: {
    icon: Info,
    iconClass: 'text-accent',
    confirmClass: 'bg-accent hover:bg-accent/90 text-white',
  },
}

export default function ConfirmDialog() {
  const { t } = useI18n()
  const request = useConfirmStore(s => s.request)
  const answer = useConfirmStore(s => s.answer)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answer(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, answer])

  if (!request) return null

  const kind = request.kind ?? 'warning'
  const meta = KIND_META[kind]
  const Icon = meta.icon
  const hasAlt = Boolean(request.altLabel)
  const detailText = request.detail ? t(request.detail) : ''
  // Paths / multi-line dumps keep mono; short prose tips (e.g. busy terminals) use a callout.
  const detailIsTechnical =
    detailText.includes('\n') ||
    /[\\/]/.test(detailText) ||
    detailText.length > 120
  const wide = hasAlt || detailIsTechnical

  return (
    <ModalOverlay onDismiss={() => answer(false)} zIndex="z-[110]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className={`ui-font-scaled modal-content-enter relative w-full rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50 ${
          wide ? 'max-w-[520px]' : 'max-w-[420px]'
        }`}
      >
        <div className="flex gap-3 px-4 pt-4 pb-3">
          <div
            className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-active ${meta.iconClass}`}
          >
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-[14px] font-semibold text-fg">
              {t(request.title)}
            </h2>
            <p id="confirm-message" className="mt-1.5 text-[13px] leading-relaxed text-fg">
              {t(request.message)}
            </p>
            {detailText && (
              <p
                className={
                  detailIsTechnical
                    ? 'mt-2 max-h-[240px] overflow-auto rounded border border-border bg-bg-deep/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-muted whitespace-pre-wrap break-all'
                    : 'mt-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] leading-5 text-fg'
                }
              >
                {detailText}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer(false)}
          >
            {request.cancelLabel ? t(request.cancelLabel) : t('取消')}
          </button>
          {hasAlt && (
            <button
              type="button"
              className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg hover:bg-bg-hover transition-colors"
              onClick={() => answer('alt')}
            >
              {t(request.altLabel!)}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`px-3 py-1.5 text-[13px] rounded transition-colors ${meta.confirmClass}`}
            onClick={() => answer(true)}
          >
            {request.confirmLabel ? t(request.confirmLabel) : t('确定')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
