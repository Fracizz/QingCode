import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { useI18n } from '../lib/i18n'

type Props = {
  content: string
  className?: string
}

/** Lightweight Markdown preview for `.md` editor tabs. */
export default function MarkdownPreview({ content, className = '' }: Props) {
  const { t } = useI18n()
  const body = useMemo(() => content || '', [content])

  if (!body.trim()) {
    return (
      <div className={`flex h-full items-center justify-center text-fg-dim text-sm ${className}`}>
        {t('预览为空')}
      </div>
    )
  }

  return (
    <div
      className={`qing-md-preview h-full overflow-auto px-5 py-4 text-[14px] leading-relaxed text-fg ${className}`}
    >
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
    </div>
  )
}
