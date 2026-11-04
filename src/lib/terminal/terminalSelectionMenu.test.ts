// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { protectTerminalSelectionMenu, shouldUseTerminalContextMenu } from './terminalSelectionMenu'

const disposers: Array<() => void> = []
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
})

function setup(selected = true, appMenu = true) {
  const container = document.createElement('div')
  const screen = container.appendChild(document.createElement('div'))
  document.body.appendChild(container)
  const getSelection = vi.fn(() => (selected ? 'selected text' : ''))
  const reportDown = vi.fn()
  const reportUp = vi.fn()
  const showMenu = vi.fn()
  // Match xterm: button presses on the terminal, releases on document.
  screen.addEventListener('mousedown', reportDown)
  document.addEventListener('mouseup', reportUp)
  container.addEventListener('contextmenu', showMenu)
  const openMenu = vi.fn()
  const dispose = protectTerminalSelectionMenu(container, getSelection, () => appMenu, openMenu)
  disposers.push(dispose, () => document.removeEventListener('mouseup', reportUp))
  const send = (type: string, button: number, target: EventTarget = screen) =>
    target.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }))
  return { screen, getSelection, reportDown, reportUp, showMenu, openMenu, send, dispose }
}

describe('terminal selection context menu', () => {
  it.each(['x10', 'vt200', 'drag', 'any'])(
    'leaves %s TUI menus alone unless selection or Shift wins',
    mode => {
      expect(shouldUseTerminalContextMenu(false, mode, false)).toBe(false)
      expect(shouldUseTerminalContextMenu(true, mode, false)).toBe(true)
      expect(shouldUseTerminalContextMenu(false, mode, true)).toBe(true)
    }
  )

  it('keeps the ordinary shell context menu', () => {
    expect(shouldUseTerminalContextMenu(false, 'none', false)).toBe(true)
  })

  it('protects Shift right-click even without a selection', () => {
    const test = setup(false)
    test.screen.dispatchEvent(
      new MouseEvent('mousedown', { button: 2, shiftKey: true, bubbles: true })
    )
    test.send('mouseup', 2)
    expect(test.reportDown).not.toHaveBeenCalled()
    expect(test.reportUp).not.toHaveBeenCalled()
  })

  it('opens the menu without reporting either half of a selected right-click to the TUI', () => {
    const test = setup()
    test.send('mousedown', 2)
    test.send('contextmenu', 2)
    // Output may clear the selection before the user releases the mouse outside the terminal.
    test.getSelection.mockReturnValue('')
    test.send('mouseup', 2, document.body)
    expect(test.reportDown).not.toHaveBeenCalled()
    expect(test.reportUp).not.toHaveBeenCalled()
    expect(test.showMenu).not.toHaveBeenCalled()
    expect(test.openMenu).toHaveBeenCalledWith(expect.any(MouseEvent), 'selected text')
    test.send('mouseup', 2)
    expect(test.reportUp).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'keeps the press-time text when output clears selection before contextmenu (release first: %s)',
    releaseFirst => {
      const test = setup()
      test.send('mousedown', 2)
      test.getSelection.mockReturnValue('')
      if (releaseFirst) test.send('mouseup', 2)
      test.send('contextmenu', 2)
      if (!releaseFirst) test.send('mouseup', 2)
      expect(test.openMenu).toHaveBeenCalledWith(expect.any(MouseEvent), 'selected text')
      expect(test.showMenu).not.toHaveBeenCalled()
      expect(test.reportDown).not.toHaveBeenCalled()
      expect(test.reportUp).not.toHaveBeenCalled()
    }
  )

  it('captures contextmenu before a target handler can clear selection', () => {
    const test = setup()
    const targetMenu = vi.fn(() => test.getSelection.mockReturnValue(''))
    test.screen.addEventListener('contextmenu', targetMenu)
    test.send('contextmenu', 2)
    expect(targetMenu).not.toHaveBeenCalled()
    expect(test.openMenu).toHaveBeenCalledWith(expect.any(MouseEvent), 'selected text')
  })

  it.each([
    { selected: false, appMenu: true, button: 2 },
    { selected: true, appMenu: false, button: 2 },
    { selected: true, appMenu: true, button: 0 },
    { selected: true, appMenu: true, button: 1 },
  ])('preserves other mouse interactions: %j', ({ selected, appMenu, button }) => {
    const test = setup(selected, appMenu)
    test.send('mousedown', button)
    test.send('mouseup', button)
    expect(test.reportDown).toHaveBeenCalledOnce()
    expect(test.reportUp).toHaveBeenCalledOnce()
  })

  it('removes all capture listeners on dispose', () => {
    const test = setup()
    test.send('mousedown', 2)
    test.dispose()
    test.send('mousedown', 2)
    test.send('mouseup', 2)
    test.send('contextmenu', 2)
    expect(test.reportDown).toHaveBeenCalledOnce()
    expect(test.reportUp).toHaveBeenCalledOnce()
    expect(test.openMenu).not.toHaveBeenCalled()
  })
})
