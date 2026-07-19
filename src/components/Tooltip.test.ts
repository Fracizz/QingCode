import { describe, expect, it } from 'vitest'
import {
  getTooltipPosition,
  isOverflowing,
  OVERFLOW_TOOLTIP_DELAY,
  resolveOverflowElement,
} from './Tooltip'

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

describe('isOverflowing', () => {
  it('detects truncated text via scroll vs client width', () => {
    expect(isOverflowing({ scrollWidth: 120, clientWidth: 80 } as HTMLElement)).toBe(true)
    expect(isOverflowing({ scrollWidth: 80, clientWidth: 80 } as HTMLElement)).toBe(false)
  })
})

describe('resolveOverflowElement', () => {
  it('prefers an overflowing child over a non-overflowing wrapper', () => {
    const child = { scrollWidth: 120, clientWidth: 80 } as HTMLElement
    const trigger = {
      scrollWidth: 80,
      clientWidth: 80,
      firstElementChild: child,
    } as unknown as HTMLElement
    expect(resolveOverflowElement(trigger)).toBe(child)
  })

  it('falls back to the wrapper when the child is inline-wide but the wrapper clips', () => {
    const child = { scrollWidth: 120, clientWidth: 120 } as HTMLElement
    const trigger = {
      scrollWidth: 120,
      clientWidth: 80,
      firstElementChild: child,
    } as unknown as HTMLElement
    expect(resolveOverflowElement(trigger)).toBe(trigger)
  })

  it('returns null when neither wrapper nor child is clipped', () => {
    const child = { scrollWidth: 60, clientWidth: 60 } as HTMLElement
    const trigger = {
      scrollWidth: 60,
      clientWidth: 60,
      firstElementChild: child,
    } as unknown as HTMLElement
    expect(resolveOverflowElement(trigger)).toBeNull()
  })
})

describe('OVERFLOW_TOOLTIP_DELAY', () => {
  it('is at least one second for truncated labels', () => {
    expect(OVERFLOW_TOOLTIP_DELAY).toBeGreaterThanOrEqual(1000)
  })
})
