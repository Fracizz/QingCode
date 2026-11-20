// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useEditorColumnMotion } from './useEditorColumnMotion'
import type { PanelLayoutTemplate } from '../lib/panelLayoutTemplate'
import {
  beginPanelResize,
  endPanelResize,
  PANEL_RESIZE_BEGIN_EVENT,
  PANEL_RESIZE_SETTLE_EVENT,
} from '../lib/panelResize'

interface FakeAnimation {
  el: HTMLElement
  keyframes: Keyframe[]
  onfinish: (() => void) | null
  cancel: ReturnType<typeof vi.fn>
}

/**
 * 假布局：动画进行中（网格带 data-editor-split-motion）编辑器列报告当前帧宽度 animated，
 * 否则报告排版宽度；侧栏也在开合时，排版宽度取决于侧栏此刻的内联宽度。
 */
const size = { natural: 400, animated: 150, grid: 700 }
let animations: FakeAnimation[] = []
const begin = vi.fn()
const settle = vi.fn()

function columnWidth(column: HTMLElement) {
  const grid = column.parentElement!
  if (grid.hasAttribute('data-editor-split-motion')) return size.animated
  const sidebar = grid.querySelector<HTMLElement>('[data-sidebar-motion]')
  if (!sidebar) return size.natural
  return size.grid - parseFloat(sidebar.style.getPropertyValue('width'))
}

/** 浏览器在 observe 之后会回调一次，这里同步模拟，让 hook 记下展开宽度。 */
class FakeResizeObserver {
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe() {
    this.callback([], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  animations = []
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
      const animation: FakeAnimation = { el: this, keyframes, onfinish: null, cancel: vi.fn() }
      animations.push(animation)
      return animation as unknown as Animation
    }),
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: this.dataset.testid === 'column' ? columnWidth(this) : 0 } as DOMRect
  })
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  window.addEventListener(PANEL_RESIZE_BEGIN_EVENT, begin)
  window.addEventListener(PANEL_RESIZE_SETTLE_EVENT, settle)
})

afterEach(async () => {
  // 先卸载让 hook 释放冻结，再清掉 panelResize 的模块级状态，避免影响下一条用例。
  cleanup()
  await Promise.resolve()
  endPanelResize('vertical')
  window.removeEventListener(PANEL_RESIZE_BEGIN_EVENT, begin)
  window.removeEventListener(PANEL_RESIZE_SETTLE_EVENT, settle)
  begin.mockClear()
  settle.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
  delete document.documentElement.dataset.motion
  Object.assign(size, { natural: 400, animated: 150, grid: 700 })
})

interface HarnessProps {
  layout?: PanelLayoutTemplate
  visible: boolean
  enabled?: boolean
  sidebarWidth?: number
  /** 传入时渲染一个正在开合的侧栏，值为它此刻的内联宽度。 */
  sidebarMotionWidth?: string
}

function Harness({ layout = 'sideTerminal', visible, enabled = true, sidebarWidth = 260, sidebarMotionWidth }: HarnessProps) {
  const ref = useEditorColumnMotion(layout, visible, enabled, sidebarWidth)
  return (
    <div data-testid="grid">
      {sidebarMotionWidth !== undefined && (
        <div data-testid="sidebar" data-sidebar-motion="" style={{ width: sidebarMotionWidth }} />
      )}
      <div ref={ref} data-testid="column">
        <div>编辑器</div>
      </div>
    </div>
  )
}

function setup(props: HarnessProps) {
  const view = render(<Harness {...props} />)
  return {
    ...view,
    grid: view.getByTestId('grid'),
    column: view.getByTestId('column'),
  }
}

describe('useEditorColumnMotion', () => {
  it('首次挂载不播动画', () => {
    setup({ visible: true })
    expect(animations).toHaveLength(0)
    expect(begin).not.toHaveBeenCalled()
  })

  it('收起编辑器：从展开宽度过渡到 0，正文保持原宽裁切，播完清理并提交终端尺寸', async () => {
    const { grid, column, rerender } = setup({ visible: true })
    rerender(<Harness visible={false} />)

    expect(animations).toHaveLength(1)
    expect(animations[0].el).toBe(column)
    expect(animations[0].keyframes).toEqual([{ width: '400px' }, { width: '0px' }])
    expect(grid.hasAttribute('data-editor-split-motion')).toBe(true)
    expect(column.style.getPropertyValue('--editor-content-width')).toBe('400px')
    // 起点宽度只用于开动画，交给 Web Animations 后立即移除内联宽度。
    expect(column.style.width).toBe('')
    expect(begin).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()

    animations[0].onfinish?.()
    expect(grid.hasAttribute('data-editor-split-motion')).toBe(false)
    expect(column.style.getPropertyValue('--editor-content-width')).toBe('')
    await Promise.resolve()
    expect(settle).toHaveBeenCalledOnce()
  })

  it('展开编辑器：从 0 过渡到排版宽度，正文按目标宽度显示', () => {
    const { column, rerender } = setup({ visible: false })
    rerender(<Harness visible />)
    expect(animations[0].keyframes).toEqual([{ width: '0px' }, { width: '400px' }])
    expect(column.style.getPropertyValue('--editor-content-width')).toBe('400px')
  })

  it('中途反向：取消上一段，从当前帧宽度接着播，只冻结一次终端', async () => {
    const { rerender } = setup({ visible: true })
    rerender(<Harness visible={false} />)
    rerender(<Harness visible />)

    expect(animations[0].cancel).toHaveBeenCalled()
    expect(animations[1].keyframes).toEqual([{ width: '150px' }, { width: '400px' }])
    expect(begin).toHaveBeenCalledOnce()

    // 被取消的那一段即使迟到触发 onfinish 也不能提前结束新动画。
    animations[0].onfinish?.()
    await Promise.resolve()
    expect(settle).not.toHaveBeenCalled()
    animations[1].onfinish?.()
    await Promise.resolve()
    expect(settle).toHaveBeenCalledOnce()
  })

  it('侧栏同时开合：按侧栏最终宽度测量目标，测量后还原侧栏的内联宽度', () => {
    const { getByTestId, rerender } = setup({ visible: false, sidebarMotionWidth: '100px' })
    rerender(<Harness visible sidebarMotionWidth="100px" />)

    expect(animations[0].keyframes).toEqual([{ width: '0px' }, { width: '440px' }])
    const sidebar = getByTestId('sidebar')
    expect(sidebar.style.width).toBe('100px')
    expect(sidebar.style.getPropertyPriority('width')).toBe('')
  })

  it('动画途中侧栏目标宽度变化时重新瞄准', () => {
    const { rerender } = setup({ visible: false, sidebarMotionWidth: '100px' })
    rerender(<Harness visible sidebarMotionWidth="100px" />)
    rerender(<Harness visible sidebarWidth={0} sidebarMotionWidth="100px" />)

    expect(animations[0].cancel).toHaveBeenCalled()
    expect(animations[1].keyframes).toEqual([{ width: '150px' }, { width: '700px' }])
  })

  it('动画结束后侧栏宽度变化不再触发动画', () => {
    const { rerender } = setup({ visible: true })
    rerender(<Harness visible sidebarWidth={300} />)
    expect(animations).toHaveLength(0)
  })

  it('切换面板布局时立即到位并释放终端', async () => {
    const { grid, rerender } = setup({ visible: true })
    rerender(<Harness visible={false} />)
    rerender(<Harness visible={false} layout="terminalWorkbench" />)

    expect(animations).toHaveLength(1)
    expect(animations[0].cancel).toHaveBeenCalled()
    expect(grid.hasAttribute('data-editor-split-motion')).toBe(false)
    await Promise.resolve()
    expect(settle).toHaveBeenCalledOnce()
  })

  it('窗口尺寸变化时立即到位', () => {
    const { grid, rerender } = setup({ visible: true })
    rerender(<Harness visible={false} />)
    window.dispatchEvent(new Event('resize'))
    expect(animations[0].cancel).toHaveBeenCalled()
    expect(grid.hasAttribute('data-editor-split-motion')).toBe(false)
  })

  it('未启用或减少动效时直接切换', () => {
    const disabled = setup({ visible: true, enabled: false })
    disabled.rerender(<Harness visible={false} enabled={false} />)
    disabled.unmount()

    document.documentElement.dataset.motion = 'reduce'
    const reduced = setup({ visible: true })
    reduced.rerender(<Harness visible={false} />)

    expect(animations).toHaveLength(0)
    expect(begin).not.toHaveBeenCalled()
  })

  it('用户正在拖动分隔条时不抢冻结，直接到位', () => {
    const { grid, rerender } = setup({ visible: true })
    beginPanelResize('vertical')
    begin.mockClear()
    rerender(<Harness visible={false} />)

    expect(animations).toHaveLength(0)
    expect(grid.hasAttribute('data-editor-split-motion')).toBe(false)
    expect(begin).not.toHaveBeenCalled()
  })
})
