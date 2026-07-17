import { describe, expect, it } from 'vitest'
import { getTooltipPosition } from './Tooltip'

const trigger = {
  left: 100,
  right: 128,
  top: 40,
  bottom: 68,
  width: 28,
  height: 28,
}

const tip = { width: 72, height: 24 }
const viewport = { width: 400, height: 300 }

describe('getTooltipPosition', () => {
  it('centers bottom tooltips under the trigger once tip size is known', () => {
    const style = getTooltipPosition(trigger, 'bottom', tip, viewport)
    expect(style.left).toBe(100 + 14 - 36)
    expect(style.top).toBe(68 + 8)
    expect(style.transform).toBe('none')
  })

  it('centers top tooltips over the trigger once tip size is known', () => {
    const style = getTooltipPosition(trigger, 'top', tip, viewport)
    expect(style.left).toBe(100 + 14 - 36)
    expect(style.top).toBe(40 - 8 - 24)
    expect(style.transform).toBe('none')
  })

  it('clamps bottom tooltips that would overflow the right edge', () => {
    const nearRight = {
      left: 360,
      right: 388,
      top: 40,
      bottom: 68,
      width: 28,
      height: 28,
    }
    const style = getTooltipPosition(nearRight, 'bottom', tip, viewport)
    const idealLeft = nearRight.left + nearRight.width / 2 - tip.width / 2
    // Prefer staying on-screen over perfect centering when clipped.
    expect(style.left).toBe(400 - 72 - 8)
    expect(style.left).toBeLessThan(idealLeft)
  })

  it('uses transform centering before tip size is measured', () => {
    const style = getTooltipPosition(trigger, 'bottom')
    expect(style.left).toBe(100 + 14)
    expect(style.transform).toBe('translateX(-50%)')
  })
})
