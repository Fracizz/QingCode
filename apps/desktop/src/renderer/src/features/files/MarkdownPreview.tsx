import { useMemo, useRef, useState } from 'react'
import { ContextMenu } from 'radix-ui'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../../components/primitives'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { createMarkdownLink, qnUrlTransform } from './integrations'

type MarkdownNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
}

function headingText(node: MarkdownNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.tagName === 'img' && typeof node.properties?.alt === 'string') return node.properties.alt
  return (node.children ?? []).map(headingText).join('')
}

function addHeadingIds() {
  return (root: MarkdownNode) => {
    const headings: MarkdownNode[] = []
    const used = new Set<string>()
    function collect(node: MarkdownNode): void {
      if (typeof node.properties?.id === 'string') used.add(node.properties.id)
      if (node.tagName && /^h[1-6]$/.test(node.tagName) && node.properties?.id === undefined) headings.push(node)
      node.children?.forEach(collect)
    }
    collect(root)
    const suffixes = new Map<string, number>()
    for (const heading of headings) {
      const base = headingText(heading).trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replaceAll(' ', '-') || 'section'
      let id = base
      let suffix = suffixes.get(base) ?? 0
      while (used.has(id)) id = `${base}-${++suffix}`
      used.add(id)
      suffixes.set(base, suffix)
      heading.properties = { ...heading.properties, id, tabIndex: -1 }
    }
  }
}

export function MarkdownPreview({ content, targetId, cwd, onViewSource }: {
  content: string
  targetId: string
  cwd: string
  onViewSource: () => void
}) {
  const preview = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState({ selection: '', href: '' })
  const components = useMemo<Components>(() => {
    const FileLink = createMarkdownLink(() => ({ targetId, cwd }))
    return {
      a: ({ href, node, className, ...props }) => {
        if (!href?.startsWith('#')) return <FileLink {...props} href={href} node={node} className={className} />
        return <a {...props} href={href} className={cn('text-qn-accent underline-offset-2 hover:underline', className)}
          onClick={(event) => {
            event.preventDefault()
            let id = href.slice(1)
            try { id = decodeURIComponent(id) } catch { /* 保留原锚点，允许按字面匹配。 */ }
            if (!id) {
              preview.current?.scrollTo({ top: 0 })
              return
            }
            const destination = Array.from(preview.current?.querySelectorAll<HTMLElement>('[id]') ?? [])
              .find((element) => element.id === id)
            destination?.scrollIntoView({ block: 'start' })
            destination?.focus({ preventScroll: true })
          }}
        />
      },
    }
  }, [targetId, cwd])
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div ref={preview} tabIndex={0}
          onContextMenuCapture={(event) => {
            const selection = window.getSelection()
            const withinPreview = selection && !selection.isCollapsed &&
              event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode)
            const link = event.target instanceof Element ? event.target.closest('a[href]') : null
            setMenu({ selection: withinPreview ? selection.toString() : '', href: link?.getAttribute('href') ?? '' })
          }}
          className="qn-scroll qn-markdown min-h-0 flex-1 overflow-auto px-4 py-3 text-[length:var(--qn-editor-font-size,12.5px)] leading-[1.8] text-qn-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[addHeadingIds]} urlTransform={qnUrlTransform} components={components}>
            {content}
          </ReactMarkdown>
        </div>
      </ContextMenu.Trigger>
      <ContextMenuContent aria-label="Markdown 预览操作">
        <ContextMenuItem disabled={!menu.selection} onSelect={() => void copyText(menu.selection)}>复制选中文字</ContextMenuItem>
        {menu.href && <ContextMenuItem onSelect={() => void copyText(menu.href)}>复制链接地址</ContextMenuItem>}
        <ContextMenuItem onSelect={() => void copyText(content)}>复制 Markdown 源码</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onViewSource}>查看源码</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu.Root>
  )
}
