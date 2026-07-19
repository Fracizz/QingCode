import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

const OFFSET = 8
/** Default hover delay before showing a tip (chrome / icon buttons). */
const SHOW_DELAY = 600
/** Hover delay for truncated labels (file tree, tabs, etc.). */
export const OVERFLOW_TOOLTIP_DELAY = 1000
const VIEWPORT_MARGIN = 8

/** True when `text-overflow: ellipsis` is clipping visible text. */
export function isOverflowing(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth
}

/** Prefer the clipped text node; fall back to a truncating wrapper (flex + truncate). */
export function resolveOverflowElement(trigger: HTMLElement): HTMLElement | null {
  const child = trigger.firstElementChild as HTMLElement | null
  if (child && isOverflowing(child)) return child
  if (isOverflowing(trigger)) return trigger
  return null
}

type Size = { width: number; height: number }
type Viewport = { width: number; height: number }

/** Read CSS `zoom` from a scaled tip, falling back to `--ui-font-scale`. */
export function readTooltipZoom(el?: HTMLElement | null): number {
  if (el) {
    const fromEl = Number.parseFloat(getComputedStyle(el).zoom)
    if (Number.isFinite(fromEl) && fromEl > 0) return fromEl
  }
  const scale = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale'),
  )
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/**
 * Pure placement helper — exported for unit tests.
 *
 * `rect` is viewport-space (e.g. getBoundingClientRect). When the tip uses
 * `.ui-font-scaled` (`zoom`), pass layout tip size + zoom so returned `left`/`top`
 * are pre-zoom style values (same approach as getContextMenuStylePosition).
 */
export function getTooltipPosition(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  side: TooltipSide,
  tip?: Size,
  viewport: Viewport = { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
  zoom = 1,
): CSSProperties {
  const clamp = (value: number, min: number, max: number) =>
    max < min ? min : Math.min(Math.max(value, min), max)
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const tipW = tip ? tip.width * z : 0
  const tipH = tip ? tip.height * z : 0

  switch (side) {
    case 'right': {
      if (!tip) {
        return {
          left: (rect.right + OFFSET) / z,
          top: (rect.top + rect.height / 2) / z,
          transform: 'translateY(-50%)',
        }
      }
      return {
        left: clamp(rect.right + OFFSET, VIEWPORT_MARGIN, viewport.width - tipW - VIEWPORT_MARGIN) / z,
        top:
          clamp(
            rect.top + rect.height / 2 - tipH / 2,
            VIEWPORT_MARGIN,
            viewport.height - tipH - VIEWPORT_MARGIN,
          ) / z,
        transform: 'none',
      }
    }
    case 'left': {
      if (!tip) {
        return {
          left: (rect.left - OFFSET) / z,
          top: (rect.top + rect.height / 2) / z,
          transform: 'translate(-100%, -50%)',
        }
      }
      return {
        left:
          clamp(rect.left - OFFSET - tipW, VIEWPORT_MARGIN, viewport.width - tipW - VIEWPORT_MARGIN) / z,
        top:
          clamp(
            rect.top + rect.height / 2 - tipH / 2,
            VIEWPORT_MARGIN,
            viewport.height - tipH - VIEWPORT_MARGIN,
          ) / z,
        transform: 'none',
      }
    }
    case 'top': {
      if (!tip) {
        return {
          left: (rect.left + rect.width / 2) / z,
          top: (rect.top - OFFSET) / z,
          transform: 'translate(-50%, -100%)',
        }
      }
      return {
        left:
          clamp(
            rect.left + rect.width / 2 - tipW / 2,
            VIEWPORT_MARGIN,
            viewport.width - tipW - VIEWPORT_MARGIN,
          ) / z,
        top:
          clamp(rect.top - OFFSET - tipH, VIEWPORT_MARGIN, viewport.height - tipH - VIEWPORT_MARGIN) / z,
        transform: 'none',
      }
    }
    case 'bottom': {
      if (!tip) {
        return {
          left: (rect.left + rect.width / 2) / z,
          top: (rect.bottom + OFFSET) / z,
          transform: 'translateX(-50%)',
        }
      }
      return {
        left:
          clamp(
            rect.left + rect.width / 2 - tipW / 2,
            VIEWPORT_MARGIN,
            viewport.width - tipW - VIEWPORT_MARGIN,
          ) / z,
        top: clamp(rect.bottom + OFFSET, VIEWPORT_MARGIN, viewport.height - tipH - VIEWPORT_MARGIN) / z,
        transform: 'none',
      }
    }
  }
}

interface Props {
  label: string
  side?: TooltipSide
  delay?: number
  /** When true, show only if the trigger content is truncated (ellipsis). */
  onlyWhenOverflow?: boolean
  /** Keep the tooltip visible without waiting for hover (for transient guidance). */
  forceOpen?: boolean
  /** When false, focus does not open the tip (avoids tip-on-click). Default false. */
  showOnFocus?: boolean
  wrapperClassName?: string
  children: ReactNode
}

export default function Tooltip({
  label,
  side = 'right',
  delay,
  onlyWhenOverflow = false,
  forceOpen = false,
  showOnFocus = false,
  wrapperClassName = 'inline-flex shrink-0',
  children,
}: Props) {
  const showDelay = delay ?? (onlyWhenOverflow ? OVERFLOW_TOOLTIP_DELAY : SHOW_DELAY)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const visible = forceOpen || open
  const [style, setStyle] = useState<CSSProperties>({})
  const timerRef = useRef<number | undefined>(undefined)

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }

  const overflowElement = () => {
    const trigger = triggerRef.current
    if (!trigger) return null
    if (onlyWhenOverflow) {
      return resolveOverflowElement(trigger) ?? (trigger.firstElementChild as HTMLElement | null) ?? trigger
    }
    return (trigger.firstElementChild as HTMLElement | null) ?? trigger
  }

  const triggerRect = () => {
    const anchor = overflowElement()
    if (!anchor) return null
    return anchor.getBoundingClientRect()
  }

  const shouldShowForOverflow = () => {
    if (!onlyWhenOverflow) return true
    const trigger = triggerRef.current
    return trigger != null && resolveOverflowElement(trigger) != null
  }

  const updatePosition = () => {
    const rect = triggerRect()
    if (!rect) return
    const tipEl = tipRef.current
    const tip = tipEl
      ? { width: tipEl.offsetWidth, height: tipEl.offsetHeight }
      : undefined
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const zoom = readTooltipZoom(tipEl)
    setStyle(getTooltipPosition(rect, side, tip, viewport, zoom))
  }

  const scheduleShow = () => {
    clearTimer()
    if (!shouldShowForOverflow()) return
    timerRef.current = window.setTimeout(() => {
      if (!shouldShowForOverflow()) return
      const rect = triggerRect()
      if (!rect) return
      // Approximate first paint with transform centering; refined after mount.
      setStyle(getTooltipPosition(rect, side, undefined, undefined, readTooltipZoom()))
      setOpen(true)
    }, showDelay)
  }

  const hide = () => {
    clearTimer()
    setOpen(false)
  }

  useEffect(() => () => clearTimer(), [])

  useLayoutEffect(() => {
    if (!visible) return
    updatePosition()
    const onLayoutChange = () => updatePosition()
    window.addEventListener('scroll', onLayoutChange, true)
    window.addEventListener('resize', onLayoutChange)
    return () => {
      window.removeEventListener('scroll', onLayoutChange, true)
      window.removeEventListener('resize', onLayoutChange)
    }
  }, [visible, side, label])

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
      {visible &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="tooltip-enter ui-font-scaled fixed z-[100] pointer-events-none w-max max-w-[min(480px,calc(100vw-16px))] rounded px-2 py-1 text-[11px] leading-4 text-fg border border-border-strong bg-bg-elevated shadow-lg shadow-black/40 break-words whitespace-normal"
            style={style}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
