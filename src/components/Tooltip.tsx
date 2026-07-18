import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

const OFFSET = 8
/** Default hover delay before showing a tip (chrome / icon buttons). */
const SHOW_DELAY = 600
const VIEWPORT_MARGIN = 8

type Size = { width: number; height: number }
type Viewport = { width: number; height: number }

/** Pure placement helper — exported for unit tests. */
export function getTooltipPosition(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  side: TooltipSide,
  tip?: Size,
  viewport: Viewport = { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
): CSSProperties {
  const clamp = (value: number, min: number, max: number) =>
    max < min ? min : Math.min(Math.max(value, min), max)

  switch (side) {
    case 'right': {
      if (!tip) {
        return {
          left: rect.right + OFFSET,
          top: rect.top + rect.height / 2,
          transform: 'translateY(-50%)',
        }
      }
      return {
        left: clamp(rect.right + OFFSET, VIEWPORT_MARGIN, viewport.width - tip.width - VIEWPORT_MARGIN),
        top: clamp(
          rect.top + rect.height / 2 - tip.height / 2,
          VIEWPORT_MARGIN,
          viewport.height - tip.height - VIEWPORT_MARGIN,
        ),
        transform: 'none',
      }
    }
    case 'left': {
      if (!tip) {
        return {
          left: rect.left - OFFSET,
          top: rect.top + rect.height / 2,
          transform: 'translate(-100%, -50%)',
        }
      }
      return {
        left: clamp(
          rect.left - OFFSET - tip.width,
          VIEWPORT_MARGIN,
          viewport.width - tip.width - VIEWPORT_MARGIN,
        ),
        top: clamp(
          rect.top + rect.height / 2 - tip.height / 2,
          VIEWPORT_MARGIN,
          viewport.height - tip.height - VIEWPORT_MARGIN,
        ),
        transform: 'none',
      }
    }
    case 'top': {
      if (!tip) {
        return {
          left: rect.left + rect.width / 2,
          top: rect.top - OFFSET,
          transform: 'translate(-50%, -100%)',
        }
      }
      return {
        left: clamp(
          rect.left + rect.width / 2 - tip.width / 2,
          VIEWPORT_MARGIN,
          viewport.width - tip.width - VIEWPORT_MARGIN,
        ),
        top: clamp(
          rect.top - OFFSET - tip.height,
          VIEWPORT_MARGIN,
          viewport.height - tip.height - VIEWPORT_MARGIN,
        ),
        transform: 'none',
      }
    }
    case 'bottom': {
      if (!tip) {
        return {
          left: rect.left + rect.width / 2,
          top: rect.bottom + OFFSET,
          transform: 'translateX(-50%)',
        }
      }
      return {
        left: clamp(
          rect.left + rect.width / 2 - tip.width / 2,
          VIEWPORT_MARGIN,
          viewport.width - tip.width - VIEWPORT_MARGIN,
        ),
        top: clamp(rect.bottom + OFFSET, VIEWPORT_MARGIN, viewport.height - tip.height - VIEWPORT_MARGIN),
        transform: 'none',
      }
    }
  }
}

interface Props {
  label: string
  side?: TooltipSide
  delay?: number
  /** When false, focus does not open the tip (avoids tip-on-click). Default false. */
  showOnFocus?: boolean
  wrapperClassName?: string
  children: ReactNode
}

export default function Tooltip({
  label,
  side = 'right',
  delay = SHOW_DELAY,
  showOnFocus = false,
  wrapperClassName = 'inline-flex shrink-0',
  children,
}: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const timerRef = useRef<number | undefined>(undefined)

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }

  const triggerRect = () => {
    const trigger = triggerRef.current
    if (!trigger) return null
    // Prefer the child control box so flex wrappers don't skew centering.
    const anchor = (trigger.firstElementChild as HTMLElement | null) ?? trigger
    return anchor.getBoundingClientRect()
  }

  const updatePosition = () => {
    const rect = triggerRect()
    if (!rect) return
    const tipEl = tipRef.current
    const tip = tipEl
      ? { width: tipEl.offsetWidth, height: tipEl.offsetHeight }
      : undefined
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    setStyle(getTooltipPosition(rect, side, tip, viewport))
  }

  const scheduleShow = () => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      const rect = triggerRect()
      if (!rect) return
      // Approximate first paint with transform centering; refined after mount.
      setStyle(getTooltipPosition(rect, side))
      setOpen(true)
    }, delay)
  }

  const hide = () => {
    clearTimer()
    setOpen(false)
  }

  useEffect(() => () => clearTimer(), [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const onLayoutChange = () => updatePosition()
    window.addEventListener('scroll', onLayoutChange, true)
    window.addEventListener('resize', onLayoutChange)
    return () => {
      window.removeEventListener('scroll', onLayoutChange, true)
      window.removeEventListener('resize', onLayoutChange)
    }
  }, [open, side, label])

  return (
    <>
      <span
        ref={triggerRef}
        className={wrapperClassName}
        onMouseEnter={scheduleShow}
        onMouseLeave={hide}
        onFocus={showOnFocus ? scheduleShow : undefined}
        onBlur={hide}
        onPointerDown={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="tooltip-enter fixed z-[100] pointer-events-none rounded px-2 py-1 text-[11px] leading-4 text-fg border border-border-strong bg-bg-elevated shadow-lg shadow-black/40 whitespace-nowrap"
            style={{ ...style, fontSize: 'var(--ui-font-size)' }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
