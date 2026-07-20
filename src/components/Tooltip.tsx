import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { readStatusBarRowTop } from './statusBarRowContext'
import {
  TipArrow,
  syncStyleTopToTipArrowClearance,
  tipArrowBoxGap,
  TIP_ARROW_CLEARANCE,
  TIP_ARROW_W,
} from './tipArrow'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

const OFFSET = 8
/** Default hover delay before showing a tip (chrome / icon buttons). */
const SHOW_DELAY = 600
/** Hover delay for truncated labels (file tree, tabs, etc.). */
export const OVERFLOW_TOOLTIP_DELAY = 1000
const VIEWPORT_MARGIN = 8
const ARROW_EDGE_PAD = 10
/** @deprecated use tipArrowBoxGap(zoom); kept for tests at zoom=1 */
export const TOOLTIP_ARROW_GAP = tipArrowBoxGap(1)
export { TIP_ARROW_CLEARANCE }

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
type RectLike = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>

/**
 * Copy a DOMRect-like box, optionally overriding `top`.
 * Do NOT use object spread on `getBoundingClientRect()` — DOMRect fields are
 * prototype getters and spread yields `{}`, which parks tips at the left edge.
 */
export function copyTooltipRect(rect: RectLike, top = rect.top): RectLike {
  return {
    left: rect.left,
    right: rect.right,
    top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  }
}

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
  rect: RectLike,
  side: TooltipSide,
  tip?: Size,
  viewport: Viewport = { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
  zoom = 1,
  options?: { gap?: number },
): CSSProperties {
  const clamp = (value: number, min: number, max: number) =>
    max < min ? min : Math.min(Math.max(value, min), max)
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const gap = Math.max(0, options?.gap ?? OFFSET)
  const tipW = tip ? tip.width * z : 0
  const tipH = tip ? tip.height * z : 0

  switch (side) {
    case 'right': {
      if (!tip) {
        return {
          left: (rect.right + gap) / z,
          top: (rect.top + rect.height / 2) / z,
          transform: 'translateY(-50%)',
        }
      }
      return {
        left: clamp(rect.right + gap, VIEWPORT_MARGIN, viewport.width - tipW - VIEWPORT_MARGIN) / z,
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
          left: (rect.left - gap) / z,
          top: (rect.top + rect.height / 2) / z,
          transform: 'translate(-100%, -50%)',
        }
      }
      return {
        left:
          clamp(rect.left - gap - tipW, VIEWPORT_MARGIN, viewport.width - tipW - VIEWPORT_MARGIN) / z,
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
          top: (rect.top - gap) / z,
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
          clamp(rect.top - gap - tipH, VIEWPORT_MARGIN, viewport.height - tipH - VIEWPORT_MARGIN) / z,
        transform: 'none',
      }
    }
    case 'bottom': {
      if (!tip) {
        return {
          left: (rect.left + rect.width / 2) / z,
          top: (rect.bottom + gap) / z,
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
        top: clamp(rect.bottom + gap, VIEWPORT_MARGIN, viewport.height - tipH - VIEWPORT_MARGIN) / z,
        transform: 'none',
      }
    }
  }
}

/** Local X offset of a bottom caret so it points at the trigger center. */
export function getTooltipArrowOffsetX(
  tipLeftStyle: number,
  tipWidth: number,
  triggerCenterX: number,
  zoom = 1,
): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const tipLeftVisual = tipLeftStyle * z
  const ideal = (triggerCenterX - tipLeftVisual) / z - TIP_ARROW_W / 2
  const min = ARROW_EDGE_PAD
  const max = Math.max(min, tipWidth - ARROW_EDGE_PAD - TIP_ARROW_W)
  return Math.min(Math.max(ideal, min), max)
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
  /** Speech-bubble caret pointing at the trigger (status-bar tips). */
  arrow?: boolean
  /**
   * Which box to anchor against. Status-bar tips use `wrapper` so clearance is
   * measured to the full-height hit target, not a shorter centered child.
   */
  anchor?: 'child' | 'wrapper'
  /**
   * Viewport Y for vertical caret clearance (e.g. status-bar row top).
   * When set, arrow tips sit {@link TIP_ARROW_CLEARANCE} above this line.
   */
  clearanceTop?: () => number | undefined
  /** Fired when the tip becomes visible (after delay / forceOpen). */
  onShow?: () => void
  /** Fired when the tip is hidden. */
  onHide?: () => void
  wrapperClassName?: string
  /** Mark tip text for DOM updates during sash drag (no React re-render). */
  liveTip?: boolean
  children: ReactNode
}

export default function Tooltip({
  label,
  side = 'right',
  delay,
  onlyWhenOverflow = false,
  forceOpen = false,
  showOnFocus = false,
  arrow = false,
  anchor = 'child',
  clearanceTop,
  onShow,
  onHide,
  wrapperClassName = 'inline-flex shrink-0',
  liveTip = false,
  children,
}: Props) {
  const showDelay = delay ?? (onlyWhenOverflow ? OVERFLOW_TOOLTIP_DELAY : SHOW_DELAY)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const visible = forceOpen || open
  const [style, setStyle] = useState<CSSProperties>({})
  const [arrowOffset, setArrowOffset] = useState<number | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const onShowRef = useRef(onShow)
  const onHideRef = useRef(onHide)
  const wasVisibleRef = useRef(false)
  onShowRef.current = onShow
  onHideRef.current = onHide

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
    if (anchor === 'wrapper') return trigger
    return (trigger.firstElementChild as HTMLElement | null) ?? trigger
  }

  const triggerRect = () => {
    const el = overflowElement()
    if (!el) return null
    return el.getBoundingClientRect()
  }

  const shouldShowForOverflow = () => {
    if (!onlyWhenOverflow) return true
    const trigger = triggerRef.current
    return trigger != null && resolveOverflowElement(trigger) != null
  }

  const resolveClearanceLineTop = (rect: RectLike) =>
    clearanceTop?.() ?? readStatusBarRowTop(triggerRef.current) ?? rect.top

  const updatePosition = () => {
    const rect = triggerRect()
    if (!rect) return
    const lineTop = resolveClearanceLineTop(rect)
    const placementRect = copyTooltipRect(rect, lineTop)
    const tipEl = tipRef.current
    const tip = tipEl
      ? { width: tipEl.offsetWidth, height: tipEl.offsetHeight }
      : undefined
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const zoom = readTooltipZoom(tipEl)
    const gap = arrow ? tipArrowBoxGap(zoom) : undefined
    let next = getTooltipPosition(
      placementRect,
      side,
      tip,
      viewport,
      zoom,
      gap != null ? { gap } : undefined,
    )

    // Apply immediately, then sync caret tip → trigger top to TIP_ARROW_CLEARANCE.
    if (tipEl) {
      if (typeof next.left === 'number') tipEl.style.left = `${next.left}px`
      if (typeof next.top === 'number') tipEl.style.top = `${next.top}px`
      tipEl.style.transform = typeof next.transform === 'string' ? next.transform : ''
    }
    let arrowOffsetX: number | null = null
    if (arrow && tip && typeof next.left === 'number' && (side === 'top' || side === 'bottom')) {
      arrowOffsetX = getTooltipArrowOffsetX(next.left, tip.width, rect.left + rect.width / 2, zoom)
      const arrowEl = tipEl?.querySelector<SVGSVGElement>('[data-tip-arrow]')
      if (arrowEl) {
        arrowEl.style.left = `${arrowOffsetX}px`
        arrowEl.style.marginLeft = '0'
      }
    }

    if (arrow && tipEl && side === 'top' && typeof next.top === 'number') {
      const arrowEl = tipEl.querySelector<SVGSVGElement>('[data-tip-arrow]')
      if (arrowEl) {
        next = {
          ...next,
          top: syncStyleTopToTipArrowClearance(tipEl, next.top, zoom, lineTop, arrowEl),
        }
      }
    }

    setStyle(next)
    setArrowOffset(arrowOffsetX)
  }

  const scheduleShow = () => {
    clearTimer()
    if (!shouldShowForOverflow()) return
    timerRef.current = window.setTimeout(() => {
      if (!shouldShowForOverflow()) return
      const rect = triggerRect()
      if (!rect) return
      const zoom = readTooltipZoom()
      const lineTop = resolveClearanceLineTop(rect)
      const placementRect = copyTooltipRect(rect, lineTop)
      // Approximate first paint with transform centering; refined after mount.
      setStyle(
        getTooltipPosition(
          placementRect,
          side,
          undefined,
          undefined,
          zoom,
          arrow ? { gap: tipArrowBoxGap(zoom) } : undefined,
        ),
      )
      setOpen(true)
    }, showDelay)
  }

  const hide = () => {
    clearTimer()
    setOpen(false)
  }

  useEffect(() => () => clearTimer(), [])

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      onShowRef.current?.()
    } else if (!visible && wasVisibleRef.current) {
      onHideRef.current?.()
    }
    wasVisibleRef.current = visible
  }, [visible])

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
  }, [visible, side, label, arrow, anchor, clearanceTop])

  // Render caret whenever `arrow` is set (don't wait for offset) so first
  // measure uses the final borderless tip chrome.
  const showArrow = Boolean(arrow && (side === 'top' || side === 'bottom'))

  return (
    <>
      <span
        ref={triggerRef}
        className={wrapperClassName}
        onMouseEnter={scheduleShow}
        onMouseLeave={forceOpen ? undefined : hide}
        onFocus={showOnFocus ? scheduleShow : undefined}
        onBlur={forceOpen ? undefined : hide}
        onPointerDown={forceOpen ? undefined : hide}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className={`tooltip-enter ui-font-scaled fixed z-[100] pointer-events-none w-max rounded px-2.5 py-1.5 text-[11px] leading-5 text-fg break-words whitespace-pre-line ${
              showArrow
                ? 'max-w-[min(320px,calc(100vw-16px))] bg-bg-elevated'
                : 'max-w-[min(480px,calc(100vw-16px))] border border-border-strong bg-bg-elevated shadow-lg shadow-black/40'
            }`}
            style={{
              ...style,
              filter: showArrow ? 'drop-shadow(0 4px 14px rgba(0,0,0,0.42))' : undefined,
            }}
          >
            {liveTip ? <span data-panel-resize-live-tip>{label}</span> : label}
            {showArrow && (
              <TipArrow
                direction={side === 'top' ? 'down' : 'up'}
                style={{
                  left: arrowOffset ?? '50%',
                  marginLeft: arrowOffset == null ? -(TIP_ARROW_W / 2) : undefined,
                }}
              />
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
