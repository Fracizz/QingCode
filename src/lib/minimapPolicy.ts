import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'

/** Full sampled thumbnail with token coloring (≤1MB). */
export const MINIMAP_FULL_MAX_BYTES = 1 * 1024 * 1024

/** Hide minimap above this size (aligned with degraded edit band). */
export const MINIMAP_HIDE_BYTES = EDIT_DEGRADED_BYTES

/** CodeGlance-style fixed scale: wider default so character blocks stay readable. */
export const MINIMAP_WIDTH_DEFAULT = 120
export const MINIMAP_WIDTH_MIN = 80
export const MINIMAP_WIDTH_MAX = 360
/** Space that resizing must leave for the actual editor content. */
export const MINIMAP_EDITOR_SAFE_WIDTH = 360
export const MINIMAP_WIDTH_STORAGE_KEY = 'qingcode:minimap-width'
export const MINIMAP_HIDE_SCROLLBAR_KEY = 'qingcode:minimap-hide-scrollbar'
export const MINIMAP_HOVER_SHOW_KEY = 'qingcode:minimap-hover-show'

/** Canvas paint style: shrunken monospace (default); density tier forces blocks. */
export type MinimapPaintStyle = 'text' | 'blocks'
export const MINIMAP_STYLE_DEFAULT: MinimapPaintStyle = 'text'

/** CSS pixels per source character (block mode, full tier). */
export const MINIMAP_CHAR_WIDTH = 3
/** CSS pixels per source line (block mode). Long files still scroll the glance window. */
export const MINIMAP_CHAR_HEIGHT = 4
/** Slightly tighter scale for density mode (1–5MB). */
export const MINIMAP_CHAR_WIDTH_DENSITY = 2
export const MINIMAP_CHAR_HEIGHT_DENSITY = 3

/** Text mode: 8px mono with ~4.8px advance (VS Code–style code texture). */
export const MINIMAP_TEXT_FONT_SIZE = 8
export const MINIMAP_TEXT_LINE_HEIGHT = 10
export const MINIMAP_TEXT_CHAR_WIDTH = 4.8

/** Min interval between canvas repaints after doc changes (ms). */
export const MINIMAP_REPAINT_THROTTLE_MS = 48

export const MINIMAP_VIEWPORT_MIN_HEIGHT = 8
/** Minimum height of the left CodeGlance-style scroll thumb (px). */
export const MINIMAP_SCROLLBAR_THUMB_MIN = 24
/** Right scrollbar track width reserved beside the glance canvas (px). */
export const MINIMAP_SCROLLBAR_WIDTH = 12

/** Quick-view hover delay before showing the source peek (ms). */
export const MINIMAP_QUICK_VIEW_DELAY_MS = 500
/** Gap between Quick View panel and the minimap left edge (px). */
export const MINIMAP_QUICK_VIEW_GAP = 12
/** Lines shown above/below the hovered line in Quick View. */
export const MINIMAP_QUICK_VIEW_RADIUS = 6
/** Delay before folding the glance after the pointer leaves (ms). */
export const MINIMAP_HOVER_COLLAPSE_DELAY_MS = 140

export type MinimapRenderMode = 'full' | 'density' | 'hidden'

export type MinimapCharSize = {
  charWidth: number
  charHeight: number
}

export function resolveMinimapPaintStyle(
  mode: MinimapRenderMode,
  preferred: MinimapPaintStyle,
): MinimapPaintStyle {
  if (mode === 'density') return 'blocks'
  return preferred
}

export function resolveMinimapCharSize(
  mode: MinimapRenderMode,
  style: MinimapPaintStyle = MINIMAP_STYLE_DEFAULT,
): MinimapCharSize {
  const effective = resolveMinimapPaintStyle(mode, style)
  if (effective === 'text' && mode === 'full') {
    return { charWidth: MINIMAP_TEXT_CHAR_WIDTH, charHeight: MINIMAP_TEXT_LINE_HEIGHT }
  }
  if (mode === 'density') {
    return { charWidth: MINIMAP_CHAR_WIDTH_DENSITY, charHeight: MINIMAP_CHAR_HEIGHT_DENSITY }
  }
  return { charWidth: MINIMAP_CHAR_WIDTH, charHeight: MINIMAP_CHAR_HEIGHT }
}

/** Prefer disk `fileSize`; fall back to CM `doc.length` when unknown. */
export function resolveMinimapByteSize(
  fileSize: number | undefined | null,
  docLength: number,
): number {
  if (typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize >= 0) {
    return Math.floor(fileSize)
  }
  return Math.max(0, Math.floor(docLength))
}

export function resolveMinimapMode(byteSize: number): MinimapRenderMode {
  if (!Number.isFinite(byteSize) || byteSize < 0) return 'full'
  if (byteSize > MINIMAP_HIDE_BYTES) return 'hidden'
  if (byteSize > MINIMAP_FULL_MAX_BYTES) return 'density'
  return 'full'
}

export type MinimapLineSample = {
  lineNumber: number
  y: number
}

/**
 * Visible window of source lines at a fixed char height (CodeGlance scale).
 * Long files scroll through this window instead of compressing to 1px rows.
 */
export function resolveMinimapVisibleLines(
  totalLines: number,
  mapHeight: number,
  scrollOffset: number,
  charHeight: number,
): MinimapLineSample[] {
  const lines = Math.max(1, Math.floor(totalLines))
  const height = Math.max(0, Math.floor(mapHeight))
  const step = Math.max(1, Math.floor(charHeight))
  if (height <= 0) return []

  const first = Math.max(1, Math.floor(scrollOffset / step) + 1)
  const last = Math.min(lines, Math.ceil((scrollOffset + height) / step))
  const samples: MinimapLineSample[] = []
  for (let lineNumber = first; lineNumber <= last; lineNumber++) {
    samples.push({
      lineNumber,
      y: Math.round((lineNumber - 1) * step - scrollOffset),
    })
  }
  return samples
}

/** @deprecated Prefer resolveMinimapVisibleLines — kept for proportional sampling tests. */
export function resolveMinimapLineSamples(
  totalLines: number,
  cssHeight: number,
): MinimapLineSample[] {
  const lines = Math.max(1, Math.floor(totalLines))
  const height = Math.max(0, Math.floor(cssHeight))
  const count = Math.min(lines, height)
  if (count <= 0) return []
  if (count === 1) return [{ lineNumber: 1, y: 0 }]

  return Array.from({ length: count }, (_, index) => ({
    lineNumber: Math.round((index * (lines - 1)) / (count - 1)) + 1,
    y: Math.round((index * (height - 1)) / (count - 1)),
  }))
}

export function resolveMinimapContentHeight(totalLines: number, charHeight: number): number {
  return Math.max(Math.max(1, Math.floor(charHeight)), Math.max(1, Math.floor(totalLines)) * Math.max(1, Math.floor(charHeight)))
}

/** How far the scaled content is scrolled within the minimap viewport. */
export function resolveMinimapScrollOffset(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  contentHeight: number,
  mapHeight: number,
): number {
  const overflow = Math.max(0, contentHeight - Math.max(0, mapHeight))
  if (overflow === 0) return 0
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  if (maxScroll === 0) return 0
  const clampedScrollTop = Math.min(maxScroll, Math.max(0, scrollTop))
  return (clampedScrollTop / maxScroll) * overflow
}

export type MinimapViewport = {
  top: number
  height: number
}

/**
 * Classic document scrollbar thumb for the left glance rail
 * (replaces the hidden editor scrollbar visually).
 */
export function resolveMinimapScrollbarThumb(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
): MinimapViewport {
  const safeTrack = Math.max(0, trackHeight)
  if (safeTrack === 0) return { top: 0, height: 0 }

  const safeScrollHeight = Math.max(1, scrollHeight)
  const safeClientHeight = Math.max(0, clientHeight)
  const maxScroll = Math.max(0, safeScrollHeight - safeClientHeight)
  if (maxScroll === 0) {
    return { top: 0, height: safeTrack }
  }

  const height = Math.min(
    safeTrack,
    Math.max(MINIMAP_SCROLLBAR_THUMB_MIN, (safeClientHeight / safeScrollHeight) * safeTrack),
  )
  const clampedScrollTop = Math.min(maxScroll, Math.max(0, scrollTop))
  const top = (clampedScrollTop / maxScroll) * (safeTrack - height)
  return { top, height }
}

/**
 * Viewport indicator for fixed-scale content.
 * When content fits the map, behaves like a classic ratio viewport;
 * when taller, tracks the editor window inside the scrolling glance.
 */
export function resolveMinimapViewport(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  mapHeight: number,
  contentHeight = mapHeight,
  scrollOffset = 0,
): MinimapViewport {
  const safeMapHeight = Math.max(0, mapHeight)
  if (safeMapHeight === 0) return { top: 0, height: 0 }

  const safeScrollHeight = Math.max(1, scrollHeight)
  const safeClientHeight = Math.max(0, clientHeight)
  const safeContentHeight = Math.max(safeMapHeight, contentHeight)
  const maxScroll = Math.max(0, safeScrollHeight - safeClientHeight)

  if (maxScroll === 0 || safeContentHeight <= safeMapHeight) {
    const height =
      maxScroll === 0
        ? safeMapHeight
        : Math.min(
            safeMapHeight,
            Math.max(
              MINIMAP_VIEWPORT_MIN_HEIGHT,
              (safeClientHeight / safeScrollHeight) * safeMapHeight,
            ),
          )
    const clampedScrollTop = Math.min(maxScroll, Math.max(0, scrollTop))
    const top = maxScroll === 0 ? 0 : (clampedScrollTop / maxScroll) * (safeMapHeight - height)
    return { top, height }
  }

  const height = Math.min(
    safeMapHeight,
    Math.max(
      MINIMAP_VIEWPORT_MIN_HEIGHT,
      (safeClientHeight / safeScrollHeight) * safeContentHeight,
    ),
  )
  const contentTop = (Math.min(maxScroll, Math.max(0, scrollTop)) / safeScrollHeight) * safeContentHeight
  const top = Math.min(safeMapHeight - height, Math.max(0, contentTop - scrollOffset))
  return { top, height }
}

/** Map a 1-based source line to a y pixel inside the scaled minimap window. */
export function resolveMinimapLineY(
  lineNumber: number,
  charHeight: number,
  scrollOffset: number,
): number {
  const step = Math.max(1, Math.floor(charHeight))
  const clamped = Math.max(1, Math.floor(lineNumber))
  return Math.round((clamped - 1) * step - scrollOffset)
}

/** Map a click/hover y inside the minimap to a 1-based source line. */
export function resolveMinimapLineAtY(
  clientOffsetY: number,
  charHeight: number,
  scrollOffset: number,
  totalLines: number,
): number {
  const lines = Math.max(1, Math.floor(totalLines))
  const step = Math.max(1, Math.floor(charHeight))
  const contentY = Math.max(0, clientOffsetY) + Math.max(0, scrollOffset)
  return Math.min(lines, Math.max(1, Math.floor(contentY / step) + 1))
}

export function resolveMinimapMaxWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return MINIMAP_WIDTH_MAX
  return Math.max(
    MINIMAP_WIDTH_MIN,
    Math.min(MINIMAP_WIDTH_MAX, Math.floor(containerWidth - MINIMAP_EDITOR_SAFE_WIDTH)),
  )
}

/**
 * Panel width used when sizing the glance canvas.
 * Expanded panels must track the live DOM width (drag / CSS transition);
 * the hover-collapsed rail is ~scrollbar-only, so fall back to the saved width.
 */
export function resolveMinimapPaintPanelWidth(
  rootClientWidth: number,
  savedWidth: number,
): number {
  const root = Number.isFinite(rootClientWidth) ? Math.max(0, rootClientWidth) : 0
  const saved = Number.isFinite(savedWidth) ? Math.max(0, savedWidth) : 0
  if (root <= MINIMAP_SCROLLBAR_WIDTH + 1) {
    return Math.max(saved, MINIMAP_WIDTH_DEFAULT)
  }
  return root
}

export function clampMinimapWidth(width: number, maxWidth = MINIMAP_WIDTH_MAX): number {
  if (!Number.isFinite(width)) return MINIMAP_WIDTH_DEFAULT
  const safeMax = Math.max(MINIMAP_WIDTH_MIN, Math.min(MINIMAP_WIDTH_MAX, maxWidth))
  return Math.min(safeMax, Math.max(MINIMAP_WIDTH_MIN, Math.round(width)))
}

export function loadMinimapWidth(): number {
  if (typeof localStorage === 'undefined') return MINIMAP_WIDTH_DEFAULT
  try {
    const raw = localStorage.getItem(MINIMAP_WIDTH_STORAGE_KEY)
    if (raw == null) return MINIMAP_WIDTH_DEFAULT
    return clampMinimapWidth(Number(raw))
  } catch {
    return MINIMAP_WIDTH_DEFAULT
  }
}

export function saveMinimapWidth(width: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(MINIMAP_WIDTH_STORAGE_KEY, String(clampMinimapWidth(width)))
  } catch {
    // ignore quota / private mode
  }
}

/** When true (default), hide the editor vertical scrollbar while the minimap is shown. */
export function loadMinimapHideScrollbar(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    const raw = localStorage.getItem(MINIMAP_HIDE_SCROLLBAR_KEY)
    if (raw == null) return true
    return raw !== '0' && raw !== 'false'
  } catch {
    return true
  }
}

export function saveMinimapHideScrollbar(hide: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(MINIMAP_HIDE_SCROLLBAR_KEY, hide ? '1' : '0')
  } catch {
    // ignore quota / private mode
  }
}

/** When true, collapse to the scroll rail until the pointer hovers it. */
export function loadMinimapHoverShow(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    const raw = localStorage.getItem(MINIMAP_HOVER_SHOW_KEY)
    if (raw == null) return false
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

export function saveMinimapHoverShow(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(MINIMAP_HOVER_SHOW_KEY, enabled ? '1' : '0')
  } catch {
    // ignore quota / private mode
  }
}
