import { forwardRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { useI18n } from '../lib/i18n'

type Props = {
  content: string
  className?: string
}

/** Lightweight Markdown preview for `.md` editor tabs. */
const MarkdownPreview = forwardRef<HTMLDivElement, Props>(function MarkdownPreview(
  { content, className = '' },
  ref,
) {
  const { t } = useI18n()
  const body = useMemo(() => content || '', [content])
  const empty = !body.trim()

  return (
    <div
      ref={ref}
      className={`qing-md-preview h-full overflow-auto px-5 py-4 text-[14px] leading-relaxed text-fg ${className}`}
    >
      {empty ? (
        <div className="flex h-full items-center justify-center text-fg-dim text-sm">{t('预览为空')}</div>
      ) : (
        <ReactMarkdown
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          }}
        >
          {body}
        </ReactMarkdown>
      )}
    </div>
  )
})

export default MarkdownPreview
