// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScmResizableColumn from './ScmResizableColumn'
import ResizableSidebar from './ResizableSidebar'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.className = ''
  document.body.removeAttribute('data-panel-resize')
})

function pointerEvent(type: string, clientX: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX,
  })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  Object.defineProperty(event, 'isPrimary', { value: true })
  return event
}

describe('ScmResizableColumn', () => {
  it('commits the pending width on window blur and ignores the later pointerup', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(123)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const onWidthChange = vi.fn()
    render(<ScmResizableColumn width={340} minWidth={220} maxWidth={560} onWidthChange={onWidthChange} tooltip="调整宽度"><span>模糊窗口测试</span></ScmResizableColumn>)
    const separator = screen.getByRole('separator')
    const root = screen.getByText('模糊窗口测试').closest('[data-scm-resizable-column]')

    fireEvent(separator, pointerEvent('pointerdown', 340))
    fireEvent(separator, pointerEvent('pointermove', 420))
    expect(onWidthChange).not.toHaveBeenCalled()
    fireEvent(window, new Event('blur'))

    expect(cancel).toHaveBeenCalledWith(123)
    expect(root).toHaveStyle({ width: '420px' })
    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(420)
    expect(document.body).not.toHaveAttribute('data-panel-resize')
    fireEvent(separator, pointerEvent('pointerup', 420))
    expect(onWidthChange).toHaveBeenCalledOnce()
  })

  it('supports keyboard direction, larger steps, bounds and reset while reserving the opposite column', () => {
    const onWidthChange = vi.fn()
    render(<ScmResizableColumn width={340} minWidth={220} maxWidth={560} remainingMin={300} defaultWidth={360} edge="start" onWidthChange={onWidthChange} tooltip="调整宽度"><span>键盘调整测试</span></ScmResizableColumn>)
    const separator = screen.getByRole('separator')
    const root = screen.getByText('键盘调整测试').closest('[data-scm-resizable-column]')!
    Object.defineProperty(root.parentElement, 'clientWidth', { configurable: true, value: 700 })
    expect(separator).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenLastCalledWith(350)
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true })
    expect(onWidthChange).toHaveBeenLastCalledWith(390)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenLastCalledWith(330)
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(onWidthChange).toHaveBeenLastCalledWith(220)
    fireEvent.keyDown(separator, { key: 'End' })
    expect(onWidthChange).toHaveBeenLastCalledWith(400)
    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(onWidthChange).toHaveBeenLastCalledWith(360)
    fireEvent.doubleClick(separator)
    expect(onWidthChange).toHaveBeenLastCalledWith(360)
  })
  it('updates DOM width once per frame and commits only when dragging ends', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = ++frameId
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      frames.delete(id)
    })
    const onWidthChange = vi.fn()

    render(
      <ScmResizableColumn
        width={340}
        minWidth={220}
        maxWidth={560}
        onWidthChange={onWidthChange}
        tooltip="调整宽度"
      >
        <span>列表内容</span>
      </ScmResizableColumn>
    )

    const separator = screen.getByRole('separator')
    const root = screen.getByText('列表内容').closest('[data-scm-resizable-column]')
    expect(root).toHaveStyle({ width: '340px' })

    fireEvent(separator, pointerEvent('pointerdown', 340))
    fireEvent(separator, pointerEvent('pointermove', 370))
    fireEvent(separator, pointerEvent('pointermove', 410))

    expect(window.requestAnimationFrame).toHaveBeenCalledOnce()
    expect(onWidthChange).not.toHaveBeenCalled()
    expect(root).toHaveStyle({ width: '340px' })

    frames.get(1)?.(0)
    expect(root).toHaveStyle({ width: '410px' })
    expect(onWidthChange).not.toHaveBeenCalled()

    fireEvent(separator, pointerEvent('pointerup', 410))
    expect(onWidthChange).toHaveBeenCalledOnce()
    expect(onWidthChange).toHaveBeenCalledWith(410)
  })
  it('can grow and reset a sidebar whose parent grid track follows its current width', () => {
    const onWidthChange = vi.fn()
    render(<ResizableSidebar width={180} onWidthChange={onWidthChange}><span>网格侧栏</span></ResizableSidebar>)
    const root = screen.getByText('网格侧栏').closest('[data-scm-resizable-column]')!
    Object.defineProperty(root.parentElement, 'clientWidth', { configurable: true, value: 180 })
    const separator = screen.getByRole('separator')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenLastCalledWith(190)
    fireEvent.keyDown(separator, { key: 'End' })
    expect(onWidthChange).toHaveBeenLastCalledWith(520)
    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(onWidthChange).toHaveBeenLastCalledWith(320)
    fireEvent(separator, pointerEvent('pointerdown', 180))
    fireEvent(separator, pointerEvent('pointermove', 300))
    fireEvent(separator, pointerEvent('pointerup', 300))
    expect(onWidthChange).toHaveBeenLastCalledWith(300)
  })

})
