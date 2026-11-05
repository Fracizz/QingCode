// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachCursorDrag, cursorSteps, dragAxis } from '../../mobile/android/web/cursorDrag.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks() })

function fixture(options: Parameters<typeof attachCursorDrag>[1] = {}) {
  const element = document.createElement('textarea')
  document.body.append(element)
  const steps: number[] = []
  const onStart = vi.fn()
  const onEnd = vi.fn()
  const dispose = attachCursorDrag(element, { step: () => 10, onSteps: n => steps.push(n), onStart, onEnd, ...options })
  disposers.push(dispose)
  const touch = (type: string, points: Array<[number, number, number?]>) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: points.map(([x, y, id = 1]) => ({ clientX: x, clientY: y, identifier: id })) })
    element.dispatchEvent(event)
    return event
  }
  return { element, steps, onStart, onEnd, touch, dispose }
}

describe('Android composer cursor drag', () => {
  it('classifies only clearly horizontal drags past the slop', () => {
    expect(dragAxis(5, 2)).toBeNull()
    expect(dragAxis(20, 4)).toBe('horizontal')
    expect(dragAxis(-20, 4)).toBe('horizontal')
    expect(dragAxis(12, 11)).toBe('vertical')
    expect(dragAxis(3, -30)).toBe('vertical')
  })

  it('converts movement into signed whole steps and keeps the remainder', () => {
    expect(cursorSteps(25, 10)).toEqual({ steps: 2, remainder: 5 })
    expect(cursorSteps(-25, 10)).toEqual({ steps: -2, remainder: -5 })
    expect(cursorSteps(9, 10)).toEqual({ steps: 0, remainder: 9 })
    expect(cursorSteps(10, 0)).toEqual({ steps: 0, remainder: 0 })
  })

  it('takes over a horizontal drag and emits steps from the takeover point', () => {
    const { steps, onStart, onEnd, touch } = fixture()
    touch('touchstart', [[100, 50]])
    expect(touch('touchmove', [[112, 51]]).defaultPrevented).toBe(true)
    expect(onStart).toHaveBeenCalledOnce()
    touch('touchmove', [[127, 51]])
    touch('touchmove', [[87, 51]])
    touch('touchend', [])
    // 112→127 得 1 步余 5；再左移 40 合计 -35，得 -3 步。
    expect(steps).toEqual([1, -3])
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('leaves vertical scrolling to the textarea', () => {
    const { steps, onStart, touch } = fixture()
    touch('touchstart', [[100, 50]])
    expect(touch('touchmove', [[102, 80]]).defaultPrevented).toBe(false)
    expect(touch('touchmove', [[160, 82]]).defaultPrevented).toBe(false)
    expect(onStart).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })

  it('does nothing while disabled, e.g. during IME composition', () => {
    const { steps, onStart, touch } = fixture({ enabled: () => false })
    touch('touchstart', [[100, 50]])
    expect(touch('touchmove', [[140, 50]]).defaultPrevented).toBe(false)
    expect(onStart).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })

  it('a second finger ends the drag', () => {
    const { steps, onEnd, touch } = fixture()
    touch('touchstart', [[100, 50]])
    touch('touchmove', [[120, 50]])
    touch('touchmove', [[140, 50], [10, 10, 2]])
    touch('touchmove', [[200, 50]])
    expect(onEnd).toHaveBeenCalledOnce()
    expect(steps).toEqual([])
  })

  it('swallows the click synthesized right after a drag but not later taps', () => {
    let now = 1000
    vi.spyOn(window.performance, 'now').mockImplementation(() => now)
    const { element, touch } = fixture()
    const clicked = vi.fn()
    element.addEventListener('click', clicked)
    touch('touchstart', [[100, 50]])
    touch('touchmove', [[130, 50]])
    touch('touchend', [])
    element.click()
    expect(clicked).not.toHaveBeenCalled()
    now += 1000
    element.click()
    expect(clicked).toHaveBeenCalledOnce()
  })
})
