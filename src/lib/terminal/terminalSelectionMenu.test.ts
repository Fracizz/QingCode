// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { protectTerminalSelectionMenu } from './terminalSelectionMenu'

const disposers: Array<() => void> = []
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
})

function setup(selected = true, appMenu = true) {
  const container = document.createElement('div')
  const screen = container.appendChild(document.createElement('div'))
  document.body.appendChild(container)
  const hasSelection = vi.fn(() => selected)
  const reportDown = vi.fn()
  const reportUp = vi.fn()
  const showMenu = vi.fn()
  // Match xterm: button presses on the terminal, releases on document.
  screen.addEventListener('mousedown', reportDown)
  document.addEventListener('mouseup', reportUp)
  container.addEventListener('contextmenu', showMenu)
  const dispose = protectTerminalSelectionMenu(container, hasSelection, () => appMenu)
  disposers.push(dispose, () => document.removeEventListener('mouseup', reportUp))
  const send = (type: string, button: number, target: EventTarget = screen) =>
    target.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }))
  return { screen, hasSelection, reportDown, reportUp, showMenu, send, dispose }
}

describe('terminal selection context menu', () => {
  it('opens the menu without reporting either half of a selected right-click to the TUI', () => {
    const test = setup()
    test.send('mousedown', 2)
    test.send('contextmenu', 2)
    // Output may clear the selection before the user releases the mouse outside the terminal.
    test.hasSelection.mockReturnValue(false)
    test.send('mouseup', 2, document.body)
    expect(test.reportDown).not.toHaveBeenCalled()
    expect(test.reportUp).not.toHaveBeenCalled()
    expect(test.showMenu).toHaveBeenCalledOnce()
    test.send('mouseup', 2)
    expect(test.reportUp).toHaveBeenCalledOnce()
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

  it('removes both capture listeners on dispose', () => {
    const test = setup()
    test.send('mousedown', 2)
    test.dispose()
    test.send('mousedown', 2)
    test.send('mouseup', 2)
    expect(test.reportDown).toHaveBeenCalledOnce()
    expect(test.reportUp).toHaveBeenCalledOnce()
  })
})
