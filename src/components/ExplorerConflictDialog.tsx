import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useExplorerConflictStore } from '../store/explorerConflictStore'
import { validateEntryName } from '../store/promptStore'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'

/** IDEA-style name-conflict dialog with an inline rename field. */
export default function ExplorerConflictDialog() {
  const { t } = useI18n()
  const request = useExplorerConflictStore(s => s.request)
  const answer = useExplorerConflictStore(s => s.answer)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!request) return
    setValue(request.defaultName)
    setError(null)
    const timer = window.setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      const dot = request.defaultName.lastIndexOf('.')
      const end = dot > 0 ? dot : request.defaultName.length
      input.setSelectionRange(0, end)
    }, 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answer({ action: 'cancel' })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [request, answer])

  if (!request) return null

  const submitRename = () => {
    const trimmed = value.trim()
    const validation = validateEntryName(trimmed)
    if (validation) {
      setError(t(validation))
      inputRef.current?.focus()
      return
    }
    if (trimmed === request.originalName) {
      setError(t('请输入新名称，或选择覆盖'))
      inputRef.current?.focus()
      return
    }
    answer({ action: 'rename', newName: trimmed })
  }

  return (
    <ModalOverlay onDismiss={() => answer({ action: 'cancel' })} zIndex="z-[110]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="explorer-conflict-title"
        aria-describedby="explorer-conflict-message"
        className="modal-content-enter relative w-full max-w-[480px] rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex gap-3 px-4 pt-4 pb-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-active text-warn">
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="explorer-conflict-title" className="text-[14px] font-semibold text-fg">
              {t(request.title)}
            </h2>
            <p
              id="explorer-conflict-message"
              className="mt-1.5 text-[13px] leading-relaxed text-fg"
            >
              {t(request.message)}
            </p>
            {request.detail && (
              <p className="text-ui-sm mt-2 leading-relaxed text-fg-muted whitespace-pre-line break-all">
                {request.detail}
              </p>
            )}
            <label className="text-ui-sm mt-3 block text-fg-muted" htmlFor="explorer-conflict-name">
              {t('新名称')}
            </label>
            <input
              id="explorer-conflict-name"
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
                  submitRename()
                }
              }}
              className={`modal-field-input mt-1 ${error ? 'modal-field-input--invalid' : ''}`}
              aria-invalid={error ? true : undefined}
            />
            {error && <p className="text-ui-sm mt-1.5 text-danger">{error}</p>}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer({ action: 'cancel' })}
          >
            {t('取消')}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={() => answer({ action: 'skip' })}
          >
            {t('跳过')}
          </button>
          {request.showApplyAll && (
            <button
              type="button"
              className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
              onClick={() => answer({ action: 'skip_all' })}
            >
              {t('全部跳过')}
            </button>
          )}
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors"
            onClick={submitRename}
          >
            {t('重命名')}
          </button>
          {request.showApplyAll && (
            <button
              type="button"
              className="px-3 py-1.5 text-[13px] rounded bg-danger/90 hover:bg-danger text-white transition-colors"
              onClick={() => answer({ action: 'overwrite_all' })}
            >
              {t('全部覆盖')}
            </button>
          )}
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded bg-danger/90 hover:bg-danger text-white transition-colors"
            onClick={() => answer({ action: 'overwrite' })}
          >
            {t('覆盖')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
