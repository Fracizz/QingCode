import { describe, expect, it } from 'vitest'
import { getContextMenuStylePosition } from './contextMenuPosition'

describe('getContextMenuStylePosition', () => {
  it('keeps zoom=1 coords in viewport space', () => {
    const placed = getContextMenuStylePosition(
      100,
      40,
      { width: 220, height: 80 },
      { width: 1280, height: 800 },
      false,
      1,
    )
    expect(placed.x).toBe(100)
    expect(placed.y).toBe(40)
    expect(placed.maxHeight).toBe(784)
  })

  it('divides by zoom so a right-edge menu stays on-screen', () => {
    const zoom = 16 / 13
    // Viewport anchor from a top-right tab overflow button (CSS px).
    const anchorX = 1280 - 220
    const placed = getContextMenuStylePosition(
      anchorX,
      83,
      { width: 220, height: 40 },
      { width: 1280, height: 800 },
      false,
      zoom,
    )
    // Visual left = style.left * zoom must stay within the viewport.
    const visualLeft = placed.x * zoom
    const visualWidth = 220 * zoom
    expect(visualLeft).toBeGreaterThanOrEqual(8)
    expect(visualLeft + visualWidth).toBeLessThanOrEqual(1280 - 8)
    // Without zoom compensation, left:1060 with zoom would paint at ~1305 (off-screen).
    expect(visualLeft).toBeLessThan(1280)
  })

  it('opens upward when preferAbove is set', () => {
    const placed = getContextMenuStylePosition(
      100,
      700,
      { width: 220, height: 120 },
      { width: 1280, height: 800 },
      true,
      1,
    )
    expect(placed.y).toBe(580)
  })
})
