// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import SidebarSlot from './SidebarSlot'

interface FakeAnimation {
  keyframes: Keyframe[]
  onfinish: (() => void) | null
  cancel: ReturnType<typeof vi.fn>
}

/** jsdom 没有 Web Animations：用假的 animate 记录关键帧，手动触发 finish。 */
function installFakeAnimate(width: number) {
  const calls: { el: HTMLElement; animation: FakeAnimation }[] = []
  const animate = vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
    const animation: FakeAnimation = { keyframes, onfinish: null, cancel: vi.fn() }
    calls.push({ el: this, animation })
    return animation as unknown as Animation
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
  return calls
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
})

function Slot(props: {
  leaving: boolean
  animateOpen: boolean
  onExited: () => void
  width?: number
  widthMode?: 'sidebar' | 'page'
}) {
  return (
    <SidebarSlot freezeTerminals={false} {...props} width={props.width ?? 260}>
      <div data-testid="content">侧栏</div>
    </SidebarSlot>
  )
}

describe('SidebarSlot', () => {
  it('首屏挂载不播展开', () => {
    const calls = installFakeAnimate(260)
    render(<Slot leaving={false} animateOpen={false} onExited={() => {}} />)
    expect(calls).toHaveLength(0)
  })

  it('展开时宽度从 0 过渡到侧栏宽度，内容贴右裁切，播完恢复', () => {
    const calls = installFakeAnimate(260)
    const { container } = render(<Slot leaving={false} animateOpen onExited={() => {}} />)
    const slot = container.firstElementChild as HTMLElement
    expect(calls[0].el).toBe(slot)
    expect(calls[0].animation.keyframes).toEqual([{ width: '0px' }, { width: '260px' }])
    expect(slot.style.overflow).toBe('hidden')
    expect(slot.style.justifyContent).toBe('flex-end')
    calls[0].animation.onfinish?.()
    expect(slot.style.overflow).toBe('')
    expect(slot.style.justifyContent).toBe('')
  })

  it('收起时宽度收拢到 0 并淡出内容，播完才通知卸载且保持裁切', () => {
    const calls = installFakeAnimate(260)
    const onExited = vi.fn()
    const { container, rerender } = render(<Slot leaving={false} animateOpen={false} onExited={onExited} />)
    rerender(<Slot leaving animateOpen={false} onExited={onExited} />)
    const slot = container.firstElementChild as HTMLElement
    expect(slot.hasAttribute('inert')).toBe(true)
    expect(calls.map(c => c.animation.keyframes)).toEqual([
      [{ width: '260px' }, { width: '0px' }],
      [{ opacity: 1 }, { opacity: 0 }],
    ])
    expect(onExited).not.toHaveBeenCalled()
    calls[0].animation.onfinish?.()
    expect(onExited).toHaveBeenCalledTimes(1)
    expect(slot.style.overflow).toBe('hidden')
  })

  it('不支持动画时收起立即通知卸载', () => {
    const onExited = vi.fn()
    const { rerender } = render(<Slot leaving={false} animateOpen={false} onExited={onExited} />)
    rerender(<Slot leaving animateOpen={false} onExited={onExited} />)
    expect(onExited).toHaveBeenCalledTimes(1)
  })

  it('工作台整页与窄栏共享左缘，连切时从当前宽度反向', () => {
    const calls = installFakeAnimate(420)
    const props = { leaving: false, animateOpen: false, onExited: vi.fn() }
    const { container, rerender } = render(<Slot {...props} widthMode="sidebar" />)
    rerender(<Slot {...props} widthMode="page" width={620} />)
    expect(calls[0].animation.keyframes).toEqual([{ width: '260px' }, { width: '620px' }])
    expect((container.firstElementChild as HTMLElement).style.justifyContent).toBe('flex-start')
    rerender(<Slot {...props} widthMode="sidebar" />)
    expect(calls[0].animation.cancel).toHaveBeenCalledOnce()
    expect(calls[1].animation.keyframes).toEqual([{ width: '420px' }, { width: '260px' }])
    calls[1].animation.onfinish?.()
    rerender(<Slot {...props} widthMode="sidebar" width={280} />)
    expect(calls).toHaveLength(2)
  })
})
