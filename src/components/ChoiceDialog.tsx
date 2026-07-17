import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useChoiceStore } from '../store/choiceStore'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'

export default function ChoiceDialog() {
  const { t } = useI18n()
  const request = useChoiceStore(s => s.request)
  const answer = useChoiceStore(s => s.answer)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    primaryRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answer(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, answer])

  if (!request) return null

  return (
    <ModalOverlay onDismiss={() => answer(null)} zIndex="z-[110]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        aria-describedby="choice-message"
        className="relative w-full max-w-[460px] rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex gap-3 px-4 pt-4 pb-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-active text-warn">
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="choice-title" className="text-[14px] font-semibold text-fg">
              {t(request.title)}
            </h2>
            <p id="choice-message" className="mt-1.5 text-[13px] leading-relaxed text-fg">
              {t(request.message)}
            </p>
            {request.detail && (
              <p className="mt-2 text-[12px] leading-relaxed text-fg-muted whitespace-pre-line break-all">
                {request.detail}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          {request.options.map((option, index) => {
            const isPrimary = option.primary || (!request.options.some(o => o.primary) && index === 0)
            return (
              <button
                key={option.id}
                ref={isPrimary ? primaryRef : undefined}
                type="button"
                className={
                  option.danger
                    ? 'px-3 py-1.5 text-[13px] rounded bg-danger/90 hover:bg-danger text-white transition-colors'
                    : isPrimary
                      ? 'px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors'
                      : 'px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors'
                }
                onClick={() => answer(option.id)}
              >
                {t(option.label)}
              </button>
            )
          })}
        </div>
      </div>
    </ModalOverlay>
  )
}
