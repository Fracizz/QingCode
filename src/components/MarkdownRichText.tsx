import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  content: string
  className?: string
}

/** Shared markdown renderer (react-markdown + GFM) for dialogs / rich text. */
export default function MarkdownRichText({ content, className }: Props) {
  return (
    <div className={className ?? 'qing-md-preview text-[13px] leading-relaxed text-fg'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
