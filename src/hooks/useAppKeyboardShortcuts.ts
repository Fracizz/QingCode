import { useEffect } from 'react'
import { formatDocument } from '../lib/formatDocument'
import { isShortcutInputTarget, shortcutMatchesEvent } from '../lib/shortcuts'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import type { ShortcutMap } from '../lib/shortcuts'

export interface UseAppKeyboardShortcutsDeps {
  shortcuts: ShortcutMap
  setView: (view: import('../store/uiStore').View) => void
  openPalette: (seedQuery?: string) => void
  openSymbolPicker: () => void
}

export function useAppKeyboardShortcuts({
  shortcuts,
  setView,
  openPalette,
  openSymbolPicker,
}: UseAppKeyboardShortcutsDeps) {
  useEffect(() => {
    const isCommandPaletteShortcut = (event: KeyboardEvent) => {
      if (shortcutMatchesEvent(shortcuts.openCommandPalette, event)) return true
      // Cmd+Shift+P on macOS when the remappable binding remains Ctrl+Shift+P.
      return (
        shortcuts.openCommandPalette === 'Ctrl+Shift+P' &&
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'p'
      )
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Available from inputs / terminal so the palette stays globally discoverable.
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault()
        openPalette('> ')
        return
      }
      if (shortcutMatchesEvent(shortcuts.quickOpen, event)) {
        event.preventDefault()
        openPalette('')
        return
      }

      if (isShortcutInputTarget(event.target)) return
      if (event.ctrlKey && event.key === 'Tab' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        useEditorStore.getState().cycleTabMru()
        return
      }
      if (shortcutMatchesEvent(shortcuts.goToLine, event)) {
        event.preventDefault()
        void import('../lib/commands').then(({ buildCommands }) => {
          const command = buildCommands().find(item => item.id === 'editor.goToLine')
          if (command && (!command.when || command.when())) void command.run()
        })
      } else if (shortcutMatchesEvent(shortcuts.goToSymbolInEditor, event)) {
        event.preventDefault()
        openSymbolPicker()
      } else if (shortcutMatchesEvent(shortcuts.searchAllProjects, event)) {
        event.preventDefault()
        useUIStore.getState().requestGlobalSearch()
      } else if (shortcutMatchesEvent(shortcuts.toggleTerminal, event)) {
        event.preventDefault()
        useUIStore.getState().requestToggleTerminal()
      } else if (shortcutMatchesEvent(shortcuts.openSettings, event)) {
        event.preventDefault()
        setView('settings')
      } else if (shortcutMatchesEvent('Shift+Alt+F', event)) {
        // Handle in capture phase so format works even when CodeMirror has focus.
        // (Previously skipped .cm-editor and relied on CM keymap, which often missed
        // Alt+Shift+F on Windows / IME.) Skip only the terminal.
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('.xterm')
        ) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        void formatDocument()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [shortcuts, setView, openPalette, openSymbolPicker])
}
