// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearExitGhostsForTest,
  handoffExitGhosts,
  leaveExitGhost,
  useExitMotionRef,
} from './exitMotion'

type FakeAnimation = { finished: Promise<void>; cancel: ReturnType<typeof vi.fn>; finish: () => void }

let animations: FakeAnimation[] = []

function fakeAnimate(this: Element) {
  let finish = () => {}
  const finished = new Promise<void>(resolve => { finish = resolve })
  const animation = { finished, cancel: vi.fn(), finish }
  animations.push(animation)
  return animation as unknown as Animation
}

function modal(): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0'
  overlay.dataset.modalOverlay = ''
  overlay.innerHTML = `
    <div class="modal-overlay-enter"></div>
    <div class="modal-content-enter" role="dialog" id="dlg">
      <input id="name" data-modal-autofocus />
      <div class="list" style="overflow:auto"></div>
    </div>`
  document.body.appendChild(overlay)
  return overlay
}

const ghosts = () => [...document.querySelectorAll<HTMLElement>('[data-exit-ghost]')]

beforeEach(() => {
  animations = []
  Element.prototype.animate = vi.fn(fakeAnimate)
})

afterEach(() => {
  clearExitGhostsForTest()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.motion
  delete (Element.prototype as Partial<Element>).animate
  vi.useRealTimers()
})

describe('leaveExitGhost', () => {
  it('leaves an inert, unqueryable copy that keeps input values and fades out', async () => {
    const overlay = modal()
    overlay.querySelector('input')!.value = '草稿'
    leaveExitGhost(overlay, 'modal')
    overlay.remove()

    const [ghost] = ghosts()
    expect(ghost).toBeTruthy()
    expect(ghost.hasAttribute('inert')).toBe(true)
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.hasAttribute('data-modal-overlay')).toBe(false)
    expect(ghost.querySelector('[id], [role], [data-modal-autofocus]')).toBeNull()
    expect(ghost.querySelector('input')!.value).toBe('草稿')
    expect(document.getElementById('dlg')).toBeNull()
    // 整体淡出 + 面板微缩两段动画。
    expect(animations).toHaveLength(2)

    animations[0].finish()
    await animations[0].finished
    await Promise.resolve()
    expect(ghosts()).toHaveLength(0)
  })

  it('falls back to a timer when the animation never settles', () => {
    vi.useFakeTimers()
    leaveExitGhost(modal(), 'menu')
    expect(ghosts()).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(ghosts()).toHaveLength(0)
  })

  it('does nothing when motion is reduced in-app', () => {
    document.documentElement.dataset.motion = 'reduce'
    leaveExitGhost(modal(), 'modal')
    expect(ghosts()).toHaveLength(0)
  })

  it('does nothing without Web Animations or for detached nodes', () => {
    delete (Element.prototype as Partial<Element>).animate
    leaveExitGhost(modal(), 'modal')
    Element.prototype.animate = vi.fn(fakeAnimate)
    leaveExitGhost(document.createElement('div'), 'menu')
    expect(ghosts()).toHaveLength(0)
  })

  it('pins a toast ghost at its old rect so the rest of the stack can close up', () => {
    const stack = document.createElement('div')
    stack.style.zIndex = '150'
    const toast = document.createElement('div')
    stack.appendChild(toast)
    document.body.appendChild(stack)
    toast.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 60 }) as DOMRect
    leaveExitGhost(toast, 'toast')

    const [ghost] = ghosts()
    expect(ghost.parentElement).toBe(document.body)
    expect(ghost.style.position).toBe('fixed')
    expect(ghost.style.left).toBe('10px')
    expect(ghost.style.width).toBe('300px')
    expect(ghost.style.zIndex).toBe('150')
  })
})

describe('handoffExitGhosts', () => {
  it('a new modal clears modal and menu ghosts and keeps its backdrop still', () => {
    leaveExitGhost(modal(), 'modal')
    leaveExitGhost(modal(), 'menu')
    const entering = document.createElement('div')
    handoffExitGhosts('modal', entering)
    expect(ghosts()).toHaveLength(0)
    expect(entering.hasAttribute('data-modal-handoff')).toBe(true)
  })

  it('a menu opened from a closing menu only clears menu ghosts', () => {
    leaveExitGhost(modal(), 'modal')
    leaveExitGhost(modal(), 'menu')
    const entering = document.createElement('div')
    handoffExitGhosts('menu', entering)
    expect(ghosts()).toHaveLength(1)
    expect(entering.hasAttribute('data-modal-handoff')).toBe(false)
  })

  it('a dialog opened from a menu still fades its backdrop in', () => {
    leaveExitGhost(modal(), 'menu')
    const entering = document.createElement('div')
    handoffExitGhosts('modal', entering)
    expect(ghosts()).toHaveLength(0)
    expect(entering.hasAttribute('data-modal-handoff')).toBe(false)
  })
})

describe('useExitMotionRef', () => {
  it('writes the object ref and skips the ghost for a same-task attach/detach (StrictMode)', () => {
    const objectRef = { current: null as HTMLElement | null }
    const { result } = renderHook(() => useExitMotionRef('modal', objectRef))
    const node = modal()
    const cleanup = result.current(node as HTMLDivElement) as () => void
    expect(objectRef.current).toBe(node)
    cleanup()
    expect(objectRef.current).toBeNull()
    expect(ghosts()).toHaveLength(0)
  })

  it('leaves a ghost once the node has been on screen', async () => {
    const { result } = renderHook(() => useExitMotionRef('menu'))
    const node = modal()
    const cleanup = result.current(node as HTMLDivElement) as () => void
    await Promise.resolve()
    cleanup()
    expect(ghosts()).toHaveLength(1)
  })

  it('keeps a stable callback so React does not re-run it on every render', () => {
    const objectRef = { current: null }
    const { result, rerender } = renderHook(() => useExitMotionRef('menu', objectRef))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
