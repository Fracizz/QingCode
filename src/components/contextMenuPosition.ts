/** Viewport margin when clamping a fixed menu. */
const MARGIN = 8

/**
 * Convert viewport-space anchor coords into `position: fixed` style coords.
 *
 * `.ui-font-scaled` applies CSS `zoom`, which multiplies `left`/`top`. Callers
 * pass viewport coordinates (e.g. from `getBoundingClientRect`); this returns
 * pre-zoom style values so the menu stays on-screen when interface font scale ≠ 1.
 */
export function getContextMenuStylePosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  preferAbove: boolean,
  zoom: number,
): { x: number; y: number; maxHeight: number } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const maxHeightVisual = Math.max(120, viewport.height - MARGIN * 2)
  const widthVisual = size.width * z
  const heightVisual = Math.min(size.height * z, maxHeightVisual)
  const nextX = Math.max(MARGIN, Math.min(x, viewport.width - widthVisual - MARGIN))
  const rawY = preferAbove ? y - heightVisual : y
  const nextY = Math.max(MARGIN, Math.min(rawY, viewport.height - heightVisual - MARGIN))
  return {
    x: nextX / z,
    y: nextY / z,
    maxHeight: maxHeightVisual / z,
  }
}
