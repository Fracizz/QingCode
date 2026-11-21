// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_WHEEL_TICKS_PER_FRAME,
  attachTerminalTouchScroll,
  dispatchLineWheel,
  wheelTicks,
} from '../../mobile/android/web/terminalTouch.js'
import {
  AUTO_BOTTOM_MAX_MS,
  AUTO_BOTTOM_SETTLE_MS,
  AUTO_BOTTOM_TICKS,
  JOG_MAX_RATE,
  JOG_MIN_RATE,
  attachTerminalJog,
  autoBottomDone,
  jogRate,
  jogTicks,
} from '../../mobile/android/web/terminalJog.js'
import { heldRowOffset, heldTerminalRows, keyboardLikelyOpen } from '../../mobile/android/web/terminalHold.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('touch swipes become whole wheel ticks for mouse-reporting programs', () => {
  it('responds after half a row, then sends one tick per row on a slow drag', () => {
    const state = { remainder: 0 }
    for (let pixel = 1; pixel <= 70; pixel++) {
      const tick = wheelTicks(state, 1, 20)
      expect(tick).toBe(pixel % 20 === 10 ? 1 : 0)
    }
  })

  it('requires half a row to reverse, even after landing exactly on a tick', () => {
    const state = { remainder: 0 }
    expect(wheelTicks(state, 10, 20)).toBe(1)
    expect(Math.abs(wheelTicks(state, -8, 20))).toBe(0)
    expect(wheelTicks(state, -3, 20)).toBe(-1)
  })

  it('speeds up fast flicks and caps each frame', () => {
    expect(wheelTicks({ remainder: 0 }, 80, 20, 0)).toBe(4)
    expect(wheelTicks({ remainder: 0 }, 80, 20, 2)).toBe(5)
    expect(wheelTicks({ remainder: 0 }, 5000, 20, 3)).toBe(MAX_WHEEL_TICKS_PER_FRAME)
    expect(wheelTicks({ remainder: 0 }, 80, 0)).toBe(0)
  })

  it('dispatches one line-mode wheel event per tick so xterm reports each one', () => {
    const screen = document.createElement('div')
    document.body.append(screen)
    const seen: WheelEvent[] = []
    screen.addEventListener('wheel', event => seen.push(event as WheelEvent))
    expect(dispatchLineWheel(screen, -3, { x: 5, y: 6 })).toBe(3)
    expect(seen).toHaveLength(3)
    expect(seen.every(event => event.deltaMode === 1 && event.deltaY === -1 && event.clientY === 6)).toBe(true)
    expect(seen.every(event => (event as WheelEvent & { qingTouch: boolean }).qingTouch)).toBe(true)
  })

  it('routes finger motion through programWheel when the program reports the mouse', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => { frame = null })
    const element = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    element.append(screen)
    document.body.append(element)
    const seen: WheelEvent[] = []
    screen.addEventListener('wheel', event => seen.push(event as WheelEvent))
    const revealed = vi.fn()
    const dispose = attachTerminalTouchScroll(element, { programWheel: () => 20, onProgramWheel: revealed })
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      const touches = type === 'touchend' ? [] : [{ identifier: 1, clientX: 50, clientY: y }]
      Object.assign(event, { touches })
      Object.defineProperty(event, 'target', { value: screen })
      element.dispatchEvent(event)
    }
    touch('touchstart', 300)
    touch('touchmove', 380) // 手指下滑 80px = 向上滚
    ;(frame as FrameRequestCallback | null)?.(0)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(event => event.deltaMode === 1 && event.deltaY === -1)).toBe(true)
    expect(revealed).toHaveBeenCalledWith(-seen.length)
    dispose()
  })
})

describe('spring-back jog slider', () => {
  it('maps distance from the centre to a quadratic speed with a dead zone', () => {
    expect(jogRate(0)).toBe(0)
    expect(jogRate(.05)).toBe(0)
    expect(jogRate(.11)).toBeCloseTo(JOG_MIN_RATE, 0)
    expect(jogRate(1)).toBe(JOG_MAX_RATE)
    expect(jogRate(-1)).toBe(-JOG_MAX_RATE)
    expect(jogRate(5)).toBe(JOG_MAX_RATE)
    expect(Math.abs(jogRate(.5))).toBeLessThan(JOG_MAX_RATE / 2)
  })

  it('emits whole ticks over time and resets in the dead zone', () => {
    const state = { remainder: 0 }
    let total = 0
    for (let index = 0; index < 60; index += 1) total += jogTicks(state, -1, 1000 / 60)
    expect(Math.abs(total + JOG_MAX_RATE)).toBeLessThanOrEqual(1)
    jogTicks(state, .5, 10)
    expect(jogTicks(state, 0, 10)).toBe(0)
    expect(state.remainder).toBe(0)
    // 掉帧很久后不一次性补发一大串。
    expect(Math.abs(jogTicks({ remainder: 0 }, 1, 5000))).toBeLessThanOrEqual(Math.ceil(JOG_MAX_RATE / 10))
  })

  it('only shows while the program reports the mouse and pages with the arrows', () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.append(host)
    const page = vi.fn()
    const jog = attachTerminalJog(host, { scroll: vi.fn(), page, idleMs: 1000 })
    const root = host.querySelector<HTMLElement>('.terminal-jog')!
    jog.reveal()
    expect(root.hidden).toBe(true)
    jog.setActive(true)
    expect(root.hidden).toBe(false)
    host.querySelector<HTMLButtonElement>('[data-direction="up"]')!.click()
    host.querySelector<HTMLButtonElement>('[data-direction="down"]')!.click()
    expect(page.mock.calls).toEqual([[-1], [1]])
    vi.advanceTimersByTime(1100)
    expect(root.hidden).toBe(true)
    jog.reveal()
    jog.setActive(false)
    expect(root.hidden).toBe(true)
    jog.dispose()
    expect(host.querySelector('.terminal-jog')).toBeNull()
    vi.useRealTimers()
  })
})

describe('jog auto-scroll to bottom', () => {
  it('stops once the top of the screen stops changing, or at the time limit', () => {
    const state = { startAt: 0, changedAt: 0, snapshot: 'a' }
    expect(autoBottomDone(state, 'b', 100)).toBe(false)
    expect(autoBottomDone(state, 'b', 100 + AUTO_BOTTOM_SETTLE_MS - 1)).toBe(false)
    expect(autoBottomDone(state, 'b', 100 + AUTO_BOTTOM_SETTLE_MS)).toBe(true)
    // 画面一直在变（如持续刷新）时靠最长时间兜底；没有快照时也只按时间停。
    expect(autoBottomDone({ startAt: 0, changedAt: 0, snapshot: 'x' }, 'y', AUTO_BOTTOM_MAX_MS)).toBe(true)
    expect(autoBottomDone({ startAt: 0, changedAt: 0, snapshot: null }, null, AUTO_BOTTOM_MAX_MS - 1)).toBe(false)
  })

  it('wheels down until the screen settles, toggles off on a second tap, and yields to any touch on the terminal', () => {
    vi.useFakeTimers()
    vi.spyOn(window.performance, 'now').mockImplementation(() => Date.now())
    const host = document.createElement('div')
    const screen = document.createElement('div')
    host.append(screen)
    document.body.append(host)
    const scroll = vi.fn()
    let frame = 0
    // 前 10 批每批画面都在变，之后滚不动。
    const snapshot = () => String(Math.min(scroll.mock.calls.length, 10) + frame)
    const jog = attachTerminalJog(host, { scroll, page: vi.fn(), snapshot, idleMs: 1000 })
    const root = host.querySelector<HTMLElement>('.terminal-jog')!
    const bottom = host.querySelector<HTMLButtonElement>('.terminal-jog-bottom')!
    jog.setActive(true)
    bottom.click()
    expect(jog.autoScrolling()).toBe(true)
    expect(bottom.getAttribute('aria-pressed')).toBe('true')
    vi.advanceTimersByTime(AUTO_BOTTOM_SETTLE_MS + 2000)
    expect(jog.autoScrolling()).toBe(false)
    expect(scroll.mock.calls.every(([ticks]) => ticks === AUTO_BOTTOM_TICKS)).toBe(true)
    const sent = scroll.mock.calls.length
    expect(sent).toBeGreaterThan(10)
    expect(sent).toBeLessThan(10 + AUTO_BOTTOM_SETTLE_MS / 10)
    // 自动下滑期间保持显示，停止后照常自动隐藏。
    vi.advanceTimersByTime(1100)
    expect(root.hidden).toBe(true)

    jog.reveal()
    frame = 1000
    bottom.click()
    bottom.click()
    expect(jog.autoScrolling()).toBe(false)
    bottom.click()
    screen.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(jog.autoScrolling()).toBe(false)
    bottom.click()
    jog.setActive(false)
    expect(jog.autoScrolling()).toBe(false)
    jog.dispose()
    vi.useRealTimers()
  })
})

describe('soft keyboard keeps the PTY row count', () => {
  it('detects the keyboard by a large drop from the tallest height', () => {
    expect(keyboardLikelyOpen(900, 1600)).toBe(true)
    expect(keyboardLikelyOpen(1540, 1600)).toBe(false)
  })

  it('holds rows only while the keyboard is open and columns are unchanged', () => {
    expect(heldTerminalRows({ fitRows: 12, currentRows: 30, sameColumns: true, keyboardOpen: true })).toBe(30)
    expect(heldTerminalRows({ fitRows: 12, currentRows: 30, sameColumns: false, keyboardOpen: true })).toBe(12)
    expect(heldTerminalRows({ fitRows: 12, currentRows: 30, sameColumns: true, keyboardOpen: false })).toBe(12)
    expect(heldTerminalRows({ fitRows: 34, currentRows: 30, sameColumns: true, keyboardOpen: true })).toBe(34)
  })

  it('shifts the screen just enough to keep the cursor row visible', () => {
    expect(heldRowOffset(30, 0, 29)).toBe(0)
    expect(heldRowOffset(30, 12, 29)).toBe(18)
    expect(heldRowOffset(30, 12, 15)).toBe(4)
    expect(heldRowOffset(30, 12, 3)).toBe(0)
  })
})
