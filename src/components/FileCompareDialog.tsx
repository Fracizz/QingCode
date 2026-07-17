import { useEffect, useRef } from 'react'
import { GitCompare } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import { useI18n } from '../lib/i18n'

export type FileCompareRequest = {
  path: string
  localContent: string
  diskContent: string
  onKeepLocal: () => void
  onReload: () => void
  onClose: () => void
}

export default function FileCompareDialog({
  path,
  localContent,
  diskContent,
  onKeepLocal,
  onReload,
  onClose,
}: FileCompareRequest) {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const name = path.split(/[/\\]/).pop() || path

  return (
    <ModalOverlay onDismiss={onClose} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        className="relative flex h-[min(80vh,640px)] w-full max-w-[920px] flex-col rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <GitCompare size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="compare-title" className="text-[14px] font-semibold text-fg truncate">
              {t('比较：{name}', { name })}
            </h2>
            <p className="text-[11px] text-fg-dim truncate" title={path}>
              {path}
            </p>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-border">
          <ComparePane title={t('本地修改')} content={localContent} />
          <ComparePane title={t('磁盘版本')} content={diskContent} />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            ref={closeRef}
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={onClose}
          >
            {t('关闭')}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            onClick={onKeepLocal}
          >
            {t('保留本地修改')}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors"
            onClick={onReload}
          >
            {t('重新加载')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function ComparePane({ title, content }: { title: string; content: string }) {
  return (
    <div className="flex min-h-0 flex-col bg-bg">
      <div className="flex-shrink-0 border-b border-border px-3 py-1.5 text-[11px] font-medium text-fg-muted">
        {title}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-5 text-fg whitespace-pre-wrap break-all">
        {content}
      </pre>
    </div>
  )
}
