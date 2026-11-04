// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ContextMenu from './ContextMenu'

describe('ContextMenu shortcuts', () => {
  it('runs the matching visible shortcut action once', async () => {
    const copyProjectPath = vi.fn()
    const onClose = vi.fn()
    render(
      <ContextMenu
        x={20}
        y={20}
        onClose={onClose}
        items={[
          {
            label: '复制路径',
            shortcut: 'Ctrl+Shift+C',
            action: copyProjectPath,
          },
        ]}
      />,
    )

    const item = screen.getByRole('menuitem', { name: /复制路径/u })
    await waitFor(() => expect(item).toHaveFocus())
    fireEvent.keyDown(item, { key: 'c', ctrlKey: true, shiftKey: true })

    expect(copyProjectPath).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not run a disabled matching item', () => {
    const action = vi.fn()
    render(
      <ContextMenu
        x={20}
        y={20}
        onClose={vi.fn()}
        items={[
          {
            label: '复制路径',
            shortcut: 'Ctrl+Shift+C',
            disabled: true,
            action,
          },
        ]}
      />,
    )

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true, shiftKey: true })
    expect(action).not.toHaveBeenCalled()
  })
  it('moves from the initially focused first item and restores the opener on Escape', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const close = vi.fn()
    const view = render(<ContextMenu x={0} y={0} onClose={close} items={[
      { label: '第一项', action: vi.fn() },
      { label: '第二项', action: vi.fn() },
    ]} />)
    const first = screen.getByRole('menuitem', { name: '第一项' })
    const second = screen.getByRole('menuitem', { name: '第二项' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    view.unmount()
    await waitFor(() => expect(opener).toHaveFocus())
    opener.remove()
  })

})
