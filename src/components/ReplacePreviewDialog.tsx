import { useEffect, useRef, useState } from 'react'
import { Replace } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import {
  applyWorkspaceReplace,
  type ReplacePreview,
} from '../lib/workspaceReplace'
import { safeInvoke } from '../lib/tauri'

type Props = {
  preview: ReplacePreview
  onClose: () => void
  onApplied: (result: { filesChanged: number; replacements: number }) => void
}

export default function ReplacePreviewDialog({ preview, onClose, onApplied }: Props) {
  const { t } = useI18n()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, applying])

  const apply = async () => {
    setApplying(true)
    try {
      const result = await applyWorkspaceReplace(preview, {
        beforeWrite: async path => {
          try {
            await safeInvoke('抑制监视', 'suppress_fs_watch', { path })
          } catch {
            /* best-effort */
          }
        },
        onProgress: (done, total) => {
          setProgress(t('正在替换 {done}/{total}…', { done, total }))
        },
      })
      onApplied({ filesChanged: result.filesChanged, replacements: result.replacements })
      if (result.errors.length > 0) {
        // Parent shows success toast; surface first error via progress line briefly.
        setProgress(result.errors[0])
      }
      onClose()
    } catch (e) {
      setProgress(String(e))
      setApplying(false)
    }
  }

  return (
    <ModalOverlay onDismiss={applying ? undefined : onClose} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="replace-preview-title"
        className="modal-content-enter relative flex h-[min(78vh,620px)] w-full max-w-[640px] flex-col rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Replace size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="replace-preview-title" className="text-[14px] font-semibold text-fg">
              {t('替换预览')}
            </h2>
            <p className="text-ui-sm text-fg-muted">
              {t('将把「{query}」替换为「{replacement}」', {
                query: preview.query,
                replacement: preview.replacement,
              })}
            </p>
          </div>
        </div>

        <div className="text-ui-sm flex-shrink-0 border-b border-border px-4 py-2 text-fg-muted">
          {t('{files} 个文件 · {matches} 处匹配', {
            files: preview.files.length,
            matches: preview.matchCount,
          })}
          {preview.truncated ? ` · ${t('结果已截断，仅替换当前列表中的匹配')}` : ''}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {preview.files.map(file => (
            <div key={file.path} className="mb-2 rounded border border-border bg-bg px-2 py-1.5">
              <div className="text-ui-sm flex items-baseline gap-2">
                <span className="font-medium text-fg truncate">{file.name}</span>
                <span className="text-fg-dim truncate">{file.relative}</span>
                <span className="ml-auto flex-shrink-0 text-fg-muted">
                  {t('{count} 处', { count: file.matchCount })}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {file.samples.map(sample => (
                  <li key={`${file.path}:${sample.line}:${sample.matchStart}`}>
                    <Tooltip
                      label={sample.text}
                      side="bottom"
                      onlyWhenOverflow
                      wrapperClassName="block min-w-0"
                    >
                      <div className="text-ui-sm truncate font-mono text-fg-muted">
                        <span className="text-fg-dim mr-2">{sample.line}</span>
                        {sample.text}
                      </div>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="text-ui-sm truncate text-fg-dim">{progress}</span>
          <div className="flex gap-2 flex-shrink-0">
            <button
              ref={cancelRef}
              type="button"
              disabled={applying}
              className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors disabled:opacity-50"
              onClick={onClose}
            >
              {t('取消')}
            </button>
            <button
              type="button"
              disabled={applying || preview.files.length === 0}
              className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors disabled:opacity-50"
              onClick={() => void apply()}
            >
              {applying ? t('正在替换…') : t('确认替换')}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
