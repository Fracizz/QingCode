import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface ContextMenuItem {
  label: string
  icon?: ReactNode
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
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const margin = 8
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin)),
    })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      role="menu"
      className="ui-font-scaled fixed z-50 min-w-[220px] rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45"
      style={{ left: position.x, top: position.y }}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          {item.separatorBefore && <div className="my-1 border-t border-border-strong" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] outline-none transition-colors
              ${
                item.danger
                  ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
                  : 'text-fg hover:bg-bg-active focus:bg-bg-active'
              }
              disabled:cursor-not-allowed disabled:opacity-40`}
            onClick={() => {
              onClose()
              void item.action()
            }}
          >
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
              {item.icon}
            </span>
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="ml-5 text-[11px] text-fg-dim">{item.shortcut}</span>
            )}
          </button>
        </div>
      ))}
    </div>
  )
}
