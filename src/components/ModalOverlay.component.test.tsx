// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import ModalOverlay from './ModalOverlay'
import ContextMenu from './ContextMenu'

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开对话框
      </button>
      {open && (
        <ModalOverlay onDismiss={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="test-title"
            aria-describedby="test-description"
          >
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

function NestedDialogHarness() {
  const [parentOpen, setParentOpen] = useState(false)
  const [childOpen, setChildOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setParentOpen(true)}>
        打开父对话框
      </button>
      {parentOpen && (
        <ModalOverlay onDismiss={() => setParentOpen(false)}>
          <div role="dialog" aria-label="父对话框" aria-modal="true">
            <button type="button" onClick={() => setChildOpen(true)}>
              打开子对话框
            </button>
            <button type="button">父操作</button>
            {childOpen && (
              <ModalOverlay onDismiss={() => setChildOpen(false)} zIndex="z-[110]">
                <div role="dialog" aria-label="子对话框" aria-modal="true">
                  <button type="button">子操作</button>
                </div>
              </ModalOverlay>
            )}
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

  it('stops double-clicks from reaching title-bar maximize handlers', () => {
    const onChromeDoubleClick = vi.fn()
    render(
      <div onDoubleClick={onChromeDoubleClick}>
        <ModalOverlay>
          <div role="dialog" aria-label="测试对话框">
            <button type="button">操作</button>
          </div>
        </ModalOverlay>
      </div>
    )
    fireEvent.doubleClick(screen.getByRole('button', { name: '操作' }))
    expect(onChromeDoubleClick).not.toHaveBeenCalled()
    expect(document.querySelector('[data-modal-overlay]')).toHaveClass('window-no-drag-region')
  })

  it('returns focus to the parent dialog after its nested dialog closes', async () => {
    render(<NestedDialogHarness />)
    fireEvent.click(screen.getByRole('button', { name: '打开父对话框' }))
    const childOpener = screen.getByRole('button', { name: '打开子对话框' })
    fireEvent.click(childOpener)

    const childAction = screen.getByRole('button', { name: '子操作' })
    expect(childAction).toHaveFocus()
    fireEvent.keyDown(childAction, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '子对话框' })).not.toBeInTheDocument()
    )
    await waitFor(() => expect(childOpener).toHaveFocus())
  })
  it('lets a portaled menu handle Escape before dismissing its parent dialog', () => {
    const dismiss = vi.fn()
    const closeMenu = vi.fn()
    render(<ModalOverlay onDismiss={dismiss}><div role="dialog"><button>Open</button>
      <ContextMenu x={10} y={10} items={[{ label: 'Action', action: vi.fn() }]} onClose={closeMenu} />
    </div></ModalOverlay>)
    const item = screen.getByRole('menuitem', { name: 'Action' })
    item.focus()
    fireEvent.keyDown(item, { key: 'Escape' })
    expect(closeMenu).toHaveBeenCalledOnce()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('preserves the original opener when Strict Mode replays focus effects', async () => {
    render(<StrictMode><DialogHarness /></StrictMode>)
    const opener = screen.getByRole('button', { name: '打开对话框' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.keyDown(screen.getByRole('button', { name: '第一个操作' }), { key: 'Escape' })
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('does not steal focus from a new action after a nested dialog closes', async () => {
    render(<NestedDialogHarness />)
    fireEvent.click(screen.getByRole('button', { name: '打开父对话框' }))
    fireEvent.click(screen.getByRole('button', { name: '打开子对话框' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '子操作' }), { key: 'Escape' })
    const next = screen.getByRole('button', { name: '父操作' })
    next.focus()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(next).toHaveFocus()
  })

})
