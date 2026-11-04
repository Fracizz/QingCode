// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalTouchScroll } from '../../mobile/android/web/terminalTouch.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren() })

function fixture() {
  const element = document.createElement('div')
  element.innerHTML = '<div class="xterm-screen"><canvas></canvas></div><div class="scrollbar"></div>'
  document.body.append(element)
  const screen = element.querySelector('.xterm-screen')!
  const wheel = vi.fn()
  // Verify bubbling as well: xterm's scrollback and program mouse handlers run on ancestors.
  element.addEventListener('wheel', wheel)
  disposers.push(attachTerminalTouchScroll(element))
  const touch = (type: string, points: Array<[number, number, number?]>, target = screen) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: points.map(([x, y, id = 1]) => ({ clientX: x, clientY: y, identifier: id })),
    })
    target.dispatchEvent(event)
    return event
  }
  return { element, screen, wheel, touch }
}

describe('Android terminal touch scrolling', () => {
  it('converts both drag directions to pixel wheel events without swallowing taps', () => {
    const { wheel, touch } = fixture()
    expect(touch('touchstart', [[30, 200]]).defaultPrevented).toBe(false)
    expect(touch('touchmove', [[31, 197]]).defaultPrevented).toBe(false)
    expect(wheel).not.toHaveBeenCalled()
    expect(touch('touchmove', [[32, 170]]).defaultPrevented).toBe(true)
    touch('touchmove', [[32, 190]])
    expect(wheel.mock.calls.map(([event]) => event.deltaY)).toEqual([30, -20])
    expect(wheel.mock.calls[0][0]).toMatchObject({ deltaMode: 0, clientX: 32, clientY: 170, cancelable: true })
    expect(wheel.mock.calls[0][0].wheelDeltaY).toBeUndefined()
    expect(wheel.mock.calls[0][0].wheelDeltaX).toBeUndefined()
  })

  it('locks horizontal drags out of terminal scrolling', () => {
    const { wheel, touch } = fixture()
    touch('touchstart', [[10, 100]])
    expect(touch('touchmove', [[40, 98]]).defaultPrevented).toBe(false)
    touch('touchmove', [[41, 50]])
    expect(wheel).not.toHaveBeenCalled()
  })

  it('cancels when a second finger is added and waits for a new gesture', () => {
    const { wheel, touch } = fixture()
    touch('touchstart', [[10, 100]])
    touch('touchmove', [[10, 90], [30, 100, 2]])
    touch('touchmove', [[10, 50]])
    touch('touchstart', [[10, 100], [30, 100, 2]])
    touch('touchmove', [[10, 50]])
    expect(wheel).not.toHaveBeenCalled()
  })

  it.each(['touchend', 'touchcancel'])('ends a gesture on %s', type => {
    const { wheel, touch } = fixture()
    touch('touchstart', [[10, 100]])
    touch(type, [])
    touch('touchmove', [[10, 50]])
    expect(wheel).not.toHaveBeenCalled()
  })

  it('ignores scrollbar interactions and a changed touch identity', () => {
    const { element, wheel, touch } = fixture()
    touch('touchstart', [[10, 100]], element.querySelector('.scrollbar')!)
    touch('touchmove', [[10, 50]])
    touch('touchstart', [[10, 100]])
    touch('touchmove', [[10, 50, 2]])
    expect(wheel).not.toHaveBeenCalled()
  })

  it('removes all handlers when a terminal is disposed', () => {
    const { wheel, touch } = fixture()
    touch('touchstart', [[10, 100]])
    disposers.splice(0).forEach(dispose => dispose())
    touch('touchmove', [[10, 50]])
    touch('touchstart', [[10, 100]])
    touch('touchmove', [[10, 50]])
    expect(wheel).not.toHaveBeenCalled()
  })
})
