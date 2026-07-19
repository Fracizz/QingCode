import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'

/** Full sampled thumbnail with light coloring (≤ 1MB). */
export const MINIMAP_FULL_MAX_BYTES = 1 * 1024 * 1024

/** Hide minimap above this size (aligned with degraded edit band). */
export const MINIMAP_HIDE_BYTES = EDIT_DEGRADED_BYTES

export const MINIMAP_WIDTH_DEFAULT = 96
export const MINIMAP_WIDTH_MIN = 64
export const MINIMAP_WIDTH_MAX = 180
/** Space that resizing must leave for the actual editor content. */
export const MINIMAP_EDITOR_SAFE_WIDTH = 360
export const MINIMAP_WIDTH_STORAGE_KEY = 'qingcode:minimap-width'

/** Min interval between canvas repaints after doc changes (ms). */
export const MINIMAP_REPAINT_THROTTLE_MS = 48

export const MINIMAP_VIEWPORT_MIN_HEIGHT = 8

export type MinimapRenderMode = 'full' | 'density' | 'hidden'

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

/** Sample at most one source line per canvas row, preserving the first and last line. */
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

export type MinimapViewport = {
  top: number
  height: number
}

/** Map editor scroll metrics to a viewport that always stays inside the minimap. */
export function resolveMinimapViewport(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  mapHeight: number,
): MinimapViewport {
  const safeMapHeight = Math.max(0, mapHeight)
  if (safeMapHeight === 0) return { top: 0, height: 0 }

  const safeScrollHeight = Math.max(1, scrollHeight)
  const safeClientHeight = Math.max(0, clientHeight)
  const maxScroll = Math.max(0, safeScrollHeight - safeClientHeight)
  const height =
    maxScroll === 0
      ? safeMapHeight
      : Math.min(
          safeMapHeight,
          Math.max(MINIMAP_VIEWPORT_MIN_HEIGHT, (safeClientHeight / safeScrollHeight) * safeMapHeight),
        )
  const clampedScrollTop = Math.min(maxScroll, Math.max(0, scrollTop))
  const top = maxScroll === 0 ? 0 : (clampedScrollTop / maxScroll) * (safeMapHeight - height)
  return { top, height }
}

export function resolveMinimapMaxWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return MINIMAP_WIDTH_MAX
  return Math.max(
    MINIMAP_WIDTH_MIN,
    Math.min(MINIMAP_WIDTH_MAX, Math.floor(containerWidth - MINIMAP_EDITOR_SAFE_WIDTH)),
  )
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
