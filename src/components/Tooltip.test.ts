import { describe, expect, it } from 'vitest'
import {
  getTooltipArrowOffsetX,
  getTooltipPosition,
  isOverflowing,
  OVERFLOW_TOOLTIP_DELAY,
  resolveOverflowElement,
  TOOLTIP_ARROW_GAP,
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

  it('lifts arrow tips farther above the trigger so they clear the status bar', () => {
    // Use a mid-viewport trigger so the larger arrow gap is not clamped by the top edge.
    const statusTrigger = { ...trigger, top: 200, bottom: 228 }
    const style = getTooltipPosition(statusTrigger, 'top', tip, viewport, 1, {
      gap: TOOLTIP_ARROW_GAP,
    })
    expect(style.top).toBe(200 - TOOLTIP_ARROW_GAP - 24)
    // Tip bottom + caret tip leave TIP_ARROW_CLEARANCE above the anchor top.
    expect((style.top as number) + tip.height + TOOLTIP_ARROW_GAP).toBe(200)
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

  it('clamps top tooltips near the right edge without shrinking past tip width', () => {
    const nearRight = {
      left: 370,
      right: 398,
      top: 200,
      bottom: 228,
      width: 28,
      height: 28,
    }
    const wideTip = { width: 160, height: 24 }
    const style = getTooltipPosition(nearRight, 'top', wideTip, viewport)
    expect(style.left).toBe(400 - 160 - 8)
    expect(style.top).toBe(200 - 8 - 24)
  })

  it('divides by zoom so a right-edge tip stays on-screen', () => {
    const zoom = 16 / 13
    const nearRight = {
      left: 360,
      right: 388,
      top: 40,
      bottom: 68,
      width: 28,
      height: 28,
    }
    const style = getTooltipPosition(nearRight, 'bottom', tip, viewport, zoom)
    const visualLeft = (style.left as number) * zoom
    const visualWidth = tip.width * zoom
    expect(visualLeft + visualWidth).toBeLessThanOrEqual(400 - 8 + 0.001)
    expect(visualLeft).toBeGreaterThanOrEqual(8 - 0.001)
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

describe('getTooltipArrowOffsetX', () => {
  it('centers the caret under the trigger when the tip is centered', () => {
    // tip left 78, width 72, trigger center 114 → caret left = 114-78-6
    expect(getTooltipArrowOffsetX(78, 72, 114, 1)).toBe(30)
  })

  it('clamps the caret inside the tip when the tip is shifted left', () => {
    const offset = getTooltipArrowOffsetX(8, 160, 390, 1)
    expect(offset).toBeGreaterThanOrEqual(10)
    expect(offset).toBeLessThanOrEqual(160 - 10 - 12)
  })
})
