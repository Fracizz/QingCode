// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import SidebarSlot from './SidebarSlot'
import { endPanelResize, PANEL_RESIZE_BEGIN_EVENT, PANEL_RESIZE_SETTLE_EVENT } from '../lib/panelResize'

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

  it('收起时只过渡宽度，播完才通知卸载且保持裁切', () => {
    const calls = installFakeAnimate(260)
    const onExited = vi.fn()
    const { container, rerender } = render(<Slot leaving={false} animateOpen={false} onExited={onExited} />)
    rerender(<Slot leaving animateOpen={false} onExited={onExited} />)
    const slot = container.firstElementChild as HTMLElement
    expect(slot.hasAttribute('inert')).toBe(true)
    expect(calls.map(c => c.animation.keyframes)).toEqual([
      [{ width: '260px' }, { width: '0px' }],
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

  it('StrictMode 重新挂载时保留快照，展开完成后才适配终端', async () => {
    const calls = installFakeAnimate(0)
    const begin = vi.fn()
    const settle = vi.fn()
    window.addEventListener(PANEL_RESIZE_BEGIN_EVENT, begin)
    window.addEventListener(PANEL_RESIZE_SETTLE_EVENT, settle)
    try {
      render(
        <StrictMode>
          <SidebarSlot width={260} leaving={false} animateOpen freezeTerminals onExited={() => {}}>
            <div>侧栏</div>
          </SidebarSlot>
        </StrictMode>,
      )
      await Promise.resolve()
      expect(begin).toHaveBeenCalledOnce()
      expect(settle).not.toHaveBeenCalled()
      calls.at(-1)?.animation.onfinish?.()
      await Promise.resolve()
      expect(settle).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(PANEL_RESIZE_BEGIN_EVENT, begin)
      window.removeEventListener(PANEL_RESIZE_SETTLE_EVENT, settle)
      endPanelResize('vertical')
    }
  })

  it('同宽换页保持槽位，开合反向时从当前宽度继续', () => {
    const calls = installFakeAnimate(104)
    const props = { leaving: false, animateOpen: false, onExited: vi.fn() }
    const { rerender } = render(<Slot {...props} />)
    rerender(<Slot {...props} onExited={vi.fn()} />)
    expect(calls).toHaveLength(0)
    rerender(<Slot {...props} leaving />)
    expect(calls[0].animation.keyframes).toEqual([{ width: '260px' }, { width: '0px' }])
    rerender(<Slot {...props} />)
    expect(calls[0].animation.cancel).toHaveBeenCalledOnce()
    expect(calls[1].animation.keyframes).toEqual([{ width: '104px' }, { width: '260px' }])
    calls[1].animation.onfinish?.()
    rerender(<Slot {...props} width={280} />)
    expect(calls).toHaveLength(2)
    expect(props.onExited).not.toHaveBeenCalled()
  })
})
