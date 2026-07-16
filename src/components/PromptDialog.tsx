import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { usePromptStore } from '../store/promptStore'
import ModalOverlay from './ModalOverlay'

export default function PromptDialog() {
  const request = usePromptStore(s => s.request)
  const answer = usePromptStore(s => s.answer)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!request) return
    setValue(request.defaultValue ?? '')
    setError(null)
    const t = window.setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    }, 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answer(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKeyDown)
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
      setError('不能为空')
      inputRef.current?.focus()
      return
    }
    answer(trimmed)
  }

  return (
    <ModalOverlay onDismiss={() => answer(null)} zIndex="z-[110]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        className="relative w-full max-w-[420px] rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex gap-3 px-4 pt-4 pb-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-active text-accent">
            <Pencil size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="prompt-title" className="text-[14px] font-semibold text-fg">
              {request.title}
            </h2>
            {request.message && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{request.message}</p>
            )}
            <input
              ref={inputRef}
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
              placeholder={request.placeholder}
              className={`mt-3 w-full rounded border bg-bg px-2.5 py-2 text-[13px] text-fg outline-none transition-colors
                ${error ? 'border-danger' : 'border-border-strong focus:border-accent'}`}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'prompt-error' : undefined}
            />
            {error && (
              <p id="prompt-error" className="mt-1.5 text-[12px] text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer(null)}
          >
            {request.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors"
            onClick={submit}
          >
            {request.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
