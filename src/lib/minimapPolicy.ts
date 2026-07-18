import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'

/** Full sampled thumbnail with light coloring (≤ 1MB). */
export const MINIMAP_FULL_MAX_BYTES = 1 * 1024 * 1024

/** Hide minimap above this size (aligned with degraded edit band). */
export const MINIMAP_HIDE_BYTES = EDIT_DEGRADED_BYTES

export const MINIMAP_WIDTH_DEFAULT = 96
export const MINIMAP_WIDTH_MIN = 64
export const MINIMAP_WIDTH_MAX = 180
export const MINIMAP_WIDTH_STORAGE_KEY = 'qingcode:minimap-width'

/** Min interval between canvas repaints after doc changes (ms). */
export const MINIMAP_REPAINT_THROTTLE_MS = 48

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

export function clampMinimapWidth(width: number): number {
  if (!Number.isFinite(width)) return MINIMAP_WIDTH_DEFAULT
  return Math.min(MINIMAP_WIDTH_MAX, Math.max(MINIMAP_WIDTH_MIN, Math.round(width)))
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
