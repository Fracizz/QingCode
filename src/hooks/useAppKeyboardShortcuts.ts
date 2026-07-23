import { useEffect } from 'react'
import {
  copyActiveFileReferenceAction,
  copyActivePathAction,
  copyActiveRelativePathAction,
} from '../lib/copyFileActions'
import { formatDocument } from '../lib/formatDocument'
import { requestTerminalClear, requestTerminalSearch } from '@/lib/terminal/terminalViewBridge'
import {
  COPY_RELATIVE_PATH_SHORTCUT,
  isShortcutInputTarget,
  shortcutMatchesEvent,
} from '../lib/shortcuts'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import type { ShortcutMap } from '../lib/shortcuts'

function isTerminalKeyTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('.xterm'))
}

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
      } else if (shortcutMatchesEvent(shortcuts.toggleMinimap, event)) {
        event.preventDefault()
        void import('../lib/commands').then(({ buildCommands }) => {
          const command = buildCommands().find(item => item.id === 'view.toggleMinimap')
          if (command && (!command.when || command.when())) void command.run()
        })
      } else if (shortcutMatchesEvent(shortcuts.togglePanelLayout, event)) {
        event.preventDefault()
        void import('../lib/commands').then(({ buildCommands }) => {
          const command = buildCommands().find(item => item.id === 'view.togglePanelLayout')
          if (command && (!command.when || command.when())) void command.run()
        })
      } else if (
        shortcutMatchesEvent(shortcuts.findInTerminal, event) &&
        isTerminalKeyTarget(event.target)
      ) {
        event.preventDefault()
        useUIStore.getState().openTerminalPanel()
        requestTerminalSearch()
      } else if (
        shortcutMatchesEvent(shortcuts.clearTerminal, event) &&
        isTerminalKeyTarget(event.target)
      ) {
        event.preventDefault()
        requestTerminalClear()
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
      } else if (shortcutMatchesEvent('Ctrl+Shift+C', event)) {
        // Capture-phase for Windows/IME reliability. Prefers focused explorer
        // selection over the active editor tab (see copyActivePathAction).
        if (isTerminalKeyTarget(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        void copyActivePathAction()
      } else if (shortcutMatchesEvent(COPY_RELATIVE_PATH_SHORTCUT, event)) {
        if (isTerminalKeyTarget(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        void copyActiveRelativePathAction()
      } else if (shortcutMatchesEvent('Alt+C', event)) {
        if (isTerminalKeyTarget(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        void copyActiveFileReferenceAction()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [shortcuts, setView, openPalette, openSymbolPicker])
}
