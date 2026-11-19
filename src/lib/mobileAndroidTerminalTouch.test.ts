// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalTouchScroll, attachTouchMouseGuard, dispatchVirtualMouse, localScrollLines } from '../../mobile/android/web/terminalTouch.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers() })

type LocalScroll = { lineHeight: () => number; scrollLines: (lines: number) => void }

function fixture(canInertia = () => true, onLongPress?: (point: { x: number; y: number }) => void, local?: LocalScroll) {
  let clock = 0
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window.performance, 'now').mockImplementation(() => clock)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  const advance = (milliseconds = 16) => {
    clock += milliseconds
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(clock))
  }
  const element = document.createElement('div')
  element.innerHTML = '<div class="xterm-screen"><canvas></canvas></div><div class="scrollbar"></div>'
  document.body.append(element)
  const screen = element.querySelector('.xterm-screen')!
  const wheel = vi.fn()
  // Verify bubbling as well: xterm's scrollback and program mouse handlers run on ancestors.
  element.addEventListener('wheel', wheel)
  disposers.push(attachTerminalTouchScroll(element, { canInertia, onLongPress, ...local }))
  const touch = (type: string, points: Array<[number, number, number?]>, target = screen) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: points.map(([x, y, id = 1]) => ({ clientX: x, clientY: y, identifier: id })),
    })
    target.dispatchEvent(event)
    return event
  }
  return { element, screen, wheel, touch, advance }
}

describe('Android terminal touch scrolling', () => {
  it('long press enters selection once and never sends wheel input', () => {
    vi.useFakeTimers()
    const select = vi.fn()
    const { wheel, touch, advance } = fixture(() => true, select)
    touch('touchstart', [[20, 100]])
    vi.advanceTimersByTime(500)
    expect(select).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 100 })
    touch('touchmove', [[20, 50]])
    touch('touchend', [])
    advance()
    expect(wheel).not.toHaveBeenCalled()
  })

  it.each(['move', 'multitouch', 'release', 'cancel', 'dispose'])('cancels long press on %s', action => {
    vi.useFakeTimers()
    const select = vi.fn()
    const { touch } = fixture(() => true, select)
    touch('touchstart', [[20, 100]])
    if (action === 'move') touch('touchmove', [[20, 80]])
    if (action === 'multitouch') touch('touchstart', [[20, 100], [40, 100, 2]])
    if (action === 'release') touch('touchend', [])
    if (action === 'cancel') touch('touchcancel', [])
    if (action === 'dispose') disposers.splice(0).forEach(dispose => dispose())
    vi.advanceTimersByTime(1000)
    expect(select).not.toHaveBeenCalled()
  })

  it('converts both drag directions to pixel wheel events without swallowing taps', () => {
    const { wheel, touch, advance } = fixture()
    expect(touch('touchstart', [[30, 200]]).defaultPrevented).toBe(false)
    expect(touch('touchmove', [[31, 197]]).defaultPrevented).toBe(false)
    expect(wheel).not.toHaveBeenCalled()
    expect(touch('touchmove', [[32, 170]]).defaultPrevented).toBe(true)
    advance()
    touch('touchmove', [[32, 190]])
    advance()
    expect(wheel.mock.calls.map(([event]) => event.deltaY)).toEqual([30, -20])
    expect(wheel.mock.calls[0][0]).toMatchObject({ deltaMode: 0, clientX: 32, clientY: 170, cancelable: true })
    expect(wheel.mock.calls[0][0].wheelDeltaY).toBeUndefined()
    expect(wheel.mock.calls[0][0].wheelDeltaX).toBeUndefined()
  })

  it('locks horizontal drags out of terminal scrolling', () => {
    const { wheel, touch, advance } = fixture()
    touch('touchstart', [[10, 100]])
    expect(touch('touchmove', [[40, 98]]).defaultPrevented).toBe(false)
    touch('touchmove', [[41, 50]])
    advance()
    expect(wheel).not.toHaveBeenCalled()
  })

  it('cancels when a second finger is added and waits for a new gesture', () => {
    const { wheel, touch, advance } = fixture()
    touch('touchstart', [[10, 100]])
    touch('touchmove', [[10, 90], [30, 100, 2]])
    touch('touchmove', [[10, 50]])
    advance()
    touch('touchstart', [[10, 100], [30, 100, 2]])
    touch('touchmove', [[10, 50]])
    expect(wheel).not.toHaveBeenCalled()
  })

  it('coalesces rapid moves into one frame without losing distance', () => {
    const { wheel, touch, advance } = fixture()
    touch('touchstart', [[20, 200]])
    for (let y = 199; y >= 100; y--) touch('touchmove', [[20, y]])
    expect(wheel).not.toHaveBeenCalled()
    advance()
    expect(wheel).toHaveBeenCalledTimes(1)
    expect(wheel.mock.calls[0][0]).toMatchObject({ deltaY: 100, qingTouch: true, qingMomentum: false })
  })

  it('decelerates after a flick and cancels inertia on the next touch', () => {
    const { wheel, touch, advance } = fixture()
    touch('touchstart', [[20, 200]])
    touch('touchmove', [[20, 150]])
    advance()
    touch('touchend', [])
    advance()
    advance()
    const first = wheel.mock.calls.at(-1)![0]
    advance()
    const second = wheel.mock.calls.at(-1)![0]
    expect(first.qingMomentum).toBe(true)
    expect(second.deltaY).toBeLessThan(first.deltaY)
    touch('touchstart', [[20, 100]])
    const count = wheel.mock.calls.length
    advance()
    expect(wheel).toHaveBeenCalledTimes(count)
  })

  it('never adds momentum to interactive TUI scrolling', () => {
    const { wheel, touch, advance } = fixture(() => false)
    touch('touchstart', [[20, 200]])
    touch('touchmove', [[20, 150]])
    touch('touchend', [])
    for (let index = 0; index < 20; index++) advance()
    expect(wheel).toHaveBeenCalledTimes(1)
    expect(wheel.mock.calls[0][0].qingMomentum).toBe(false)
  })

  it('cancels queued frames and momentum when disposed', () => {
    const { wheel, touch, advance } = fixture()
    touch('touchstart', [[20, 200]])
    touch('touchmove', [[20, 150]])
    touch('touchend', [])
    disposers.splice(0).forEach(dispose => dispose())
    for (let index = 0; index < 20; index++) advance()
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

describe('Android terminal local scrollback lines', () => {
  it('accumulates sub-line finger motion instead of dropping it', () => {
    const state = { remainder: 0 }
    // 20px 行高、1.25 倍增益：每帧 4px 约 0.25 行，第 4 帧才滚满一行。
    expect([4, 4, 4, 4].map(delta => localScrollLines(state, delta, 20))).toEqual([0, 0, 0, 1])
    expect(localScrollLines(state, -40, 20)).toBe(-2)
    expect(localScrollLines(state, 10, 0)).toBe(0)
  })

  it('scrolls whole lines locally and keeps the wheel away from xterm', () => {
    const scrollLines = vi.fn()
    let height = 20
    const { wheel, touch, advance } = fixture(() => true, undefined, { lineHeight: () => height, scrollLines })
    touch('touchstart', [[20, 200]])
    touch('touchmove', [[20, 190]])
    advance()
    touch('touchmove', [[20, 186]])
    advance()
    touch('touchmove', [[20, 160]])
    advance()
    // 10px、14px 都不足一行，不滚；累计 40px × 1.25 / 20 = 2.5 行，滚 2 行，零头留着。
    expect(scrollLines.mock.calls.map(([lines]) => lines)).toEqual([2])
    expect(wheel).not.toHaveBeenCalled()
    // 程序开了鼠标或历史面板打开时 lineHeight 为 0：滚轮照常交给 xterm 与历史面板。
    height = 0
    touch('touchmove', [[20, 150]])
    advance()
    expect(wheel).toHaveBeenCalledTimes(1)
    expect(scrollLines).toHaveBeenCalledTimes(1)
  })

  it('lets an earlier capture listener (history panel) claim the wheel first', () => {
    const scrollLines = vi.fn()
    const element = document.createElement('div')
    element.innerHTML = '<div class="xterm-screen"></div>'
    document.body.append(element)
    element.addEventListener('wheel', event => event.stopImmediatePropagation(), { capture: true })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
    disposers.push(attachTerminalTouchScroll(element, { lineHeight: () => 20, scrollLines }))
    const screen = element.querySelector('.xterm-screen')!
    for (const y of [200, 150]) {
      const event = new Event(y === 200 ? 'touchstart' : 'touchmove', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'touches', { value: [{ clientX: 10, clientY: y, identifier: 1 }] })
      screen.dispatchEvent(event)
    }
    expect(scrollLines).not.toHaveBeenCalled()
  })
})

describe('Android terminal touch mouse guard', () => {
  function guardFixture(shouldBlock = () => true) {
    const container = document.createElement('div')
    const screen = document.createElement('div')
    container.append(screen)
    document.body.append(container)
    const onTap = vi.fn()
    const received = vi.fn()
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) screen.addEventListener(type, received)
    const dispose = attachTouchMouseGuard(container, { shouldBlock, onTap })
    disposers.push(dispose)
    const touch = (type = 'touchstart') => screen.dispatchEvent(new Event(type, { bubbles: true }))
    const mouse = (type: string, firesTouchEvents?: boolean) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })
      if (firesTouchEvents !== undefined) Object.defineProperty(event, 'sourceCapabilities', { value: { firesTouchEvents } })
      screen.dispatchEvent(event)
      return event
    }
    return { screen, onTap, received, dispose, touch, mouse }
  }

  it('suppresses all compatibility events and their default actions after a touch', () => {
    const { mouse, touch, received, onTap } = guardFixture()
    touch()
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
      expect(mouse(type).defaultPrevented).toBe(true)
    }
    expect(received).not.toHaveBeenCalled()
    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onTap.mock.calls[0][0]).toMatchObject({ clientX: 30, clientY: 40 })
  })

  it('preserves explicit physical mouse events immediately after touching the screen', () => {
    const { mouse, touch, received, onTap } = guardFixture()
    touch()
    expect(mouse('mousedown', false).defaultPrevented).toBe(false)
    expect(mouse('mouseup', false).defaultPrevented).toBe(false)
    expect(received).toHaveBeenCalledTimes(2)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('uses the compatibility fallback only until the recent-touch window expires', () => {
    const now = vi.spyOn(window.performance, 'now').mockReturnValue(0)
    const { mouse, touch, received } = guardFixture()
    touch('touchend')
    now.mockReturnValue(799)
    expect(mouse('mousedown').defaultPrevented).toBe(true)
    now.mockReturnValue(800)
    expect(mouse('mousedown').defaultPrevented).toBe(false)
    expect(mouse('mousedown', true).defaultPrevented).toBe(true)
    expect(received).toHaveBeenCalledTimes(1)
  })

  it('allows all virtual drag phases even during the compatibility blocking window', () => {
    const { screen, touch, received, onTap } = guardFixture()
    touch()
    for (const type of ['mousedown', 'mousemove', 'mouseup']) {
      const event = dispatchVirtualMouse(screen, type, { x: 30, y: 40 }, { buttons: type === 'mouseup' ? 0 : 1 })
      expect(event.defaultPrevented).toBe(false)
    }
    expect(received).toHaveBeenCalledTimes(3)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('restores unblocked touch clicks when disabled or disposed', () => {
    let block = true
    const { mouse, touch, received, dispose } = guardFixture(() => block)
    touch()
    expect(mouse('mousedown').defaultPrevented).toBe(true)
    block = false
    expect(mouse('mousedown', true).defaultPrevented).toBe(false)
    block = true
    dispose()
    expect(mouse('mousedown', true).defaultPrevented).toBe(false)
    expect(received).toHaveBeenCalledTimes(2)
  })
})
