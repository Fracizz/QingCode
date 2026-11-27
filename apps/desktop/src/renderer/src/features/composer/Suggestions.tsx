import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Suggestions({
  label,
  active,
  confirmHint,
  trailingHint,
  listClassName,
  children,
}: {
  label: string
  active: number
  confirmHint: string
  trailingHint?: ReactNode
  listClassName?: string
  children: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      className="qn-no-drag qn-pop qn-surface-float absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden"
      role="listbox"
      aria-label={label}
    >
      <div ref={listRef} className={cn('qn-scroll max-h-[min(320px,45vh)] overflow-y-auto p-1.5', listClassName)}>
        {children}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-qn-border px-3 py-1.5 text-[11px] text-qn-dim">
        <span>↑↓ 选择</span>
        <span>Enter / Tab {confirmHint}</span>
        <span>Esc 关闭</span>
        {trailingHint}
      </div>
    </div>
  )
}
