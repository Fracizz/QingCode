import type { CSSProperties, Ref } from 'react'

/** Shared tip-caret metrics for StatusTip / Tooltip / encoding ContextMenu. */

export const TIP_ARROW_W = 12
export const TIP_ARROW_H = 7
/** Local CSS px the caret hangs past the bubble (`bottom: -PROTRUDE`). */
export const TIP_ARROW_PROTRUDE = TIP_ARROW_H - 1
/** Desired viewport gap: caret tip → status-bar row top (or anchor top). */
export const TIP_ARROW_CLEARANCE = 2
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

/** Soft tip radius in viewBox units (subtle, not a blunt oval). */
const TIP_R = 1.15

/**
 * Downward caret: base along y=0, rounded tip at bottom center.
 * Slight quadratic at the point so the beak isn’t razor-sharp.
 */
const PATH_DOWN = [
  `M 0 0`,
  `H ${TIP_ARROW_W}`,
  `L ${TIP_ARROW_W / 2 + TIP_R * 0.85} ${TIP_ARROW_H - TIP_R}`,
  `Q ${TIP_ARROW_W / 2} ${TIP_ARROW_H} ${TIP_ARROW_W / 2 - TIP_R * 0.85} ${TIP_ARROW_H - TIP_R}`,
  `Z`,
].join(' ')

const PATH_UP = [
  `M 0 ${TIP_ARROW_H}`,
  `H ${TIP_ARROW_W}`,
  `L ${TIP_ARROW_W / 2 + TIP_R * 0.85} ${TIP_R}`,
  `Q ${TIP_ARROW_W / 2} 0 ${TIP_ARROW_W / 2 - TIP_R * 0.85} ${TIP_R}`,
  `Z`,
].join(' ')

type TipArrowProps = {
  /** `down` = tip below the bubble (StatusTip / encoding menu). */
  direction?: 'down' | 'up'
  className?: string
  style?: CSSProperties
  /** Forwarded for layout measurement (caret tip → trigger clearance). */
  ref?: Ref<SVGSVGElement>
}

/** Shared speech-bubble caret for StatusTip / Tooltip / ContextMenu. */
export function TipArrow({ direction = 'down', className = '', style, ref }: TipArrowProps) {
  return (
    <svg
      ref={ref}
      aria-hidden
      data-tip-arrow
      width={TIP_ARROW_W}
      height={TIP_ARROW_H}
      viewBox={`0 0 ${TIP_ARROW_W} ${TIP_ARROW_H}`}
      className={`pointer-events-none absolute block ${className}`.trim()}
      style={{
        ...(direction === 'down' ? { bottom: -TIP_ARROW_PROTRUDE } : { top: -TIP_ARROW_PROTRUDE }),
        ...style,
      }}
    >
      <path fill="var(--color-bg-elevated)" d={direction === 'down' ? PATH_DOWN : PATH_UP} />
    </svg>
  )
}
