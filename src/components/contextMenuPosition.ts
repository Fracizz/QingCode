/** Viewport margin when clamping a fixed menu. */
const MARGIN = 8

export type ContextMenuPositionOptions = {
  /**
   * Extra gap below the menu when opening upward, in **viewport pixels**
   * (same space as `y` from getBoundingClientRect). Includes caret height.
   */
  arrowGap?: number
}

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
  options?: ContextMenuPositionOptions,
): { x: number; y: number; maxHeight: number } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  // arrowGap is already viewport px (do not multiply by zoom again).
  const arrowGap = Math.max(0, options?.arrowGap ?? 0)
  const widthVisual = size.width * z

  let maxHeightVisual = Math.max(120, viewport.height - MARGIN * 2)
  if (preferAbove) {
    // Keep the menu (+ tip arrow) entirely above the anchor instead of
    // clamping top and letting the bottom overlap the status bar.
    const available = Math.max(80, y - arrowGap - MARGIN)
    maxHeightVisual = Math.min(maxHeightVisual, available)
  }

  const heightVisual = Math.min(size.height * z, maxHeightVisual)
  const nextX = Math.max(MARGIN, Math.min(x, viewport.width - widthVisual - MARGIN))
  const rawY = preferAbove ? y - heightVisual - arrowGap : y
  const nextY = preferAbove
    ? Math.max(MARGIN, rawY)
    : Math.max(MARGIN, Math.min(rawY, viewport.height - heightVisual - MARGIN))

  return {
    x: nextX / z,
    y: nextY / z,
    maxHeight: maxHeightVisual / z,
  }
}
