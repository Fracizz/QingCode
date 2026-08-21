// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SHORTCUTS } from '../lib/shortcuts'
import { useAppKeyboardShortcuts } from './useAppKeyboardShortcuts'

const mocks = vi.hoisted(() => ({
  findUsagesAtActiveEditor: vi.fn(),
  requestGlobalSearch: vi.fn(),
  requestSearch: vi.fn(),
  explorerDirectoryForSearchShortcut: vi.fn<() => string | null>(() => null),
  activeEditorSelectionSeed: vi.fn(() => 'selectedName'),
  openFileFromDialog: vi.fn(),
  copyActivePathAction: vi.fn(),
}))

vi.mock('../lib/copyFileActions', () => ({
  copyActiveFileReferenceAction: vi.fn(),
  copyActivePathAction: mocks.copyActivePathAction,
  copyActiveRelativePathAction: vi.fn(),
}))

vi.mock('../lib/symbolNavigation', () => ({
  findUsagesAtActiveEditor: mocks.findUsagesAtActiveEditor,
}))

vi.mock('../lib/editorSelectionSeed', () => ({
  activeEditorSelectionSeed: mocks.activeEditorSelectionSeed,
}))

vi.mock('../lib/openFileDialog', () => ({
  openFileFromDialog: mocks.openFileFromDialog,
}))

vi.mock('../lib/explorerSelection', () => ({
  explorerDirectoryForSearchShortcut: mocks.explorerDirectoryForSearchShortcut,
}))

vi.mock('../store/uiStore', () => ({
  useUIStore: Object.assign(
    vi.fn(),
    {
      getState: () => ({
        requestGlobalSearch: mocks.requestGlobalSearch,
        requestSearch: mocks.requestSearch,
        openTerminalPanel: vi.fn(),
        requestToggleTerminal: vi.fn(),
      }),
    }
  ),
}))

function ShortcutHarness() {
  useAppKeyboardShortcuts({
    shortcuts: DEFAULT_SHORTCUTS,
    setView: vi.fn(),
    openPalette: vi.fn(),
    openSymbolPicker: vi.fn(),
    openWorkspaceSymbolPicker: vi.fn(),
  })
  return null
}

afterEach(() => {
  mocks.findUsagesAtActiveEditor.mockReset()
  mocks.requestGlobalSearch.mockReset()
  mocks.requestSearch.mockReset()
  mocks.explorerDirectoryForSearchShortcut.mockReset()
  mocks.explorerDirectoryForSearchShortcut.mockReturnValue(null)
  mocks.activeEditorSelectionSeed.mockReset()
  mocks.activeEditorSelectionSeed.mockReturnValue('selectedName')
  mocks.openFileFromDialog.mockReset()
  mocks.copyActivePathAction.mockReset()
})

describe('useAppKeyboardShortcuts', () => {
  it('runs Shift+F12 even when a WebView guard already prevented the event', () => {
    render(<ShortcutHarness />)
    const event = new KeyboardEvent('keydown', {
      key: 'F12',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault()

    window.dispatchEvent(event)

    expect(mocks.findUsagesAtActiveEditor).toHaveBeenCalledOnce()
  })

  it('opens global search with the editor selection on Ctrl+Shift+F', () => {
    render(<ShortcutHarness />)
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })

    window.dispatchEvent(event)

    expect(mocks.activeEditorSelectionSeed).toHaveBeenCalledWith({
      maxLength: 500,
      singleLine: true,
    })
    expect(mocks.requestGlobalSearch).toHaveBeenCalledWith('selectedName')
  })

  it('still seeds Ctrl+Shift+F when focus is already in a search input', () => {
    render(<ShortcutHarness />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const event = new KeyboardEvent('keydown', {
      key: 'F',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'target', { value: input })

    window.dispatchEvent(event)

    expect(mocks.requestGlobalSearch).toHaveBeenCalledWith('selectedName')
    input.remove()
  })

  it('scopes Ctrl+Shift+F to the selected explorer directory', () => {
    mocks.explorerDirectoryForSearchShortcut.mockReturnValue('D:/proj/src')
    render(<ShortcutHarness />)
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })

    window.dispatchEvent(event)

    expect(mocks.requestSearch).toHaveBeenCalledWith('D:/proj/src', 'selectedName')
    expect(mocks.requestGlobalSearch).not.toHaveBeenCalled()
  })

  it('opens the system file picker once on Ctrl+O', () => {
    render(<ShortcutHarness />)
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })

    window.dispatchEvent(event)

    expect(mocks.openFileFromDialog).toHaveBeenCalledOnce()
  })

  it('does not treat Ctrl+Shift+O as the open-file shortcut', () => {
    render(<ShortcutHarness />)
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })

    window.dispatchEvent(event)

    expect(mocks.openFileFromDialog).not.toHaveBeenCalled()
  })

  it('lets an open context menu own its displayed copy-path shortcut', () => {
    render(<ShortcutHarness />)
    const menu = document.createElement('div')
    menu.setAttribute('data-qingcode-context-menu', '')
    const item = document.createElement('button')
    menu.appendChild(item)
    document.body.appendChild(menu)
    item.focus()

    fireEvent.keyDown(item, {
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
    })

    expect(mocks.copyActivePathAction).not.toHaveBeenCalled()
    menu.remove()
  })
})
