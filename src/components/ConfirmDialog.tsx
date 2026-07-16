import { useEffect, useRef } from 'react'
import { AlertTriangle, Info, Trash2 } from 'lucide-react'
import { useConfirmStore, type ConfirmKind } from '../store/confirmStore'
import ModalOverlay from './ModalOverlay'

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

  return (
    <ModalOverlay onDismiss={() => answer(false)} zIndex="z-[110]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="relative w-full max-w-[420px] rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex gap-3 px-4 pt-4 pb-3">
          <div
            className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-active ${meta.iconClass}`}
          >
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-[14px] font-semibold text-fg">
              {request.title}
            </h2>
            <p id="confirm-message" className="mt-1.5 text-[13px] leading-relaxed text-fg">
              {request.message}
            </p>
            {request.detail && (
              <p className="mt-2 text-[12px] leading-relaxed text-fg-muted whitespace-pre-line">
                {request.detail}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer(false)}
          >
            {request.cancelLabel ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`px-3 py-1.5 text-[13px] rounded transition-colors ${meta.confirmClass}`}
            onClick={() => answer(true)}
          >
            {request.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
