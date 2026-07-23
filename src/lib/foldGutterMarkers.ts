import {
  applyChevronStroke,
  CARET_VERTEX_DEG,
  isoscelesCaretHeight,
  isoscelesCaretSize,
} from './isoscelesArrowGeometry'

/** Fold gutter chevron span at {@link FOLD_MARKER_BASE_FONT}px editor font (scales via CSS `em`). */
export const FOLD_MARKER_BASE_FONT = 14
export const FOLD_MARKER_W = 8
export const FOLD_MARKER_H = isoscelesCaretHeight(FOLD_MARKER_W, CARET_VERTEX_DEG)
/** Chevron width as `em` (8px when editor font-size is 14px). */
export const FOLD_MARKER_W_EM = FOLD_MARKER_W / FOLD_MARKER_BASE_FONT
/** Fold gutter column width at base font (13px). */
export const FOLD_GUTTER_W_EM = 13 / FOLD_MARKER_BASE_FONT
/** Thinner stroke + butt caps so round ends do not read as a wide shallow V. */
export const FOLD_MARKER_STROKE = 1.25
const FOLD_MARKER_INSET = 0.5

/** 60° hollow chevron paths with slight inset for a tighter silhouette. */
export function foldGutterMarkerPath(open: boolean): string {
  const w = FOLD_MARKER_W
  const h = FOLD_MARKER_H
  const i = FOLD_MARKER_INSET
  if (open) return `M ${i} 0 L ${w / 2} ${h} L ${w - i} 0`
  return `M 0 ${i} L ${h} ${w / 2} L 0 ${w - i}`
}

export function foldGutterMarkerSize(open: boolean): { width: number; height: number } {
  return isoscelesCaretSize(FOLD_MARKER_W, FOLD_MARKER_H, open ? 'down' : 'right')
}

/** SVG caret for CodeMirror `foldGutter({ markerDOM })` — compact hollow 60° chevron. */
export function createFoldGutterMarker(open: boolean): HTMLElement {
  const { width, height } = foldGutterMarkerSize(open)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('overflow', 'visible')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('cm-foldGutter-marker')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', foldGutterMarkerPath(open))
  applyChevronStroke(path, 'currentColor', FOLD_MARKER_STROKE, 'butt')
  svg.appendChild(path)
  return svg as unknown as HTMLElement
}
