import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { FileText, Search, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import helpDocument from '../../帮助文档.md?raw'
import { useI18n } from '../lib/i18n'
import {
  filterHelpSections,
  flattenText,
  helpHeadingId,
  joinHelpSections,
  splitHelpSections,
} from '../utils/helpDocument'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'

type Props = {
  onClose: () => void
}

const HELP_SECTIONS = splitHelpSections(helpDocument)

function Heading({
  as: Tag,
  children,
}: {
  as: 'h1' | 'h2' | 'h3' | 'h4'
  children?: ReactNode
}) {
  const id = helpHeadingId(flattenText(children))
  return <Tag id={id || undefined}>{children}</Tag>
}

function HelpMarkdown({ content }: { content: string }) {
  const articleRef = useRef<HTMLElement | null>(null)

  const onAnchorClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault()
    const id = decodeURIComponent(href.slice(1))
    const root = articleRef.current
    const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <article
      ref={articleRef}
      className="qing-md-preview flex-1 overflow-auto px-5 py-4 text-[14px] leading-relaxed text-fg"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <Heading as="h1">{children}</Heading>,
          h2: ({ children }) => <Heading as="h2">{children}</Heading>,
          h3: ({ children }) => <Heading as="h3">{children}</Heading>,
          h4: ({ children }) => <Heading as="h4">{children}</Heading>,
          a: ({ href, children }) => {
            if (href?.startsWith('#')) {
              return (
                <a href={href} onClick={event => onAnchorClick(event, href)}>
                  {children}
                </a>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}

export default function HelpDialog({ onClose }: Props) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => filterHelpSections(HELP_SECTIONS, query), [query])
  const markdown = useMemo(() => joinHelpSections(filtered), [filtered])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  return (
    <ModalOverlay onDismiss={onClose} zIndex="z-[120]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
        className="modal-content-enter relative flex max-h-[min(72vh,680px)] w-full max-w-[min(90vw,960px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-sidebar shadow-2xl shadow-black/50"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="flex h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-4">
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

        <div className="flex-shrink-0 border-b border-border px-4 py-2.5">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
            <input
              ref={searchRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('搜索帮助文档')}
              aria-label={t('搜索帮助文档')}
              className="setting-input h-8 w-full pl-8 pr-8 text-[13px]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('清除搜索')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {markdown.trim() ? (
          <HelpMarkdown content={markdown} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 py-10 text-[13px] text-fg-dim">
            {t('没有匹配的帮助内容')}
          </div>
        )}

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
