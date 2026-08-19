import { useEffect } from 'react'
import {
  copyActiveFileReferenceAction,
  copyActivePathAction,
  copyActiveRelativePathAction,
} from '../lib/copyFileActions'
import { formatDocument } from '../lib/formatDocument'
import { buildCommands } from '../lib/commands'
import { requestTerminalClear, requestTerminalSearch } from '@/lib/terminal/terminalViewBridge'
import {
  COPY_RELATIVE_PATH_SHORTCUT,
  isShortcutInputTarget,
  shortcutMatchesEvent,
} from '../lib/shortcuts'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import type { ShortcutMap } from '../lib/shortcuts'
import { openFindInActiveEditor } from '../lib/editorFind'
import { findUsagesAtActiveEditor } from '../lib/symbolNavigation'
import { activeEditorSelectionSeed } from '../lib/editorSelectionSeed'
import { openFileFromDialog } from '../lib/openFileDialog'

function isTerminalKeyTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('.xterm'))
}

export interface UseAppKeyboardShortcutsDeps {
  shortcuts: ShortcutMap
  setView: (view: import('../store/uiStore').View) => void
  openPalette: (seedQuery?: string) => void
  openSymbolPicker: () => void
  openWorkspaceSymbolPicker: (seedQuery?: string) => void
}

export function useAppKeyboardShortcuts({
  shortcuts,
  setView,
  openPalette,
  openSymbolPicker,
  openWorkspaceSymbolPicker,
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
      // ContextMenu owns the shortcuts it displays. Its focused menu button
      // bubbles the event to the menu listener after this capture listener.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-qingcode-context-menu]')
      ) {
        return
      }
      // WebView2 may reserve F12-family accelerators before editor handlers run.
      // Find Usages is an app command, so honor its configured binding even when
      // an earlier native guard already marked the event as prevented.
      if (
        shortcutMatchesEvent(shortcuts.findCalls, event) &&
        !isShortcutInputTarget(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
        void findUsagesAtActiveEditor()
        return
      }
      // Ctrl+Shift+F: always seed from the editor selection (e.g. double-clicked
      // word), even when focus is already in the search input or find panel.
      if (
        shortcutMatchesEvent(shortcuts.searchAllProjects, event) &&
        !isTerminalKeyTarget(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
        useUIStore.getState().requestGlobalSearch(
          activeEditorSelectionSeed({ maxLength: 500, singleLine: true })
        )
        return
      }
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
      if (shortcutMatchesEvent(shortcuts.openFile, event)) {
        event.preventDefault()
        void openFileFromDialog()
        return
      }
      if (shortcutMatchesEvent(shortcuts.goToSymbolInWorkspace, event)) {
        event.preventDefault()
        openWorkspaceSymbolPicker(
          activeEditorSelectionSeed({ maxLength: 200, singleLine: true })
        )
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
        const command = buildCommands().find(item => item.id === 'editor.goToLine')
        if (command && (!command.when || command.when())) void command.run()
      } else if (shortcutMatchesEvent(shortcuts.navigateBack, event)) {
        event.preventDefault()
        const store = useEditorStore.getState()
        if (store.canGoBack()) void store.goBack()
      } else if (shortcutMatchesEvent(shortcuts.navigateForward, event)) {
        event.preventDefault()
        const store = useEditorStore.getState()
        if (store.canGoForward()) void store.goForward()
      } else if (shortcutMatchesEvent(shortcuts.goToSymbolInEditor, event)) {
        event.preventDefault()
        openSymbolPicker()
      } else if (shortcutMatchesEvent(shortcuts.toggleTerminal, event)) {
        event.preventDefault()
        useUIStore.getState().requestToggleTerminal()
      } else if (shortcutMatchesEvent(shortcuts.openSettings, event)) {
        event.preventDefault()
        setView('settings')
      } else if (shortcutMatchesEvent(shortcuts.toggleMinimap, event)) {
        event.preventDefault()
        const command = buildCommands().find(item => item.id === 'view.toggleMinimap')
        if (command && (!command.when || command.when())) void command.run()
      } else if (shortcutMatchesEvent(shortcuts.togglePanelLayout, event)) {
        event.preventDefault()
        const command = buildCommands().find(item => item.id === 'view.togglePanelLayout')
        if (command && (!command.when || command.when())) void command.run()
      } else if (shortcutMatchesEvent(shortcuts.findInTerminal, event)) {
        // Same binding (Ctrl+F): terminal find vs editor find seeded from selection.
        if (isTerminalKeyTarget(event.target)) {
          event.preventDefault()
          useUIStore.getState().openTerminalPanel()
          requestTerminalSearch()
          return
        }
        if (
          !isShortcutInputTarget(event.target) &&
          event.target instanceof HTMLElement &&
          event.target.closest('.cm-editor') &&
          !event.target.closest('.cm-qing-find-replace, .cm-panel')
        ) {
          event.preventDefault()
          event.stopPropagation()
          openFindInActiveEditor()
          return
        }
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
  }, [shortcuts, setView, openPalette, openSymbolPicker, openWorkspaceSymbolPicker])
}
