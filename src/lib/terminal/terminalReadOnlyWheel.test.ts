import { describe, expect, it } from 'vitest'
import { createReadOnlyTerminalWheel } from './terminalReadOnlyWheel'

const PIXEL = 0
const LINE = 1
const PAGE = 2
const wheel = (deltaY: number, deltaMode = PIXEL, altKey = false) => ({
  deltaY,
  deltaMode,
  altKey,
  DOM_DELTA_LINE: LINE,
  DOM_DELTA_PAGE: PAGE,
})
const grid = { cellHeight: 20, rows: 30 }

describe('createReadOnlyTerminalWheel', () => {
  it('converts mouse wheel pixels to lines, negative when scrolling up', () => {
    const step = createReadOnlyTerminalWheel()
    expect(step(wheel(-100), grid)).toBe(-5)
    expect(step(wheel(100), grid)).toBe(5)
  })

  it('accumulates small trackpad deltas instead of dropping them', () => {
    const step = createReadOnlyTerminalWheel()
    expect(step(wheel(-8), grid)).toBe(0)
    expect(step(wheel(-8), grid)).toBe(0)
    expect(step(wheel(-8), grid)).toBe(-1)
  })

  it('drops the leftover of the previous direction when reversing', () => {
    const step = createReadOnlyTerminalWheel()
    expect(step(wheel(-15), grid)).toBe(0)
    expect(step(wheel(15), grid)).toBe(0)
    expect(step(wheel(10), grid)).toBe(1)
  })

  it('handles line and page delta modes and the fast-scroll modifier', () => {
    const step = createReadOnlyTerminalWheel()
    expect(step(wheel(-3, LINE), grid)).toBe(-3)
    expect(step(wheel(1, PAGE), grid)).toBe(30)
    expect(step(wheel(-20, PIXEL, true), { ...grid, fastSensitivity: 5 })).toBe(-5)
  })

  it('ignores events without a usable grid', () => {
    const step = createReadOnlyTerminalWheel()
    expect(step(wheel(-100), { cellHeight: 0, rows: 30 })).toBe(0)
    expect(step(wheel(0), grid)).toBe(0)
  })
})
