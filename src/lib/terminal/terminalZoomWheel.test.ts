import { describe, expect, it } from 'vitest'
import { createTerminalZoomWheel } from './terminalZoomWheel'

const wheel = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 })

describe('createTerminalZoomWheel', () => {
  it('maps one mouse notch to one step, up to zoom in and down to zoom out', () => {
    const zoom = createTerminalZoomWheel()
    expect(zoom(wheel(-100))).toBe(1)
    expect(zoom(wheel(100))).toBe(-1)
  })

  it('does not jump several sizes for a large high-DPI delta', () => {
    const zoom = createTerminalZoomWheel()
    expect(zoom(wheel(-480))).toBe(1)
    expect(zoom(wheel(-1))).toBe(0)
  })

  it('accumulates small touchpad deltas and drops them on reversal', () => {
    const zoom = createTerminalZoomWheel()
    expect(zoom(wheel(-30))).toBe(0)
    expect(zoom(wheel(30))).toBe(0)
    expect(zoom(wheel(-30))).toBe(0)
    expect(zoom(wheel(-30))).toBe(1)
  })

  it('normalizes line-based wheel events', () => {
    expect(createTerminalZoomWheel()(wheel(-3, 1))).toBe(1)
    expect(createTerminalZoomWheel()(wheel(1, 1))).toBe(0)
  })
})
