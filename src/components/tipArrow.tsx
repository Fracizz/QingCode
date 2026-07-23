import type { CSSProperties, Ref } from 'react'
import {
  CARET_STROKE_WIDTH,
  isoscelesCaretHeight,
  isoscelesChevronPath,
  isoscelesCaretSize,
  type CaretDirection,
} from '../lib/isoscelesArrowGeometry'

/** Shared tip-caret metrics for StatusTip / Tooltip / encoding ContextMenu / minimap Quick View. */

/** Base width; height follows 60° isosceles (legs ~60° from horizontal). */
export const TIP_ARROW_W = 10
export const TIP_ARROW_H = isoscelesCaretHeight(TIP_ARROW_W)
/** Local CSS px the caret hangs past the bubble (`bottom: -PROTRUDE`). */
export const TIP_ARROW_PROTRUDE = TIP_ARROW_H - 1
/** Desired viewport gap: caret tip → status-bar row top (or anchor top). */
export const TIP_ARROW_CLEARANCE = 2
/** @deprecated Horizontal tips now use {@link TIP_ARROW_PROTRUDE} like vertical tips. */
export const TIP_ARROW_BUBBLE_GAP = 4
export const TIP_ARROW_END_INSET = 22

/**
 * Viewport-pixel distance from tip/menu box bottom to the trigger top.
 * Compensates CSS `zoom` so caret tip clearance stays {@link TIP_ARROW_CLEARANCE}.
 */
export function tipArrowBoxGap(zoom = 1): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return TIP_ARROW_PROTRUDE * z + TIP_ARROW_CLEARANCE
}

/** Viewport Y of the downward caret tip (lowest painted point). */
export function getTipArrowTipViewportY(svg: SVGSVGElement): number {
  const rectBottom = svg.getBoundingClientRect().bottom
  const path = svg.querySelector('path')
  if (!path) return rectBottom
  const box = path.getBBox()
  const ctm = svg.getScreenCTM()
  if (!ctm) return rectBottom
  const pt = svg.createSVGPoint()
  pt.x = box.x + box.width / 2
  pt.y = box.y + box.height
  const pathBottom = pt.matrixTransform(ctm).y
  return Math.max(rectBottom, pathBottom)
}

/**
 * Nudge `position: fixed` `top` (pre-zoom style px) so the caret tip sits
 * {@link TIP_ARROW_CLEARANCE} below `clearanceLineTop` (viewport px).
 */
export function syncStyleTopToTipArrowClearance(
  host: HTMLElement,
  styleTop: number,
  zoom: number,
  clearanceLineTop: number,
  arrowSvg: SVGSVGElement | null,
): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  let top = styleTop
  if (!arrowSvg) return top
  for (let pass = 0; pass < 2; pass++) {
    host.style.top = `${top}px`
    const tipY = getTipArrowTipViewportY(arrowSvg)
    const desired = clearanceLineTop - TIP_ARROW_CLEARANCE
    const delta = tipY - desired
    if (Math.abs(delta) < 0.01) break
    top -= delta / z
  }
  host.style.top = `${top}px`
  return top
}

export type TipArrowDirection = CaretDirection

type TipArrowProps = {
  /** `down` = tip below the bubble (StatusTip / encoding menu). */
  direction?: TipArrowDirection
  className?: string
  style?: CSSProperties
  /** Forwarded for layout measurement (caret tip → trigger clearance). */
  ref?: Ref<SVGSVGElement>
}

function tipArrowEdgeStyle(direction: TipArrowDirection): CSSProperties {
  switch (direction) {
    case 'up':
      return { top: -TIP_ARROW_PROTRUDE }
    case 'left':
      return { left: -TIP_ARROW_PROTRUDE }
    case 'right':
      return { right: -TIP_ARROW_PROTRUDE }
    default:
      return { bottom: -TIP_ARROW_PROTRUDE }
  }
}

/** Shared speech-bubble caret for StatusTip / Tooltip / ContextMenu / minimap Quick View. */
export function TipArrow({ direction = 'down', className = '', style, ref }: TipArrowProps) {
  const { width, height } = isoscelesCaretSize(TIP_ARROW_W, TIP_ARROW_H, direction)
  return (
    <svg
      ref={ref}
      aria-hidden
      data-tip-arrow
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      overflow="visible"
      className={`pointer-events-none absolute block text-fg-muted ${className}`.trim()}
      style={{
        ...tipArrowEdgeStyle(direction),
        ...style,
      }}
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={CARET_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        d={isoscelesChevronPath(TIP_ARROW_W, TIP_ARROW_H, direction)}
      />
    </svg>
  )
}
