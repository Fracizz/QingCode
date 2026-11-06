// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
// 虚拟鼠标：点终端只移动指针，左右键点击，长按左键拖动；合成鼠标事件不被触摸拦截挡下。
import { attachMouseMode, HOLD_MS } from '../../mobile/android/web/mouseMode.js'
import { attachTouchMouseGuard, dispatchVirtualClick } from '../../mobile/android/web/terminalTouch.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks() })

const screenRect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

function pointer(target: Element, type: string, x: number, y: number, id = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: x }, clientY: { value: y }, pointerId: { value: id },
    isPrimary: { value: true }, pointerType: { value: 'touch' }, button: { value: 0 },
  })
  target.dispatchEvent(event)
}

function fixture() {
  const host = document.createElement('div')
  const viewport = document.createElement('div')
  host.append(viewport)
  document.body.append(host)
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(screenRect)
  const onClick = vi.fn()
  const onDrag = vi.fn()
  let saved: { x: number; y: number } | undefined
  const mouse = attachMouseMode(host, viewport, {
    onClick, onDrag,
    screenRect: () => screenRect,
    grid: () => ({ cols: 40, rows: 15 }),
    position: () => saved,
    savePosition: (ratio: { x: number; y: number }) => { saved = ratio },
  })
  disposers.push(() => mouse.dispose())
  mouse.set(true)
  const body = host.querySelector('.virtual-mouse')!
  const [left, right] = host.querySelectorAll('.virtual-mouse-button')
  return { host, viewport, mouse, body, left, right, onClick, onDrag, saved: () => saved }
}

describe('Android virtual mouse', () => {
  it('shows the pointer at the screen centre and moves it on terminal taps without clicking', () => {
    const { mouse, viewport, onClick, saved } = fixture()
    expect(mouse.point()).toEqual({ x: 200, y: 120 })
    pointer(viewport, 'pointerdown', 50, 60)
    pointer(viewport, 'pointerup', 50, 60)
    expect(mouse.point()).toEqual({ x: 50, y: 60 })
    expect(saved()).toEqual({ x: 50 / 400, y: 60 / 300 })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('clicks with the left and right buttons at the pointer tip', () => {
    const { mouse, left, right, onClick } = fixture()
    const tip = mouse.point()
    pointer(left, 'pointerdown', 300, 200)
    pointer(left, 'pointerup', 300, 200)
    pointer(right, 'pointerdown', 330, 200)
    pointer(right, 'pointerup', 330, 200)
    expect(onClick.mock.calls).toEqual([[tip, 0], [tip, 2]])
  })

  it('drags the body to move the pointer 1:1 and keeps it inside the screen', () => {
    const { mouse, body, onClick } = fixture()
    pointer(body, 'pointerdown', 220, 180)
    pointer(body, 'pointermove', 170, 150)
    expect(mouse.point()).toEqual({ x: 150, y: 90 })
    pointer(body, 'pointermove', -900, 150)
    expect(mouse.point()).toEqual({ x: 0, y: 90 })
    pointer(body, 'pointerup', -900, 150)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('holds the left button to drag with it pressed', () => {
    vi.useFakeTimers()
    const { left, onDrag, onClick } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(left, 'pointermove', 250, 160)
    pointer(left, 'pointerup', 250, 160)
    expect(onDrag.mock.calls.map(([phase]) => phase)).toEqual(['down', 'move', 'up'])
    expect(onDrag.mock.calls[1][1]).toEqual({ x: 220, y: 120 })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows a menu near the mouse and hides everything on exit', () => {
    const { host, mouse } = fixture()
    const run = vi.fn()
    mouse.showMenu([{ label: 'Paste', run }])
    const item = host.querySelector<HTMLButtonElement>('.virtual-mouse-menu button')!
    item.click()
    expect(run).toHaveBeenCalledTimes(1)
    expect(host.querySelector<HTMLElement>('.virtual-mouse-menu')!.hidden).toBe(true)
    mouse.set(false)
    expect(host.querySelector<HTMLElement>('.virtual-mouse')!.hidden).toBe(true)
    expect(host.querySelector<HTMLElement>('.virtual-mouse-pointer')!.hidden).toBe(true)
  })
})

describe('Android virtual mouse events', () => {
  it('dispatches left and right clicks that pass the touch mouse guard', () => {
    const container = document.createElement('div')
    const screen = document.createElement('div')
    container.append(screen)
    document.body.append(container)
    disposers.push(attachTouchMouseGuard(container, { shouldBlock: () => true }))
    const seen: Array<[string, number, number]> = []
    for (const type of ['mousedown', 'mouseup']) {
      document.addEventListener(type, event => { const mouse = event as MouseEvent; seen.push([type, mouse.button, mouse.buttons]) })
    }
    container.dispatchEvent(new Event('touchstart'))
    dispatchVirtualClick(screen, { x: 12, y: 34 }, 0)
    dispatchVirtualClick(screen, { x: 12, y: 34 }, 2)
    expect(seen).toEqual([['mousedown', 0, 1], ['mouseup', 0, 0], ['mousedown', 2, 2], ['mouseup', 2, 0]])
  })
})
