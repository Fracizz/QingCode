// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScmResizableColumn from './ScmResizableColumn'

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
})
