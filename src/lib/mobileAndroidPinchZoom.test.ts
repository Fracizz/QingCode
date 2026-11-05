// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FONT_MAX, FONT_MIN, attachPinchZoom, clampFontSize, pinchFontSize } from '../../mobile/android/web/pinchZoom.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren() })

function fixture(size = 13, enabled = () => true) {
  const container = document.createElement('div')
  const inner = document.createElement('div')
  container.append(inner)
  document.body.append(container)
  const innerTouch = vi.fn()
  inner.addEventListener('touchmove', innerTouch)
  const previews: number[] = []
  const commits: Array<[number, unknown]> = []
  const onStart = vi.fn()
  disposers.push(attachPinchZoom(container, {
    currentSize: () => size, enabled, onStart,
    onPreview: value => previews.push(value),
    onCommit: (value, info) => commits.push([value, info]),
  }))
  const touch = (type: string, points: Array<[number, number]>) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: points.map(([x, y], index) => ({ clientX: x, clientY: y, identifier: index + 1 })) })
    inner.dispatchEvent(event)
    return event
  }
  return { touch, previews, commits, onStart, innerTouch }
}

describe('Android terminal pinch zoom', () => {
  it('scales the font size with finger spread and clamps to 11–20px', () => {
    expect(pinchFontSize(13, 100, 100)).toBe(13)
    expect(pinchFontSize(13, 100, 150)).toBe(20)
    expect(pinchFontSize(14, 100, 115)).toBe(16)
    expect(pinchFontSize(13, 100, 40)).toBe(FONT_MIN)
    expect(pinchFontSize(13, 0, 40)).toBe(13)
    expect(clampFontSize(99)).toBe(FONT_MAX)
    expect(clampFontSize(10.6)).toBe(FONT_MIN)
  })

  it('previews each new size during the gesture and commits on release', () => {
    const { touch, previews, commits, onStart, innerTouch } = fixture(13)
    touch('touchstart', [[100, 100], [200, 100]])
    expect(onStart).toHaveBeenCalledOnce()
    const event = touch('touchmove', [[90, 100], [215, 100]])
    expect(event.defaultPrevented).toBe(true)
    touch('touchmove', [[80, 100], [230, 100]])
    touch('touchmove', [[80, 100], [231, 100]])
    touch('touchend', [[80, 100]])
    expect(previews).toEqual([16, 20])
    expect(commits).toEqual([[20, undefined]])
    // 双指期间的移动不传给终端滚动和程序。
    expect(innerTouch).not.toHaveBeenCalled()
  })

  it('ignores small spread jitter and reports an unchanged gesture', () => {
    const { touch, previews, commits } = fixture(13)
    touch('touchstart', [[100, 100], [200, 100]])
    touch('touchmove', [[98, 100], [205, 100]])
    touch('touchend', [])
    expect(previews).toEqual([])
    expect(commits).toEqual([[13, { unchanged: true }]])
  })

  it('leaves single-finger touches to the terminal', () => {
    const { touch, previews, onStart, innerTouch } = fixture(13)
    touch('touchstart', [[100, 100]])
    expect(touch('touchmove', [[100, 60]]).defaultPrevented).toBe(false)
    expect(onStart).not.toHaveBeenCalled()
    expect(previews).toEqual([])
    expect(innerTouch).toHaveBeenCalledOnce()
  })

  it('stays inactive while disabled', () => {
    const { touch, previews, onStart } = fixture(13, () => false)
    touch('touchstart', [[100, 100], [200, 100]])
    touch('touchmove', [[50, 100], [250, 100]])
    expect(onStart).not.toHaveBeenCalled()
    expect(previews).toEqual([])
  })
})
