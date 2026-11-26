import { describe, expect, it } from 'vitest'
import { FOLLOW_FONT_MAX, FOLLOW_FONT_MIN, followFitFontSize, followTerminalGrid, gridForCell } from './terminalFollowFit'

/** 字格近似按字号线性缩放：14px 时 8.4 x 17。 */
const cellAt = (font: number) => ({ width: font * 0.6, height: font * (17 / 14) })

/** 模拟调用方：改字号后按新字格再算，直到不再变化。 */
function settle(area: { width: number; height: number }, grid: { cols: number; rows: number }, base = 14) {
  let font = base
  for (let i = 0; i < 6; i++) {
    const next = followFitFontSize({ area, grid, cell: cellAt(font), fontSize: font, baseFontSize: base })
    if (next === font) return font
    font = next
  }
  return font
}

describe('gridForCell', () => {
  it('matches FitAddon rounding and minimums', () => {
    expect(gridForCell({ width: 1000, height: 500 }, { width: 8.4, height: 17 })).toEqual({ cols: 119, rows: 29 })
    expect(gridForCell({ width: 5, height: 5 }, { width: 8.4, height: 17 })).toEqual({ cols: 2, rows: 1 })
    expect(gridForCell({ width: 0, height: 500 }, { width: 8.4, height: 17 })).toBeUndefined()
    expect(gridForCell({ width: 100, height: 500 }, { width: 0, height: 17 })).toBeUndefined()
  })
})

describe('followFitFontSize', () => {
  it('enlarges a phone grid to fill a wide desktop window and stays inside it', () => {
    const area = { width: 1200, height: 700 }
    const grid = { cols: 60, rows: 25 }
    const font = settle(area, grid)
    expect(font).toBeGreaterThan(14)
    expect(Number.isInteger(font)).toBe(true)
    const cell = cellAt(font)
    expect(grid.cols * cell.width).toBeLessThanOrEqual(area.width)
    expect(grid.rows * cell.height).toBeLessThanOrEqual(area.height)
    // 2% 余量加 5% 收敛阈值：最多差一号，再大两号就放不下，确实铺满了较窄的那一边。
    const bigger = cellAt(font + 2)
    expect(grid.cols * bigger.width > area.width || grid.rows * bigger.height > area.height).toBe(true)
  })

  it('shrinks a wide tablet grid into a narrow pane with one decimal precision', () => {
    const area = { width: 600, height: 700 }
    const grid = { cols: 140, rows: 40 }
    const font = settle(area, grid)
    expect(font).toBeLessThan(14)
    expect(Math.round(font * 10)).toBe(font * 10)
    expect(grid.cols * cellAt(font).width).toBeLessThanOrEqual(area.width)
  })

  it('keeps the current size when it already fits with less than 5% spare room', () => {
    const cell = cellAt(14)
    const area = { width: 60 * cell.width * 1.03, height: 25 * cell.height * 1.5 }
    expect(followFitFontSize({ area, grid: { cols: 60, rows: 25 }, cell, fontSize: 14, baseFontSize: 14 })).toBe(14)
  })

  it('clamps to the configured bounds and never caps below the user font', () => {
    const huge = { width: 10000, height: 10000 }
    expect(settle(huge, { cols: 20, rows: 5 })).toBe(FOLLOW_FONT_MAX)
    const tiny = { width: 50, height: 50 }
    expect(settle(tiny, { cols: 200, rows: 60 })).toBe(FOLLOW_FONT_MIN)
    expect(followFitFontSize({
      area: huge, grid: { cols: 20, rows: 5 }, cell: cellAt(48), fontSize: 48, baseFontSize: 48,
    })).toBe(48)
  })

  it('ignores invalid measurements', () => {
    expect(followFitFontSize({
      area: { width: 0, height: 500 }, grid: { cols: 60, rows: 25 }, cell: cellAt(14), fontSize: 14, baseFontSize: 14,
    })).toBe(14)
  })
})

describe('followTerminalGrid', () => {
  it('keeps the desktop cols when following a narrower phone grid so widening back never reflows', () => {
    expect(followTerminalGrid({ cols: 45, rows: 30 }, { cols: 194, rows: 40 })).toEqual({ cols: 194, rows: 30 })
  })

  it('widens to a tablet grid that is wider than the desktop pane', () => {
    expect(followTerminalGrid({ cols: 250, rows: 50 }, { cols: 194, rows: 40 })).toEqual({ cols: 250, rows: 50 })
  })

  it('falls back to the remote grid without a desktop measurement', () => {
    expect(followTerminalGrid({ cols: 45, rows: 30 }, undefined)).toEqual({ cols: 45, rows: 30 })
  })
})

describe('followFitFontSize with maxFont at the user font', () => {
  it('does not enlarge a phone grid that already fits', () => {
    const cell = cellAt(14)
    expect(followFitFontSize({
      area: { width: 1200, height: 700 }, grid: { cols: 45, rows: 25 }, cell, fontSize: 14, baseFontSize: 14, maxFont: 14,
    })).toBe(14)
  })

  it('still shrinks when the remote rows do not fit', () => {
    const cell = cellAt(14)
    expect(followFitFontSize({
      area: { width: 1200, height: 400 }, grid: { cols: 45, rows: 40 }, cell, fontSize: 14, baseFontSize: 14, maxFont: 14,
    })).toBeLessThan(14)
  })
})
