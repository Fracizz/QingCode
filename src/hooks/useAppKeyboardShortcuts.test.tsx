// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SHORTCUTS } from '../lib/shortcuts'
import { useAppKeyboardShortcuts } from './useAppKeyboardShortcuts'

const mocks = vi.hoisted(() => ({
  findUsagesAtActiveEditor: vi.fn(),
  requestGlobalSearch: vi.fn(),
  activeEditorSelectionSeed: vi.fn(() => 'selectedName'),
}))

vi.mock('../lib/symbolNavigation', () => ({
  findUsagesAtActiveEditor: mocks.findUsagesAtActiveEditor,
}))

vi.mock('../lib/editorSelectionSeed', () => ({
  activeEditorSelectionSeed: mocks.activeEditorSelectionSeed,
}))

vi.mock('../store/uiStore', () => ({
  useUIStore: Object.assign(
    vi.fn(),
    {
      getState: () => ({
        requestGlobalSearch: mocks.requestGlobalSearch,
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
  mocks.activeEditorSelectionSeed.mockReset()
  mocks.activeEditorSelectionSeed.mockReturnValue('selectedName')
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
})
