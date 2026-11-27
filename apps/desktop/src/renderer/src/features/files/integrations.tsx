import { Fragment, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { defaultUrlTransform, type Components } from 'react-markdown'
import { FileText, GitCompareArrows } from 'lucide-react'
import { openDiff, openFile } from '../workspace/openers'
import { cn } from '../../lib/cn'
import { findPathsInText, parseFileHref, type PathMatch } from './fileLinks'

export type LinkContext = { targetId: string; cwd: string }

/**
 * react-markdown 默认会清空 file: 与盘符路径的 href；只放行这两种本地形式，
 * 其余仍走默认白名单（拦住 javascript:/data: 等）。
 */
export function qnUrlTransform(value: string): string {
  const safe = defaultUrlTransform(value)
  if (safe) return safe
  if (/^file:/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return value
  return ''
}

type AnchorProps = ComponentPropsWithoutRef<'a'> & { node?: unknown }

/** 传给 ReactMarkdown 的 components.a；本地链接在面板打开，外链保持新窗口。 */
export function createMarkdownLink(getContext: () => LinkContext | null): NonNullable<Components['a']> {
  return function MarkdownFileLink({ href, children, className, onClick, node: _node, ...rest }: AnchorProps) {
    const context = getContext()
    const location = context ? parseFileHref(href ?? '', context.cwd) : null
    const anchorClass = cn('text-qn-accent underline-offset-2 hover:underline', className)
    if (!context || !location) {
      return (
        <a {...rest} href={href} target="_blank" rel="noreferrer" className={anchorClass} onClick={onClick}>
          {children}
        </a>
      )
    }
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noreferrer"
        className={anchorClass}
        title={`打开文件 ${location.path}`}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          openFile({
            targetId: context.targetId,
            path: location.path,
            line: location.line,
            column: location.column,
          })
        }}
      >
        {children}
      </a>
    )
  }
}

/** 行内代码 / 命令输出：把路径片段渲染为可点击按钮。 */
export function PathText({
  text,
  targetId,
  cwd,
  className,
}: {
  text: string
  targetId: string
  cwd: string
  className?: string
}) {
  const matches = useMemo(() => findPathsInText(text), [text])

  const open = (match: PathMatch): void => {
    const location = parseFileHref(match.raw, cwd) ?? parseFileHref(match.path, cwd)
    openFile({
      targetId,
      path: location?.path ?? match.path,
      line: match.line,
      column: match.column,
    })
  }

  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor || match.end > text.length) continue
    if (match.start > cursor) {
      parts.push(<Fragment key={`t-${cursor}`}>{text.slice(cursor, match.start)}</Fragment>)
    }
    parts.push(
      <button
        key={`p-${match.start}-${match.end}`}
        type="button"
        title={`打开文件 ${match.path}${match.line ? `:${match.line}` : ''}`}
        className="cursor-pointer rounded-sm text-qn-accent underline decoration-dotted underline-offset-2 hover:bg-qn-accent/10"
        onClick={(event) => {
          event.stopPropagation()
          open(match)
        }}
      >
        {text.slice(match.start, match.end)}
      </button>,
    )
    cursor = match.end
  }
  if (cursor < text.length) parts.push(<Fragment key={`t-${cursor}`}>{text.slice(cursor)}</Fragment>)

  return <span className={cn('whitespace-pre-wrap break-words', className)}>{parts}</span>
}

/** 文件改动卡片上的小按钮；无 cwd 时无法取 git diff，只显示打开。 */
export function FileChangeActions({
  targetId,
  cwd,
  path,
  diff,
  className,
}: {
  targetId: string
  cwd?: string
  path: string
  diff?: string
  className?: string
}) {
  const location = cwd ? parseFileHref(path, cwd) : null
  const absolute = location?.path ?? path
  const button =
    'inline-flex items-center gap-1 rounded-md border border-qn-border px-1.5 py-0.5 text-ui-xs text-qn-muted hover:bg-qn-hover hover:text-qn-text'
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)} onClick={(event) => event.stopPropagation()}>
      <button type="button" className={button} onClick={() => openFile({ targetId, path: absolute })}>
        <FileText size={12} />
        打开文件
      </button>
      {cwd && (
        <button
          type="button"
          className={button}
          onClick={() => openDiff({ targetId, cwd, path: absolute, mode: 'worktree', diff })}
        >
          <GitCompareArrows size={12} />
          与 HEAD 对比
        </button>
      )}
    </span>
  )
}
