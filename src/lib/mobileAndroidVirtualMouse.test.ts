// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
// 虚拟鼠标：点终端只移动指针，左右键点击，长按左键拖动；合成鼠标事件不被触摸拦截挡下。
import { attachMouseMode, CLICK_DRAG_MS, HOLD_MS, POINTER_TIP } from '../../mobile/android/web/mouseMode.js'
import { attachTouchMouseGuard, dispatchVirtualClick, dispatchVirtualMouse } from '../../mobile/android/web/terminalTouch.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks() })

const screenRect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

function pointer(target: Element, type: string, x: number, y: number, id = 1, primary = true) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: x }, clientY: { value: y }, pointerId: { value: id },
    isPrimary: { value: primary }, pointerType: { value: 'touch' }, button: { value: 0 },
  })
  target.dispatchEvent(event)
  return event
}

function fixture(initialPosition?: { x: number; y: number }) {
  const host = document.createElement('div')
  const viewport = document.createElement('div')
  host.append(viewport)
  document.body.append(host)
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(screenRect)
  const onClick = vi.fn()
  const onDrag = vi.fn()
  let saved = initialPosition
  let bounds = screenRect
  const mouse = attachMouseMode(host, viewport, {
    onClick, onDrag,
    screenRect: () => bounds,
    grid: () => ({ cols: 40, rows: 15 }),
    position: () => saved,
    savePosition: (ratio: { x: number; y: number }) => { saved = ratio },
  })
  disposers.push(() => mouse.dispose())
  mouse.set(true)
  const body = host.querySelector('.virtual-mouse')!
  const captures = new Set<number>()
  Object.defineProperties(body, {
    setPointerCapture: { value: vi.fn((id: number) => captures.add(id)), configurable: true },
    hasPointerCapture: { value: (id: number) => captures.has(id) },
    releasePointerCapture: { value: vi.fn((id: number) => captures.delete(id)) },
  })
  const [left, right] = host.querySelectorAll('.virtual-mouse-button')
  const resize = (width: number, height: number) => { bounds = { ...screenRect, width, height }; mouse.refresh() }
  return { host, viewport, mouse, body, left, right, onClick, onDrag, resize, saved: () => saved }
}

describe('Android virtual mouse', () => {
  it('shows the pointer at the screen centre and moves it on terminal taps without clicking', () => {
    const { mouse, viewport, onClick, saved } = fixture()
    expect(mouse.point()).toEqual({ x: 200, y: 150 })
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
    expect(mouse.point()).toEqual({ x: 150, y: 120 })
    pointer(body, 'pointermove', -900, 150)
    expect(mouse.point()).toEqual({ x: 0, y: 120 })
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
    expect(onDrag.mock.calls[1][1]).toEqual({ x: 220, y: 150 })
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

  it('does not treat a swipe returning to its origin as a terminal tap', () => {
    const { mouse, viewport } = fixture()
    pointer(viewport, 'pointerdown', 50, 60)
    pointer(viewport, 'pointermove', 150, 60)
    pointer(viewport, 'pointermove', 50, 60)
    pointer(viewport, 'pointerup', 50, 60)
    expect(mouse.point()).toEqual({ x: 200, y: 150 })
  })

  it('moves the pointer without clicking when sliding on the right button', () => {
    vi.useFakeTimers()
    const { mouse, right, body, onDrag, onClick } = fixture()
    pointer(right, 'pointerdown', 230, 160)
    pointer(right, 'pointermove', 260, 180)
    vi.advanceTimersByTime(HOLD_MS * 2)
    expect(body.classList.contains('dragging')).toBe(true)
    pointer(right, 'pointerup', 260, 180)
    expect(mouse.point()).toEqual({ x: 230, y: 170 })
    expect(onDrag).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('starts a left drag as soon as the finger slides on the left button', () => {
    const { left, onDrag, onClick } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    pointer(left, 'pointermove', 260, 180)
    pointer(left, 'pointerup', 260, 180)
    expect(onDrag.mock.calls).toEqual([
      ['down', { x: 200, y: 150 }],
      ['move', { x: 230, y: 170 }],
      ['up', { x: 230, y: 170 }],
    ])
    expect(onClick).not.toHaveBeenCalled()
  })

  it('treats dragging the body right after a left click as a left drag', () => {
    vi.useFakeTimers()
    const { left, body, onDrag, onClick } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    pointer(left, 'pointerup', 230, 160)
    expect(onClick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CLICK_DRAG_MS - 1)
    pointer(body, 'pointerdown', 230, 200)
    pointer(body, 'pointermove', 260, 200)
    pointer(body, 'pointerup', 260, 200)
    expect(onDrag.mock.calls.map(([phase]) => phase)).toEqual(['down', 'move', 'up'])
  })

  it('moves the pointer when the body is dragged long after a click or after a right click', () => {
    vi.useFakeTimers()
    const { left, right, body, onDrag } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    pointer(left, 'pointerup', 230, 160)
    vi.advanceTimersByTime(CLICK_DRAG_MS + 1)
    pointer(body, 'pointerdown', 230, 200)
    pointer(body, 'pointermove', 260, 200)
    pointer(body, 'pointerup', 260, 200)
    pointer(right, 'pointerdown', 230, 160)
    pointer(right, 'pointerup', 230, 160)
    pointer(body, 'pointerdown', 230, 200)
    pointer(body, 'pointermove', 200, 200)
    pointer(body, 'pointerup', 200, 200)
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('does not start a drag from a still tap on the body after a click', () => {
    const { left, body, onDrag, onClick } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    pointer(left, 'pointerup', 230, 160)
    pointer(body, 'pointerdown', 230, 200)
    pointer(body, 'pointerup', 230, 200)
    expect(onDrag).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('opens the menu on the side of the body away from the pointer', () => {
    const { mouse, viewport, host } = fixture()
    const menu = host.querySelector<HTMLElement>('.virtual-mouse-menu')!
    pointer(viewport, 'pointerdown', 50, 60)
    pointer(viewport, 'pointerup', 50, 60)
    mouse.showMenu([{ label: 'Paste', run: vi.fn() }])
    // 指针在上：机身顶部 92，菜单放到机身下方。
    expect(menu.style.transform).toBe('translate(20px, 188px)')
    pointer(viewport, 'pointerdown', 50, 290)
    pointer(viewport, 'pointerup', 50, 290)
    mouse.showMenu([{ label: 'Paste', run: vi.fn() }])
    // 指针在下：机身翻到上方，顶部 170，菜单放到机身上方。
    expect(menu.style.transform).toBe('translate(20px, 118px)')
  })

  it('moves the pointer on taps in an extra target such as the history panel', () => {
    const host = document.createElement('div')
    const viewport = document.createElement('div')
    const panel = document.createElement('section')
    host.append(viewport, panel)
    document.body.append(host)
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(screenRect)
    const mouse = attachMouseMode(host, viewport, { screenRect: () => screenRect, extraTargets: [panel] })
    disposers.push(() => mouse.dispose())
    mouse.set(true)
    pointer(panel, 'pointerdown', 50, 60)
    pointer(panel, 'pointerup', 50, 60)
    expect(mouse.point()).toEqual({ x: 50, y: 60 })
    expect(host.querySelector<HTMLElement>('.virtual-mouse-cell')!.hidden).toBe(true)
  })

  it('offsets the arrow element so its tip sits exactly on the click position', () => {
    const { mouse, host } = fixture()
    const tip = mouse.point()!
    expect(host.querySelector<HTMLElement>('.virtual-mouse-pointer')!.style.transform)
      .toBe(`translate(${tip.x - POINTER_TIP.x}px, ${tip.y - POINTER_TIP.y}px)`)
  })

  it('completes a gesture outside the body even when pointer capture is unavailable', () => {
    const { mouse, body, saved } = fixture()
    Object.defineProperty(body, 'setPointerCapture', { value: () => { throw new Error('Unavailable') } })
    pointer(body, 'pointerdown', 230, 200)
    pointer(document.body, 'pointermove', 300, 220)
    pointer(document.body, 'pointerup', 300, 220)
    expect(mouse.point()).toEqual({ x: 270, y: 170 })
    expect(saved()).toEqual({ x: 270 / 400, y: 170 / 300 })
    expect(body.classList.contains('dragging')).toBe(false)
  })

  it('ignores an unrelated pointer release during a held drag', () => {
    vi.useFakeTimers()
    const { left, body, onDrag } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(document.body, 'pointerup', 230, 160, 2)
    expect(onDrag.mock.calls.map(([phase]) => phase)).toEqual(['down'])
    pointer(document.body, 'pointerup', 230, 160)
    expect(onDrag.mock.calls.map(([phase]) => phase)).toEqual(['down', 'up'])
    expect(body.hasPointerCapture(1)).toBe(false)
  })

  it.each(['pointercancel', 'lostpointercapture', 'exit', 'blur', 'hidden', 'dispose', 'multitouch', 'resize'])('releases a held left button exactly once on %s', action => {
    vi.useFakeTimers()
    const { mouse, left, body, onDrag, onClick, resize } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(left, 'pointermove', 250, 160)
    if (action === 'pointercancel' || action === 'lostpointercapture') pointer(body, action, 250, 160)
    if (action === 'exit') mouse.set(false)
    if (action === 'blur') window.dispatchEvent(new Event('blur'))
    if (action === 'hidden') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    }
    if (action === 'dispose') mouse.dispose()
    if (action === 'multitouch') pointer(document.body, 'pointerdown', 320, 180, 2, false)
    if (action === 'resize') resize(320, 120)
    pointer(left, 'pointerup', 250, 160)
    expect(onDrag.mock.calls.map(([phase]) => phase)).toEqual(['down', 'move', 'up'])
    expect(onDrag.mock.calls[2][1]).toEqual({ x: 220, y: 150 })
    expect(body.hasPointerCapture(1)).toBe(false)
    expect(body.classList.contains('holding')).toBe(false)
    expect(onClick).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'exit', 'blur', 'dispose', 'multitouch'])('cancels pending clicks and timers on %s', action => {
    vi.useFakeTimers()
    const { mouse, left, onDrag, onClick } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    if (action === 'pointercancel') pointer(left, 'pointercancel', 230, 160)
    if (action === 'exit') mouse.set(false)
    if (action === 'blur') window.dispatchEvent(new Event('blur'))
    if (action === 'dispose') mouse.dispose()
    if (action === 'multitouch') pointer(document.body, 'pointerdown', 330, 160, 2, false)
    vi.advanceTimersByTime(HOLD_MS * 2)
    pointer(left, 'pointerup', 230, 160)
    expect(onDrag).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('cancels multitouch terminal taps and does not start a secondary mouse gesture', () => {
    vi.useFakeTimers()
    const { mouse, viewport, left, onClick, onDrag } = fixture()
    pointer(viewport, 'pointerdown', 50, 60)
    pointer(left, 'pointerdown', 300, 200, 2, false)
    vi.advanceTimersByTime(HOLD_MS * 2)
    pointer(left, 'pointerup', 300, 200, 2, false)
    pointer(viewport, 'pointerup', 50, 60)
    expect(mouse.point()).toEqual({ x: 200, y: 150 })
    expect(onClick).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('does not click when the release is too far away or a right button hold is too long', () => {
    vi.useFakeTimers()
    const { left, right, onClick, onDrag } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    pointer(left, 'pointerup', 330, 160)
    pointer(right, 'pointerdown', 260, 160)
    vi.advanceTimersByTime(1000)
    pointer(right, 'pointerup', 260, 160)
    expect(onClick).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('rescales the saved pointer and cell after a keyboard resize and restores it on reentry', () => {
    const { mouse, viewport, host, resize } = fixture()
    pointer(viewport, 'pointerdown', 300, 240)
    pointer(viewport, 'pointerup', 300, 240)
    resize(320, 100)
    expect(mouse.point()).toEqual({ x: 240, y: 80 })
    expect(host.querySelector<HTMLElement>('.virtual-mouse-cell')!.style.transform).toBe('translate(240px, 80px)')
    mouse.set(false)
    mouse.set(true)
    expect(mouse.point()).toEqual({ x: 240, y: 80 })
  })

  it('keeps the last rendered drag ratio when resizing during a hold', () => {
    vi.useFakeTimers()
    const { mouse, left, resize, saved } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(left, 'pointermove', 250, 190)
    resize(320, 100)
    expect(saved()).toEqual({ x: 220 / 400, y: 180 / 300 })
    expect(mouse.point()).toEqual({ x: 176, y: 60 })
    resize(400, 300)
    expect(mouse.point()!.x).toBeCloseTo(220)
    expect(mouse.point()!.y).toBe(180)
  })

  it('saves the final drag position on disposal without sending old input into the next session', () => {
    vi.useFakeTimers()
    const first = fixture()
    pointer(first.left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(first.left, 'pointermove', 250, 160)
    first.mouse.dispose()
    const second = fixture({ x: .1, y: .2 })
    pointer(second.viewport, 'pointerup', 250, 160)
    vi.advanceTimersByTime(HOLD_MS * 2)
    expect(first.saved()).toEqual({ x: 220 / 400, y: .5 })
    expect(first.onDrag.mock.calls.map(([phase]) => phase)).toEqual(['down', 'move', 'up'])
    expect(second.mouse.point()).toEqual({ x: 40, y: 60 })
    expect(second.onClick).not.toHaveBeenCalled()
    expect(second.onDrag).not.toHaveBeenCalled()
    first.mouse.set(true)
    expect(first.mouse.isActive()).toBe(false)
  })

  it('dismisses the ordinary-terminal menu on outside interactions and ignores stale menu actions', () => {
    const { host, mouse, viewport } = fixture()
    const run = vi.fn()
    mouse.showMenu([{ label: 'Paste', run }])
    const item = host.querySelector<HTMLButtonElement>('.virtual-mouse-menu button')!
    pointer(viewport, 'pointerdown', 30, 40)
    expect(host.querySelector<HTMLElement>('.virtual-mouse-menu')!.hidden).toBe(true)
    item.click()
    expect(run).not.toHaveBeenCalled()
    mouse.showMenu([{ label: 'Copy', run }])
    item.click()
    expect(run).not.toHaveBeenCalled()
    const stale = host.querySelector<HTMLButtonElement>('.virtual-mouse-menu button')!
    mouse.set(false)
    stale.click()
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps real finger coordinates from leaking into ordinary selection while dragging the virtual pointer', () => {
    vi.useFakeTimers()
    const { host, left, onDrag } = fixture()
    const selectAtFinger = vi.fn()
    host.addEventListener('touchmove', selectAtFinger, true)
    pointer(left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(left, 'pointermove', 250, 160)
    const move = new Event('touchmove', { bubbles: true, cancelable: true })
    Object.defineProperty(move, 'touches', { value: [{ clientX: 250, clientY: 160 }] })
    left.dispatchEvent(move)
    expect(move.defaultPrevented).toBe(true)
    expect(selectAtFinger).not.toHaveBeenCalled()
    expect(onDrag.mock.calls[1][1]).toEqual({ x: 220, y: 150 })
    pointer(left, 'pointerup', 250, 160)
    host.dispatchEvent(new Event('touchmove', { bubbles: true }))
    expect(selectAtFinger).toHaveBeenCalledTimes(1)
  })

  it('supports keyboard button activation without duplicating compatibility pointer clicks', () => {
    const { left, right, onClick } = fixture()
    pointer(left, 'pointerdown', 230, 160)
    pointer(left, 'pointerup', 230, 160)
    left.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(onClick).toHaveBeenCalledTimes(1)
    ;(right as HTMLButtonElement).click()
    expect(onClick.mock.calls.map(([, button]) => button)).toEqual([0, 2])
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
      const listener = (event: Event) => { const mouse = event as MouseEvent; seen.push([type, mouse.button, mouse.buttons]) }
      document.addEventListener(type, listener)
      disposers.push(() => document.removeEventListener(type, listener))
    }
    container.dispatchEvent(new Event('touchstart'))
    dispatchVirtualClick(screen, { x: 12, y: 34 }, 0)
    dispatchVirtualClick(screen, { x: 12, y: 34 }, 2)
    expect(seen).toEqual([['mousedown', 0, 1], ['mouseup', 0, 0], ['mousedown', 2, 2], ['mouseup', 2, 0]])
  })

  it('uses the screen owning realm without requiring a Window in MouseEventInit', () => {
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const screen = iframe.contentDocument!.createElement('div')
    iframe.contentDocument!.body.append(screen)
    const event = dispatchVirtualMouse(screen, 'mousemove', { x: 12, y: 34 }, { button: 0, buttons: 1 })
    expect(event).toBeInstanceOf(iframe.contentWindow!.MouseEvent)
    expect(event).toMatchObject({ type: 'mousemove', clientX: 12, clientY: 34, button: 0, buttons: 1, qingVirtual: true, bubbles: true, cancelable: true })
  })

  it('emits two complete click pairs for a double click without a stuck button', () => {
    const screen = document.createElement('div')
    document.body.append(screen)
    const seen: Array<[string, number, number]> = []
    for (const type of ['mousedown', 'mouseup']) screen.addEventListener(type, event => {
      const mouse = event as MouseEvent
      seen.push([type, mouse.button, mouse.buttons])
    })
    dispatchVirtualClick(screen, { x: 12, y: 34 })
    dispatchVirtualClick(screen, { x: 12, y: 34 })
    expect(seen).toEqual([['mousedown', 0, 1], ['mouseup', 0, 0], ['mousedown', 0, 1], ['mouseup', 0, 0]])
  })

  it('bubbles held drag phases through the guard to document-level xterm listeners', () => {
    vi.useFakeTimers()
    const { viewport, left, mouse, onDrag } = fixture()
    disposers.push(attachTouchMouseGuard(viewport, { shouldBlock: () => true }))
    const received: MouseEvent[] = []
    for (const type of ['mousedown', 'mousemove', 'mouseup']) {
      const handler = (event: Event) => { received.push(event as MouseEvent) }
      document.addEventListener(type, handler)
      disposers.push(() => document.removeEventListener(type, handler))
    }
    onDrag.mockImplementation((phase, point) => dispatchVirtualMouse(viewport, phase === 'down' ? 'mousedown' : phase === 'move' ? 'mousemove' : 'mouseup', point, { buttons: phase === 'up' ? 0 : 1 }))
    viewport.dispatchEvent(new Event('touchstart', { bubbles: true }))
    pointer(left, 'pointerdown', 230, 160)
    vi.advanceTimersByTime(HOLD_MS)
    pointer(document.body, 'pointermove', 250, 160)
    mouse.dispose()
    expect(received.map(event => [event.type, event.buttons, event.clientX, event.clientY])).toEqual([
      ['mousedown', 1, 200, 150], ['mousemove', 1, 220, 150], ['mouseup', 0, 220, 150],
    ])
  })
})
