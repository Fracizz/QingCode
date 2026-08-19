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
})
