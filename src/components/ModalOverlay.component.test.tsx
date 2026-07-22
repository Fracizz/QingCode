// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import ModalOverlay from './ModalOverlay'

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开对话框
      </button>
      {open && (
        <ModalOverlay onDismiss={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="test-title" aria-describedby="test-description">
            <h2 id="test-title">测试对话框</h2>
            <p id="test-description">测试焦点管理</p>
            <button type="button">第一个操作</button>
            <button type="button">第二个操作</button>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}

describe('ModalOverlay', () => {
  it('auto-focuses the first control and traps Tab focus', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByRole('button', { name: '打开对话框' }))

    const first = screen.getByRole('button', { name: '第一个操作' })
    const second = screen.getByRole('button', { name: '第二个操作' })
    expect(first).toHaveFocus()

    second.focus()
    fireEvent.keyDown(second, { key: 'Tab' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(second).toHaveFocus()
  })

  it('closes on Escape and restores focus to the opener', async () => {
    render(<DialogHarness />)
    const opener = screen.getByRole('button', { name: '打开对话框' })
    opener.focus()
    fireEvent.click(opener)

    fireEvent.keyDown(screen.getByRole('button', { name: '第一个操作' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
