// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalTouchScroll, attachTouchMouseGuard } from '../../mobile/android/web/terminalTouch.js'
import { attachTerminalHistory } from '../../mobile/android/web/terminalHistory.js'

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

describe('Android touch scrolling in full-screen programs', () => {
  function fixture({ mouse = 'any', toProgram = false, available = true, type = 'alternate' } = {}) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    document.body.innerHTML = `<section id="terminal-history" hidden><div id="history-scroll"><button id="history-more"></button><p id="history-status"></p><pre id="history-content"></pre></div></section>
      <button id="scroll-bottom" hidden><span></span></button><div id="term"><div class="xterm-screen"></div></div>`
    const element = document.getElementById('term')!
    const term = {
      element, rows: 2, options: { fontSize: 14, fontFamily: 'mono' },
      modes: { mouseTrackingMode: mouse },
      buffer: { active: { type, baseY: 0, viewportY: 0, getLine: () => ({ translateToString: () => 'row' }) } },
      scrollToBottom: vi.fn(),
    }
    const history = attachTerminalHistory({
      term, get: (id: string) => document.getElementById(id), touchToProgram: () => toProgram,
      loadPage: () => new Promise(() => {}),
    })
    history.update(10, available)
    disposers.push(() => history.dispose())
    const program = vi.fn()
    // 冒泡到这里代表 xterm 会把滚轮转成鼠标序列发给程序。
    element.addEventListener('wheel', program)
    const swipe = (deltaY: number) => {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY })
      Object.defineProperty(wheel, 'qingTouch', { value: true })
      element.querySelector('.xterm-screen')!.dispatchEvent(wheel)
    }
    const historyOpen = () => !document.getElementById('terminal-history')!.hidden
    return { swipe, program, historyOpen, element, history }
  }

  it.each([40, -40])('opens read-only TUI history for touch delta %i without sending input', delta => {
    const { swipe, program, historyOpen } = fixture()
    swipe(delta)
    expect(program).not.toHaveBeenCalled()
    expect(historyOpen()).toBe(true)
  })

  it('explains missing retained history instead of silently swallowing the gesture', () => {
    const { swipe, program, historyOpen } = fixture({ available: false })
    swipe(-40)
    expect(program).not.toHaveBeenCalled()
    expect(historyOpen()).toBe(true)
    expect(document.getElementById('history-status')!.textContent).toContain('暂无更早')
    expect(document.getElementById('history-more')!.hidden).toBe(true)
    expect(document.getElementById('history-content')!.textContent).toContain('row')
  })

  it.each(['alternate', 'normal'])('keeps an entire upward finger drag in read-only %s history', async type => {
    const { element, historyOpen, program } = fixture({ type })
    // A normal buffer with mouse reporting is also a TUI, e.g. inline full-screen layouts.
    disposers.push(attachTerminalTouchScroll(element, { canInertia: () => false }))
    const screen = element.querySelector('.xterm-screen')!
    const touch = (event: string, y: number) => screen.dispatchEvent(Object.assign(new Event(event, { bubbles: true, cancelable: true }), {
      touches: event === 'touchend' ? [] : [{ identifier: 1, clientX: 20, clientY: y }],
    }))
    touch('touchstart', 250)
    touch('touchmove', 200)
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(historyOpen()).toBe(true)
    touch('touchmove', 100)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    touch('touchend', 100)
    expect(historyOpen()).toBe(true)
    expect(program).not.toHaveBeenCalled()
  })

  it('keeps physical mouse wheels under program control', () => {
    const { element, program, historyOpen } = fixture()
    element.querySelector('.xterm-screen')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40 }))
    expect(program).toHaveBeenCalledTimes(1)
    expect(historyOpen()).toBe(false)
  })

  it.each([40, -40])('passes touch delta %i to the program in program mode', delta => {
    const { swipe, program } = fixture({ toProgram: true })
    swipe(delta)
    expect(program).toHaveBeenCalledTimes(1)
  })
})
