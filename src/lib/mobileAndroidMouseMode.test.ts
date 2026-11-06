import { afterEach, describe, expect, it, vi } from 'vitest'
// 终端鼠标模式：长按滑块进入，点按判定决定是否选中 / 点击。
import { cellRect, clampPoint, createLongPress, fromRatio, isTap, layoutMouseBody, LONG_PRESS_MS, LONG_PRESS_SLOP, MOUSE_BODY, POINTER_GAP, TAP_MAX_MS, TAP_SLOP, toRatio } from '../../mobile/android/web/mouseMode.js'

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

describe('Android virtual mouse layout', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 }

  it('clamps the pointer inside the terminal screen', () => {
    expect(clampPoint({ x: -5, y: 500 }, rect)).toEqual({ x: 10, y: 119 })
    expect(clampPoint({ x: 50, y: 60 }, rect)).toEqual({ x: 50, y: 60 })
  })

  it('round-trips pointer positions as ratios', () => {
    const ratio = toRatio({ x: 110, y: 70 }, rect)
    expect(ratio).toEqual({ x: 0.5, y: 0.5 })
    expect(fromRatio(ratio, { left: 0, top: 0, width: 400, height: 300 })).toEqual({ x: 200, y: 150 })
    expect(fromRatio({ x: 2, y: -1 }, rect)).toEqual({ x: 209, y: 20 })
  })

  it('finds the cell under the pointer tip', () => {
    expect(cellRect({ x: 35, y: 45 }, rect, 20, 10)).toMatchObject({ col: 2, row: 2, width: 10, height: 10, left: 30, top: 40 })
    expect(cellRect({ x: 999, y: 999 }, rect, 20, 10)).toMatchObject({ col: 19, row: 9 })
    expect(cellRect({ x: 0, y: 0 }, rect, 0, 10)).toBeNull()
  })

  it('places the body below-right of the tip and flips near the edges', () => {
    const bounds = { width: 300, height: 400 }
    expect(layoutMouseBody({ x: 20, y: 20 }, bounds)).toEqual({ left: 20 + POINTER_GAP.x, top: 20 + POINTER_GAP.y, flip: { x: false, y: false } })
    const corner = layoutMouseBody({ x: 290, y: 390 }, bounds)
    expect(corner.flip).toEqual({ x: true, y: true })
    expect(corner.left).toBe(290 - POINTER_GAP.x - MOUSE_BODY.width)
    expect(corner.top).toBe(390 - POINTER_GAP.y - MOUSE_BODY.height)
    // 拖动中沿用原朝向，并限制在容器内。
    expect(layoutMouseBody({ x: 290, y: 20 }, bounds, { flip: { x: false, y: false } })).toMatchObject({ left: bounds.width - MOUSE_BODY.width })
  })
})
