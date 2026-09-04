import { AlertTriangle, Info, Trash2 } from 'lucide-react'
import { useConfirmStore, type ConfirmKind } from '../store/confirmStore'
import ModalOverlay, { INTERRUPT_MODAL_Z } from './ModalOverlay'
import { useI18n } from '../lib/i18n'

const KIND_META: Record<
  ConfirmKind,
  { icon: typeof AlertTriangle; iconClass: string; confirmClass: string }
> = {
  warning: {
    icon: AlertTriangle,
    iconClass: 'text-warn bg-warn/10',
    confirmClass: 'bg-accent hover:bg-accent/90 text-white shadow-sm hover:-translate-y-[0.5px] active:translate-y-0',
  },
  danger: {
    icon: Trash2,
    iconClass: 'text-danger bg-danger/10',
    confirmClass: 'bg-danger/90 hover:bg-danger text-white shadow-sm hover:-translate-y-[0.5px] active:translate-y-0',
  },
  info: {
    icon: Info,
    iconClass: 'text-accent bg-accent/10',
    confirmClass: 'bg-accent hover:bg-accent/90 text-white shadow-sm hover:-translate-y-[0.5px] active:translate-y-0',
  },
}

export default function ConfirmDialog() {
  const { t } = useI18n()
  const request = useConfirmStore(s => s.request)
  const answer = useConfirmStore(s => s.answer)
  if (!request) return null

  const kind = request.kind ?? 'warning'
  const meta = KIND_META[kind]
  const Icon = meta.icon
  const hasAlt = Boolean(request.altLabel)
  const detailText = request.detail ? t(request.detail) : ''
  // Paths / multi-line dumps keep mono; short prose tips (e.g. busy terminals) use a callout.
  const detailIsTechnical =
    detailText.includes('\n') || /[\\/]/.test(detailText) || detailText.length > 120
  const wide = hasAlt || detailIsTechnical

  return (
    <ModalOverlay onDismiss={() => answer(false)} zIndex={INTERRUPT_MODAL_Z}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className={`ui-font-scaled modal-content-enter relative w-full rounded-lg border border-border-strong bg-bg-elevated shadow-elevation-3 ${
          wide ? 'max-w-[520px]' : 'max-w-[420px]'
        }`}
      >
        <div className="flex gap-3.5 px-5 pt-5 pb-4">
          <div
            className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border/60 ${meta.iconClass}`}
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
                    ? 'text-ui-sm mt-2.5 max-h-[240px] overflow-auto rounded-md border border-border bg-bg-deep/70 px-2.5 py-2 font-mono leading-relaxed text-fg-muted whitespace-pre-wrap break-all'
                    : 'text-ui-sm mt-2.5 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 leading-5 text-fg'
                }
              >
                {detailText}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3.5 bg-bg-deep/20 rounded-b-lg">
          <button
            type="button"
            data-modal-autofocus
            className="px-3.5 py-1.5 text-[13px] font-medium rounded-md border border-border-strong bg-bg text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer(false)}
          >
            {request.cancelLabel ? t(request.cancelLabel) : t('取消')}
          </button>
          {hasAlt && (
            <button
              type="button"
              className="px-3.5 py-1.5 text-[13px] font-medium rounded-md border border-border-strong bg-bg text-fg hover:bg-bg-hover transition-colors"
              onClick={() => answer('alt')}
            >
              {t(request.altLabel!)}
            </button>
          )}
          <button
            type="button"
            className={`px-3.5 py-1.5 text-[13px] font-medium rounded-md transition-all duration-150 ${meta.confirmClass}`}
            onClick={() => answer(true)}
          >
            {request.confirmLabel ? t(request.confirmLabel) : t('确定')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
