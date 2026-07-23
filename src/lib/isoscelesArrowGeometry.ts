/** Vertex angle (at the tip) for shared UI carets — 60° isosceles. */
export const CARET_VERTEX_DEG = 60

/** Stroke width for hollow chevron carets (fold gutter, TipArrow, etc.). */
export const CARET_STROKE_WIDTH = 1.5

/** Height of a downward-pointing isosceles caret with the given base width and tip angle. */
export function isoscelesCaretHeight(
  width: number,
  vertexDeg: number = CARET_VERTEX_DEG,
): number {
  const halfRad = ((vertexDeg / 2) * Math.PI) / 180
  return (width / 2) / Math.tan(halfRad)
}

export type CaretDirection = 'down' | 'up' | 'left' | 'right'

/**
 * Hollow chevron (open V): two legs only, no fill and no closing edge on the base.
 * Down: top-left → tip → top-right (no segment along the top).
 */
export function isoscelesChevronPath(
  width: number,
  height: number,
  direction: CaretDirection,
): string {
  const w = width
  const h = height
  switch (direction) {
    case 'up':
      return `M 0 ${h} L ${w / 2} 0 L ${w} ${h}`
    case 'left':
      return `M ${h} 0 L 0 ${w / 2} L ${h} ${w}`
    case 'right':
      return `M 0 0 L ${h} ${w / 2} L 0 ${w}`
    default:
      return `M 0 0 L ${w / 2} ${h} L ${w} 0`
  }
}

/** @deprecated Filled triangle; prefer {@link isoscelesChevronPath} for UI carets. */
export function isoscelesCaretPath(
  width: number,
  height: number,
  direction: CaretDirection,
): string {
  const w = width
  const h = height
  switch (direction) {
    case 'up':
      return `M 0 ${h} H ${w} L ${w / 2} 0 Z`
    case 'left':
      return `M ${h} 0 V ${w} L 0 ${w / 2} Z`
    case 'right':
      return `M 0 0 V ${w} L ${h} ${w / 2} Z`
    default:
      return `M 0 0 H ${w} L ${w / 2} ${h} Z`
  }
}

export function isoscelesCaretSize(
  width: number,
  height: number,
  direction: CaretDirection,
): { width: number; height: number } {
  const horizontal = direction === 'left' || direction === 'right'
  return horizontal ? { width: height, height: width } : { width, height }
}

export function applyChevronStroke(
  path: SVGPathElement,
  stroke = 'currentColor',
  strokeWidth = CARET_STROKE_WIDTH,
  linecap: 'round' | 'butt' = 'round',
): void {
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', stroke)
  path.setAttribute('stroke-width', String(strokeWidth))
  path.setAttribute('stroke-linecap', linecap)
  path.setAttribute('stroke-linejoin', 'round')
}
