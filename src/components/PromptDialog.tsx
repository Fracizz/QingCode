import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { usePromptStore } from '../store/promptStore'
import ModalOverlay, { INTERRUPT_MODAL_Z } from './ModalOverlay'
import { useI18n } from '../lib/i18n'

export default function PromptDialog() {
  const { t } = useI18n()
  const request = usePromptStore(s => s.request)
  const answer = usePromptStore(s => s.answer)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!request) return
    queueMicrotask(() => {
      setValue(request.defaultValue ?? '')
      setError(null)
    })
    const t = window.setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    }, 0)
    return () => {
      window.clearTimeout(t)
    }
  }, [request, answer])

  if (!request) return null

  const submit = () => {
    const trimmed = value.trim()
    const validate = request.validate
    if (validate) {
      const message = validate(trimmed)
      if (message) {
        setError(message)
        inputRef.current?.focus()
        return
      }
    } else if (!trimmed) {
      setError(t('不能为空'))
      inputRef.current?.focus()
      return
    }
    answer(trimmed)
  }

  return (
    <ModalOverlay onDismiss={() => answer(null)} zIndex={INTERRUPT_MODAL_Z}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        className="modal-content-enter relative w-full max-w-[420px] rounded-lg border border-border-strong bg-bg-elevated shadow-elevation-3"
      >
        <div className="flex gap-3.5 px-5 pt-5 pb-4">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border/60 bg-accent/10 text-accent">
            <Pencil size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="prompt-title" className="text-[14px] font-semibold text-fg">
              {t(request.title)}
            </h2>
            {request.message && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
                {t(request.message)}
              </p>
            )}
            <input
              ref={inputRef}
              data-modal-autofocus
              type="text"
              value={value}
              onChange={event => {
                setValue(event.target.value)
                if (error) setError(null)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder={request.placeholder ? t(request.placeholder) : undefined}
              className={`modal-field-input mt-3 ${error ? 'modal-field-input--invalid' : ''}`}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'prompt-error' : undefined}
            />
            {error && (
              <p id="prompt-error" className="text-ui-sm mt-1.5 text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5 bg-bg-deep/20 rounded-b-lg">
          <button
            type="button"
            className="px-3.5 py-1.5 text-[13px] font-medium rounded-md border border-border-strong bg-bg text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer(null)}
          >
            {request.cancelLabel ? t(request.cancelLabel) : t('取消')}
          </button>
          <button
            type="button"
            className="px-3.5 py-1.5 text-[13px] font-medium rounded-md bg-accent hover:bg-accent/90 text-white shadow-sm transition-all duration-150 hover:-translate-y-[0.5px] active:translate-y-0"
            onClick={submit}
          >
            {request.confirmLabel ? t(request.confirmLabel) : t('确定')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
