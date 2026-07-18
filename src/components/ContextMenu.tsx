import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { getContextMenuStylePosition } from './contextMenuPosition'

export interface ContextMenuItem {
  label: string
  icon?: ReactNode
  /** When set, shows a checkmark column (VS Code-style toggle items). */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  shortcut?: string
  action: () => void | Promise<void>
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  /** When true, treat `y` as the bottom edge and open the menu upward. */
  preferAbove = false,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  preferAbove?: boolean
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const zoom = Number.parseFloat(getComputedStyle(menu).zoom) || 1
    const placed = getContextMenuStylePosition(
      x,
      y,
      { width: menu.offsetWidth, height: menu.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      preferAbove,
      zoom,
    )
    menu.style.maxHeight = `${placed.maxHeight}px`
    setPosition({ x: placed.x, y: placed.y })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y, items, preferAbove])

  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.button === 2) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      const enabledItems = items.map((_, i) => i).filter(i => !items[i].disabled)
      if (enabledItems.length === 0) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(prev => {
          const current = prev !== null ? enabledItems.indexOf(prev) : -1
          let nextIdx: number
          if (event.key === 'ArrowDown') {
            nextIdx = current + 1 >= enabledItems.length ? 0 : current + 1
          } else {
            nextIdx = current - 1 < 0 ? enabledItems.length - 1 : current - 1
          }
          const next = enabledItems[nextIdx]
          const ref = itemRefs.current[next]
          if (ref) ref.focus()
          return next
        })
        return
      }
      if (event.key === 'Enter' && activeIndex !== null) {
        event.preventDefault()
        const item = items[activeIndex]
        if (item && !item.disabled) {
          onClose()
          void item.action()
        }
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, items, activeIndex])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="menu-enter ui-font-scaled fixed z-50 min-w-[220px] max-w-[min(360px,calc(100vw-16px))] overflow-y-auto rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45"
      style={{ left: position.x, top: position.y }}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          {item.separatorBefore && <div className="my-1 border-t border-border-strong" />}
          <button
            ref={el => { itemRefs.current[index] = el }}
            type="button"
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked !== undefined ? item.checked : undefined}
            disabled={item.disabled}
            tabIndex={activeIndex === index ? 0 : -1}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] outline-none transition-colors
              ${
                item.danger
                  ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
                  : activeIndex === index
                    ? 'bg-bg-active text-fg'
                    : 'text-fg hover:bg-bg-active focus:bg-bg-active'
              }
              disabled:cursor-not-allowed disabled:opacity-40`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              onClose()
              void item.action()
            }}
          >
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
              {item.checked !== undefined
                ? item.checked
                  ? <Check size={14} className="text-fg" />
                  : null
                : item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="ml-5 text-[11px] text-fg-dim">{item.shortcut}</span>
            )}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
