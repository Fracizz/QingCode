// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTouchMouseGuard } from '../../mobile/android/web/terminalTouch.js'
import { attachTerminalHistory, localLogicalDepth } from '../../mobile/android/web/terminalHistory.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks() })

describe('Android touch mouse guard', () => {
  function fixture(block: boolean) {
    const container = document.createElement('div')
    const screen = document.createElement('div')
    container.append(screen)
    document.body.append(container)
    const reported = vi.fn()
    const tap = vi.fn()
    // xterm 在终端元素上监听鼠标事件；被拦截时它收不到。
    screen.addEventListener('mousedown', reported)
    screen.addEventListener('mouseup', reported)
    disposers.push(attachTouchMouseGuard(container, { shouldBlock: () => block, onTap: tap }))
    return { screen, reported, tap }
  }
  const touchEnd = (target: Element) => target.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { touches: [] }))

  it('blocks compatibility mouse events after a tap and still focuses the terminal', () => {
    const { screen, reported, tap } = fixture(true)
    touchEnd(screen)
    screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    screen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(reported).not.toHaveBeenCalled()
    expect(tap).toHaveBeenCalledTimes(1)
  })

  it('keeps physical mouse clicks and program mode untouched', () => {
    const physical = fixture(true)
    physical.screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(physical.reported).toHaveBeenCalledTimes(1)
    document.body.replaceChildren()
    const program = fixture(false)
    touchEnd(program.screen)
    program.screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(program.reported).toHaveBeenCalledTimes(1)
    expect(program.tap).not.toHaveBeenCalled()
  })
})

describe('Android touch scrolling goes to the raw terminal', () => {
  function fixture({ mouse = 'any', available = true, type = 'alternate', viewportY = 0, baseY = 0 } = {}) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    document.body.innerHTML = `<section id="terminal-history" hidden><div id="history-scroll"><button id="history-more"></button><p id="history-status"></p><pre id="history-content"></pre></div></section>
      <button id="scroll-bottom" hidden><span></span></button><div id="term"><div class="xterm-screen"></div></div>`
    const element = document.getElementById('term')!
    const term = {
      element, rows: 2, options: { fontSize: 14, fontFamily: 'mono' },
      modes: { mouseTrackingMode: mouse },
      buffer: { active: { type, baseY, viewportY, getLine: () => ({ translateToString: () => 'row' }) } },
      scrollToBottom: vi.fn(),
    }
    const unsupported = vi.fn()
    const loadPage = vi.fn(() => new Promise(() => {}))
    const history = attachTerminalHistory({
      term, get: (id: string) => document.getElementById(id), onUnsupportedScroll: unsupported, loadPage,
    })
    history.update(10, available)
    disposers.push(() => history.dispose())
    const program = vi.fn()
    // 冒泡到这里代表交给 xterm：开了鼠标的程序收到滚轮，普通终端滚本地记录。
    element.addEventListener('wheel', program)
    const swipe = (deltaY: number, extra: Record<string, unknown> = {}) => {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY })
      Object.defineProperty(wheel, 'qingTouch', { value: true })
      for (const [key, value] of Object.entries(extra)) Object.defineProperty(wheel, key, { value })
      element.querySelector('.xterm-screen')!.dispatchEvent(wheel)
    }
    const historyOpen = () => !document.getElementById('terminal-history')!.hidden
    return { swipe, program, historyOpen, unsupported, loadPage }
  }

  it.each([40, -40])('passes touch delta %i to a full-screen program that reports the mouse', delta => {
    const { swipe, program, historyOpen } = fixture()
    swipe(delta)
    expect(program).toHaveBeenCalledTimes(1)
    expect(historyOpen()).toBe(false)
  })

  it('does not turn swipes into arrow keys when a full-screen program ignores the mouse', () => {
    const { swipe, program, historyOpen, unsupported } = fixture({ mouse: 'none' })
    swipe(-40, { qingGesture: 3 })
    swipe(-10, { qingGesture: 3, qingMomentum: true })
    expect(program).not.toHaveBeenCalled()
    expect(historyOpen()).toBe(false)
    expect(unsupported).toHaveBeenCalledTimes(1)
    expect(unsupported).toHaveBeenCalledWith(3)
  })

  it('scrolls the local normal buffer first and opens desktop history only at its top', () => {
    const reading = fixture({ type: 'normal', mouse: 'none', viewportY: 5, baseY: 20 })
    reading.swipe(-40)
    expect(reading.program).toHaveBeenCalledTimes(1)
    expect(reading.historyOpen()).toBe(false)
    document.body.replaceChildren()
    const top = fixture({ type: 'normal', mouse: 'none' })
    top.swipe(-40)
    expect(top.program).not.toHaveBeenCalled()
    expect(top.historyOpen()).toBe(true)
    expect(top.loadPage).toHaveBeenCalledWith(10)
  })

  it('keeps physical mouse wheels under program control', () => {
    const { program, historyOpen } = fixture({ mouse: 'none' })
    document.querySelector('.xterm-screen')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40 }))
    expect(program).toHaveBeenCalledTimes(1)
    expect(historyOpen()).toBe(false)
  })
})

describe('local scrollback depth in desktop history lines', () => {
  it('counts wrapped continuation rows as part of the preceding logical line', () => {
    const wrapped = [false, true, true, false, false, true]
    const buffer = { type: 'normal', viewportY: 0, baseY: 6, getLine: (index: number) => ({ isWrapped: wrapped[index] }) }
    expect(localLogicalDepth(buffer)).toBe(3)
    expect(localLogicalDepth({ ...buffer, viewportY: 4 })).toBe(1)
    expect(localLogicalDepth({ ...buffer, type: 'alternate' })).toBe(0)
  })
})
