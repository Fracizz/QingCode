import { afterEach, describe, expect, it, vi } from 'vitest'
// 终端鼠标模式：长按滑块进入，点按判定决定是否选中 / 点击。
import { createLongPress, isTap, LONG_PRESS_MS, LONG_PRESS_SLOP, TAP_MAX_MS, TAP_SLOP } from '../../mobile/android/web/mouseMode.js'

const view = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) }

afterEach(() => { vi.useRealTimers() })

describe('Android terminal mouse mode', () => {
  it('treats short, still touches as taps', () => {
    expect(isTap({ x: 10, y: 10, at: 0 }, { x: 10 + TAP_SLOP * 0.6, y: 10 + TAP_SLOP * 0.6, at: TAP_MAX_MS })).toBe(true)
    expect(isTap({ x: 10, y: 10, at: 0 }, { x: 10, y: 10 + TAP_SLOP + 1, at: 50 })).toBe(false)
    expect(isTap({ x: 10, y: 10, at: 0 }, { x: 10, y: 10, at: TAP_MAX_MS + 1 })).toBe(false)
    expect(isTap(null, { x: 0, y: 0, at: 0 })).toBe(false)
  })

  it('fires a long press only when the finger stays on the slider', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const press = createLongPress(view, fired)
    press.down({ clientX: 0, clientY: 100 })
    press.move({ clientX: 0, clientY: 100 + LONG_PRESS_SLOP })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(press.fired()).toBe(true)
  })

  it('cancels the long press when the finger drags or lifts early', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const press = createLongPress(view, fired)
    press.down({ clientX: 0, clientY: 100 })
    press.move({ clientX: 0, clientY: 100 + LONG_PRESS_SLOP + 1 })
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    press.down({ clientX: 0, clientY: 100 })
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    press.cancel()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).not.toHaveBeenCalled()
    expect(press.fired()).toBe(false)
  })
})
