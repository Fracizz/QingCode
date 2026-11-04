// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachKeyRepeat, attachPullToRefresh, attachSheetDrag } from '../../mobile/android/web/gestures.js'

const disposers: Array<() => void> = []
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  vi.useRealTimers()
})

function touch(target: Element, type: string, points: Array<[number, number, number?]>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: points.map(([x, y, id = 1]) => ({ clientX: x, clientY: y, identifier: id })),
  })
  target.dispatchEvent(event)
  return event
}

function pointer(target: Element, type: string, clientY: number, timeStamp = 0, pointerId = 1) {
  // jsdom lacks PointerEvent; a MouseEvent with the pointer fields is enough for these handlers.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'touch' },
    timeStamp: { value: timeStamp },
  })
  target.dispatchEvent(event)
}

describe('Android pull to refresh', () => {
  function fixture(enabled = () => true) {
    const scroller = document.createElement('section')
    const indicator = document.createElement('div')
    scroller.append(indicator)
    document.body.append(scroller)
    let finish: () => void = () => {}
    const onRefresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    disposers.push(attachPullToRefresh(scroller, indicator, { onRefresh, enabled }))
    return { scroller, indicator, onRefresh, finish: () => finish() }
  }

  it('arms after a long downward pull at the top and refreshes once on release', async () => {
    const { scroller, indicator, onRefresh, finish } = fixture()
    touch(scroller, 'touchstart', [[100, 100]])
    expect(touch(scroller, 'touchmove', [[100, 120]]).defaultPrevented).toBe(true)
    expect(indicator.dataset.state).toBe('pulling')
    touch(scroller, 'touchmove', [[100, 300]])
    expect(indicator.dataset.state).toBe('ready')
    touch(scroller, 'touchend', [])
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(indicator.dataset.state).toBe('refreshing')
    // A second pull while refreshing is ignored.
    touch(scroller, 'touchstart', [[100, 100]])
    touch(scroller, 'touchmove', [[100, 300]])
    touch(scroller, 'touchend', [])
    expect(onRefresh).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() => expect(indicator.dataset.state).toBeUndefined())
    expect(indicator.style.getPropertyValue('--pull')).toBe('0px')
  })

  it('springs back without refreshing after a short pull', () => {
    const { scroller, indicator, onRefresh } = fixture()
    touch(scroller, 'touchstart', [[100, 100]])
    touch(scroller, 'touchmove', [[100, 150]])
    touch(scroller, 'touchend', [])
    expect(onRefresh).not.toHaveBeenCalled()
    expect(indicator.dataset.state).toBeUndefined()
  })

  it('leaves horizontal drags, upward scrolling and scrolled lists alone', () => {
    const { scroller, onRefresh } = fixture()
    touch(scroller, 'touchstart', [[100, 100]])
    expect(touch(scroller, 'touchmove', [[160, 110]]).defaultPrevented).toBe(false)
    touch(scroller, 'touchmove', [[160, 300]])
    touch(scroller, 'touchend', [])
    touch(scroller, 'touchstart', [[100, 300]])
    expect(touch(scroller, 'touchmove', [[100, 200]]).defaultPrevented).toBe(false)
    touch(scroller, 'touchend', [])
    scroller.scrollTop = 40
    Object.defineProperty(scroller, 'scrollTop', { value: 40, configurable: true })
    touch(scroller, 'touchstart', [[100, 100]])
    expect(touch(scroller, 'touchmove', [[100, 300]]).defaultPrevented).toBe(false)
    touch(scroller, 'touchend', [])
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('does nothing while disabled', () => {
    const { scroller, onRefresh } = fixture(() => false)
    touch(scroller, 'touchstart', [[100, 100]])
    expect(touch(scroller, 'touchmove', [[100, 300]]).defaultPrevented).toBe(false)
    touch(scroller, 'touchend', [])
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe('Android bottom sheet drag', () => {
  function fixture() {
    const sheet = document.createElement('dialog')
    const handle = document.createElement('div')
    sheet.append(handle)
    document.body.append(sheet)
    const close = vi.fn()
    disposers.push(attachSheetDrag(sheet, handle, close))
    return { sheet, handle, close }
  }

  it('follows the finger downward only and closes past the distance', () => {
    const { sheet, handle, close } = fixture()
    pointer(handle, 'pointerdown', 100, 0)
    pointer(handle, 'pointermove', 60, 50)
    expect(sheet.style.transform).toBe('translateY(0px)')
    pointer(handle, 'pointermove', 220, 600)
    expect(sheet.style.transform).toBe('translateY(120px)')
    pointer(handle, 'pointerup', 220, 700)
    expect(close).toHaveBeenCalledTimes(1)
    expect(sheet.style.transform).toBe('')
  })

  it('closes on a quick flick and snaps back after a slow small drag', () => {
    const { handle, close } = fixture()
    pointer(handle, 'pointerdown', 100, 0)
    pointer(handle, 'pointermove', 150, 40)
    pointer(handle, 'pointerup', 150, 50)
    expect(close).toHaveBeenCalledTimes(1)
    pointer(handle, 'pointerdown', 100, 1000)
    pointer(handle, 'pointermove', 140, 1500)
    pointer(handle, 'pointerup', 140, 1600)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Android key auto-repeat', () => {
  it('repeats while held, then swallows the release click', () => {
    vi.useFakeTimers()
    const button = document.createElement('button')
    document.body.append(button)
    const fire = vi.fn()
    const click = vi.fn()
    disposers.push(attachKeyRepeat(button, fire, { delay: 400, interval: 50 }))
    button.addEventListener('click', click)
    pointer(button, 'pointerdown', 0)
    vi.advanceTimersByTime(399)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1 + 50 * 3)
    expect(fire).toHaveBeenCalledTimes(4)
    pointer(button, 'pointerup', 0)
    button.click()
    expect(click).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(fire).toHaveBeenCalledTimes(4)
  })

  it('keeps an ordinary tap as a single click', () => {
    vi.useFakeTimers()
    const button = document.createElement('button')
    document.body.append(button)
    const fire = vi.fn()
    const click = vi.fn()
    disposers.push(attachKeyRepeat(button, fire))
    button.addEventListener('click', click)
    pointer(button, 'pointerdown', 0)
    vi.advanceTimersByTime(100)
    pointer(button, 'pointerup', 0)
    button.click()
    expect(fire).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
  })
})
