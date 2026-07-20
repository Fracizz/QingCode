import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { getContextMenuStylePosition } from './contextMenuPosition'
import { getTooltipArrowOffsetX } from './Tooltip'
import {
  syncStyleTopToTipArrowClearance,
  TipArrow,
  tipArrowBoxGap,
  TIP_ARROW_W,
} from './tipArrow'

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

/** Tip arrow on the menu edge (speech-bubble caret, bottom-trailing). */
export type ContextMenuArrow = 'bottom-end'

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  /** When true, treat `y` as the bottom edge and open the menu upward. */
  preferAbove = false,
  /** Optional tip arrow pointing at the anchor (encoding status tip, etc.). */
  arrow,
  /** Viewport X of the trigger center (caret tip aims here). */
  arrowAnchorX,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  preferAbove?: boolean
  arrow?: ContextMenuArrow
  arrowAnchorX?: number
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const arrowRef = useRef<SVGSVGElement>(null)
  const [position, setPosition] = useState({ x, y })
  const [arrowOffsetX, setArrowOffsetX] = useState<number | null>(null)

  useLayoutEffect(() => {
    const shell = shellRef.current
    const bubble = bubbleRef.current
    const menu = menuRef.current
    if (!shell || !bubble || !menu) return
    const zoom = Number.parseFloat(getComputedStyle(shell).zoom) || 1
    // Clear prior clamp so we measure the full content height.
    menu.style.maxHeight = ''
    // Prefer bubble offsetHeight (includes padding). `scrollHeight` alone can
    // under-count bottom padding under overflow and eat the tip clearance.
    const height = Math.max(bubble.offsetHeight, menu.scrollHeight)
    const placed = getContextMenuStylePosition(
      x,
      y,
      { width: bubble.offsetWidth, height },
      { width: window.innerWidth, height: window.innerHeight },
      preferAbove,
      zoom,
      { arrowGap: arrow ? tipArrowBoxGap(zoom) : preferAbove ? 8 : 0 },
    )
    menu.style.maxHeight = `${placed.maxHeight}px`

    const nextX = placed.x
    let nextY = placed.y
    // Apply immediately so the caret can be measured in this frame.
    shell.style.left = `${nextX}px`
    shell.style.top = `${nextY}px`

    const arrowEl = arrowRef.current
    let nextArrowOffset: number | null = null
    if (arrow && preferAbove && arrowAnchorX != null) {
      nextArrowOffset = getTooltipArrowOffsetX(
        nextX,
        bubble.offsetWidth,
        arrowAnchorX,
        zoom,
      )
    }
    if (arrowEl) {
      if (nextArrowOffset != null) {
        arrowEl.style.left = `${nextArrowOffset}px`
        arrowEl.style.right = 'auto'
        arrowEl.style.marginLeft = '0'
      } else {
        arrowEl.style.removeProperty('left')
        arrowEl.style.removeProperty('right')
        arrowEl.style.removeProperty('margin-left')
      }
    }
    setArrowOffsetX(nextArrowOffset)

    if (arrow && preferAbove && arrowEl) {
      nextY = syncStyleTopToTipArrowClearance(shell, nextY, zoom, y, arrowEl)
    }

    setPosition({ x: nextX, y: nextY })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y, items, preferAbove, arrow, arrowAnchorX])

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
      ref={shellRef}
      className="menu-enter ui-font-scaled fixed z-[120]"
      style={{
        left: position.x,
        top: position.y,
        // Soft bubble shadow so the caret is included (tip-style).
        filter: arrow ? 'drop-shadow(0 4px 14px rgba(0,0,0,0.42))' : undefined,
      }}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
    >
      <div
        ref={bubbleRef}
        className={`relative min-w-[220px] max-w-[min(360px,calc(100vw-16px))] rounded-md bg-bg-elevated ${
          arrow ? '' : 'border border-border-strong shadow-2xl shadow-black/45'
        }`}
      >
        <div ref={menuRef} role="menu" className="overflow-y-auto py-1">
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`}>
              {item.separatorBefore && <div className="my-1 border-t border-border-strong" />}
              <button
                ref={el => {
                  itemRefs.current[index] = el
                }}
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
                  {item.checked !== undefined ? (
                    item.checked ? (
                      <Check size={14} className="text-fg" />
                    ) : null
                  ) : (
                    item.icon
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="ml-5 text-[11px] text-fg-dim">{item.shortcut}</span>
                )}
              </button>
            </div>
          ))}
        </div>
        {arrow === 'bottom-end' && (
          <TipArrow
            ref={arrowRef}
            direction="down"
            style={{
              left: arrowOffsetX ?? '50%',
              marginLeft: arrowOffsetX == null ? -(TIP_ARROW_W / 2) : undefined,
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
