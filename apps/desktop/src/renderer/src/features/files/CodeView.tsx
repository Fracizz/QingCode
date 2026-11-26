import { useEffect, useMemo, useRef, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { cn } from '../../lib/cn'
import { shouldHighlight } from '../../lib/highlight'
import { highlightTokens } from '../../lib/shiki'
import { langForPath } from './fileLinks'

type Props = {
  content: string
  path: string
  line?: number
  column?: number
  truncated?: boolean
  busy?: boolean
  onLoadMore?: () => void
  className?: string
}

// shiki FontStyle 位标记：1 斜体、2 粗体、4 下划线。
function tokenStyle(token: ThemedToken) {
  const flags = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: flags & 1 ? 'italic' : undefined,
    fontWeight: flags & 2 ? 600 : undefined,
    textDecoration: flags & 4 ? 'underline' : undefined,
  } as const
}

/**
 * 只读代码视图：行号 + shiki 高亮（超长退化为纯文本），跳转行滚动居中并高亮。
 * 内容更新时保持同一棵 DOM，外部刷新不会丢滚动位置。
 */
export function CodeView({ content, path, line, column, truncated, busy, onLoadMore, className }: Props) {
  const value = content.replace(/\n$/, '')
  const lang = useMemo(() => langForPath(path), [path])
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTokens(null)
    if (!shouldHighlight(value, lang)) return
    let alive = true
    void highlightTokens(value, lang).then((result) => {
      if (alive) setTokens(result)
    })
    return () => {
      alive = false
    }
  }, [value, lang])

  const lines = useMemo(() => value.split('\n'), [value])
  const count = Math.max(lines.length, tokens?.length ?? 0)

  useEffect(() => {
    if (!line) return
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current
      const node = container?.querySelector<HTMLElement>(`[data-line="${line}"]`)
      if (!container || !node) return
      container.scrollTop = Math.max(0, node.offsetTop - container.clientHeight / 2 + node.clientHeight / 2)
    })
    return () => cancelAnimationFrame(frame)
  }, [line, column, value, tokens])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={containerRef}
        className="qn-scroll relative min-h-0 flex-1 overflow-auto bg-[#141414] font-mono text-[12.5px] leading-5"
      >
        <div className="min-w-max py-2">
          {Array.from({ length: count }, (_, index) => {
            const number = index + 1
            const tokenLine = tokens?.[index]
            const target = number === line
            return (
              <div
                key={number}
                data-line={number}
                className={cn(
                  'flex min-h-5 items-start',
                  target && 'bg-qn-accent/12 shadow-[inset_2px_0_0_var(--color-qn-accent)]',
                )}
              >
                <span className="sticky left-0 z-10 w-12 shrink-0 select-none bg-[#141414] pr-3 text-right text-qn-dim">
                  {number}
                </span>
                <span className="whitespace-pre pr-6 text-qn-text/90">
                  {tokenLine
                    ? tokenLine.length === 0
                      ? ' '
                      : tokenLine.map((token, i) => (
                          <span key={i} style={tokenStyle(token)}>
                            {token.content}
                          </span>
                        ))
                    : (lines[index] || ' ')}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {truncated && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-qn-border px-3 py-1.5 text-[12px] text-qn-muted">
          <span>仅显示前 2 MiB</span>
          <button
            type="button"
            className="rounded-md px-2 py-0.5 text-qn-accent hover:bg-qn-hover disabled:opacity-50"
            disabled={busy}
            onClick={onLoadMore}
          >
            {busy ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  )
}
