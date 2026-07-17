import { useEffect, type ReactNode } from 'react'
import { FileText, X } from 'lucide-react'
import helpDocument from '../../帮助文档.md?raw'
import { useI18n } from '../lib/i18n'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'

type Props = {
  onClose: () => void
}

function HelpContent() {
  const blocks: ReactNode[] = []
  let codeLines: string[] | null = null

  for (const [index, line] of helpDocument.trim().split(/\r?\n/).entries()) {
    if (line.startsWith('```')) {
      if (codeLines) {
        blocks.push(
          <pre key={`code-${index}`} className="my-3 overflow-x-auto rounded bg-bg-deep p-3 font-mono text-[12px] leading-5 text-fg">
            <code>{codeLines.join('\n')}</code>
          </pre>
        )
        codeLines = null
      } else {
        codeLines = []
      }
      continue
    }
    if (codeLines) {
      codeLines.push(line)
      continue
    }
    if (line.startsWith('# ')) {
      blocks.push(<h2 key={index} className="mb-4 text-lg font-semibold text-fg">{line.slice(2)}</h2>)
    } else if (line.startsWith('## ')) {
      blocks.push(<h3 key={index} className="mt-6 mb-2 text-sm font-semibold text-fg">{line.slice(3)}</h3>)
    } else if (/^\d+\. /.test(line)) {
      blocks.push(<p key={index} className="ml-5 text-[13px] leading-6 text-fg-muted">{line}</p>)
    } else if (line.startsWith('- ')) {
      blocks.push(
        <p key={index} className="flex gap-2 text-[13px] leading-6 text-fg-muted">
          <span className="text-accent">•</span><span>{line.slice(2)}</span>
        </p>
      )
    } else if (line) {
      blocks.push(<p key={index} className="text-[13px] leading-6 text-fg-muted">{line}</p>)
    } else {
      blocks.push(<div key={index} className="h-2" />)
    }
  }

  if (codeLines) {
    blocks.push(
      <pre key="code-final" className="my-3 overflow-x-auto rounded bg-bg-deep p-3 font-mono text-[12px] leading-5 text-fg">
        <code>{codeLines.join('\n')}</code>
      </pre>
    )
  }

  return <>{blocks}</>
}

export default function HelpDialog({ onClose }: Props) {
  const { t } = useI18n()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <ModalOverlay onDismiss={onClose} zIndex="z-[120]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
        className="modal-content-enter relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-sidebar shadow-2xl shadow-black/50"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border px-4">
          <h2 id="help-dialog-title" className="flex items-center gap-2 text-[14px] font-medium text-fg">
            <FileText size={16} className="text-accent" /> {t('帮助文档')}
          </h2>
          <Tooltip label={t('关闭帮助文档')} side="bottom">
            <button
              type="button"
              aria-label={t('关闭帮助文档')}
              onClick={onClose}
              className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </header>
        <article className="flex-1 overflow-auto px-5 py-4">
          <HelpContent />
        </article>
        <footer className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent/90"
          >
            {t('关闭')}
          </button>
        </footer>
      </section>
    </ModalOverlay>
  )
}
