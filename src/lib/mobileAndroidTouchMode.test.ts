// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTouchMouseGuard } from '../../mobile/android/web/terminalTouch.js'
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
  function fixture({ mouse = 'any', toProgram = false, available = true } = {}) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    document.body.innerHTML = `<section id="terminal-history" hidden><div id="history-scroll"><button id="history-more"></button><p id="history-status"></p><pre id="history-content"></pre></div></section>
      <button id="scroll-bottom" hidden><span></span></button><div id="term"><div class="xterm-screen"></div></div>`
    const element = document.getElementById('term')!
    const term = {
      element, rows: 2, options: { fontSize: 14, fontFamily: 'mono' },
      modes: { mouseTrackingMode: mouse },
      buffer: { active: { type: 'alternate', baseY: 0, viewportY: 0, getLine: () => ({ translateToString: () => 'row' }) } },
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
    return { swipe, program, historyOpen }
  }

  it('never sends finger swipes to the program by default', () => {
    const { swipe, program, historyOpen } = fixture()
    swipe(40)
    expect(program).not.toHaveBeenCalled()
    expect(historyOpen()).toBe(false)
    swipe(-40)
    expect(program).not.toHaveBeenCalled()
    expect(historyOpen()).toBe(true)
  })

  it('swallows swipes when no retained history exists', () => {
    const { swipe, program, historyOpen } = fixture({ available: false })
    swipe(-40)
    expect(program).not.toHaveBeenCalled()
    expect(historyOpen()).toBe(false)
  })

  it('passes downward swipes to the program in program mode', () => {
    const { swipe, program } = fixture({ toProgram: true })
    swipe(40)
    expect(program).toHaveBeenCalledTimes(1)
  })
})
