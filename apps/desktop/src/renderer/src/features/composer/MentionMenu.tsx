import { useEffect, useRef } from 'react'
import { File as FileIcon, LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { MentionCandidate } from './mentions'

/** `@` 候选列表：浮在输入框上方，交互与斜杠菜单一致（键盘由输入框统一处理）。 */
export function MentionMenu({
  items,
  active,
  query,
  searching,
  error,
  onHover,
  onChoose,
}: {
  items: MentionCandidate[]
  active: number
  query: string
  searching: boolean
  error: string | null
  onHover: (index: number) => void
  onChoose: (item: MentionCandidate) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const empty = error
    ? error
    : query.trim() === ''
      ? '输入文件名搜索项目文件'
      : searching
        ? '正在搜索…'
        : '没有匹配的文件'

  return (
    <div
      className="qn-no-drag qn-pop qn-surface-float absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden"
      role="listbox"
      aria-label="引用文件"
    >
      <div ref={listRef} className="qn-scroll max-h-[min(320px,45vh)] overflow-y-auto p-1.5">
        {items.length === 0 && (
          <div
            className={cn(
              'flex items-center justify-center gap-1.5 px-3 py-3 text-center text-[13px]',
              error ? 'text-qn-danger' : 'text-qn-muted',
            )}
          >
            {searching && !error && <LoaderCircle size={12} className="animate-spin" />}
            {empty}
          </div>
        )}
        {items.map((item, index) => (
          <button
            key={item.path}
            type="button"
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left outline-none',
              index === active ? 'bg-qn-active' : 'hover:bg-qn-hover',
            )}
            onMouseEnter={() => onHover(index)}
            // mousedown 时阻止默认行为，避免输入框失焦。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(item)}
          >
            <FileIcon size={14} className="shrink-0 text-qn-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-qn-text">{item.name}</span>
              <span className="block truncate text-[12px] text-qn-dim">{item.relative}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-qn-border px-3 py-1.5 text-[11px] text-qn-dim">
        <span>↑↓ 选择</span>
        <span>Enter / Tab 引用</span>
        <span>Esc 关闭</span>
        {searching && items.length > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <LoaderCircle size={11} className="animate-spin" /> 搜索中
          </span>
        )}
      </div>
    </div>
  )
}
