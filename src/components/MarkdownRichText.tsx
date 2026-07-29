import { isValidElement, useRef, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  content: string
  className?: string
}

/**
 * Release notes published on GitHub/Gitee use empty HTML anchors for language
 * navigation. ReactMarkdown deliberately renders raw HTML as text, so discard
 * only those non-content anchors instead of enabling raw HTML from a remote
 * release body.
 */
function stripEmptyHtmlAnchors(content: string): string {
  return content.replace(/<a\s+id=(['"])[^'"]+\1\s*><\/a>/gi, '')
}

function flattenText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(flattenText).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return flattenText(children.props.children)
  }
  return ''
}

function headingId(children: ReactNode): string {
  return flattenText(children)
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, '-')
}

/** Shared Markdown renderer (GFM) for dialogs / rich text. */
export default function MarkdownRichText({ content, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const markdown = stripEmptyHtmlAnchors(content)

  const onAnchorClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!href.startsWith('#')) return
    event.preventDefault()
    const id = decodeURIComponent(href.slice(1))
    const target = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(
      element => element.id === id,
    )
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div ref={containerRef} className={className ?? 'qing-md-preview text-[13px] leading-relaxed text-fg'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={headingId(children) || undefined}>{children}</h1>,
          h2: ({ children }) => <h2 id={headingId(children) || undefined}>{children}</h2>,
          h3: ({ children }) => <h3 id={headingId(children) || undefined}>{children}</h3>,
          h4: ({ children }) => <h4 id={headingId(children) || undefined}>{children}</h4>,
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
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
