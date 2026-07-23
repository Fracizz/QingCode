/** 60° vertex isosceles fold gutter chevrons (editor line-number gutter only). */

const FOLD_MARKER_VERTEX_DEG = 60

/** Fold gutter chevron span at 14px editor font (scales via CSS `em`). */
export const FOLD_MARKER_BASE_FONT = 14
export const FOLD_MARKER_W = 8
export const FOLD_MARKER_H =
  (FOLD_MARKER_W / 2) / Math.tan(((FOLD_MARKER_VERTEX_DEG / 2) * Math.PI) / 180)
/** Chevron width as `em` (8px when editor font-size is 14px). */
export const FOLD_MARKER_W_EM = FOLD_MARKER_W / FOLD_MARKER_BASE_FONT
/** Fold gutter column width at base font (13px). */
export const FOLD_GUTTER_W_EM = 13 / FOLD_MARKER_BASE_FONT
const FOLD_MARKER_STROKE = 1.25
const FOLD_MARKER_INSET = 0.5

function foldGutterMarkerSize(open: boolean): { width: number; height: number } {
  return open
    ? { width: FOLD_MARKER_W, height: FOLD_MARKER_H }
    : { width: FOLD_MARKER_H, height: FOLD_MARKER_W }
}

/** 60° hollow chevron paths with slight inset for a tighter silhouette. */
export function foldGutterMarkerPath(open: boolean): string {
  const w = FOLD_MARKER_W
  const h = FOLD_MARKER_H
  const i = FOLD_MARKER_INSET
  if (open) return `M ${i} 0 L ${w / 2} ${h} L ${w - i} 0`
  return `M 0 ${i} L ${h} ${w / 2} L 0 ${w - i}`
}

function applyFoldGutterStroke(path: SVGPathElement): void {
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', String(FOLD_MARKER_STROKE))
  path.setAttribute('stroke-linecap', 'butt')
  path.setAttribute('stroke-linejoin', 'round')
}

/** SVG caret for CodeMirror `foldGutter({ markerDOM })`. */
export function createFoldGutterMarker(open: boolean): HTMLElement {
  const { width, height } = foldGutterMarkerSize(open)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('overflow', 'visible')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('cm-foldGutter-marker')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', foldGutterMarkerPath(open))
  applyFoldGutterStroke(path)
  svg.appendChild(path)
  return svg as unknown as HTMLElement
}

export { foldGutterMarkerSize }
