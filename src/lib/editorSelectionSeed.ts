import type { EditorState } from '@codemirror/state'
import { getEditorView } from './editorSession'
import { useEditorStore } from '../store/editorStore'

export interface EditorSelectionSeedOptions {
  maxLength?: number
  singleLine?: boolean
}

/**
 * Text that can safely seed a search picker from the primary editor selection.
 * Empty, multiple, oversized, and (optionally) multiline selections are ignored.
 */
export function editorSelectionSeed(
  state: EditorState,
  options: EditorSelectionSeedOptions = {}
): string {
  if (state.selection.ranges.length !== 1 || state.selection.main.empty) return ''
  const maxLength = options.maxLength ?? 500
  const { from, to } = state.selection.main
  if (to - from > maxLength) return ''
  const text = state.sliceDoc(from, to).trim()
  if (!text || text.length > maxLength) return ''
  if (options.singleLine && /[\r\n]/.test(text)) return ''
  return text
}

/** Read the live active editor before a global shortcut moves focus elsewhere. */
export function activeEditorSelectionSeed(
  options: EditorSelectionSeedOptions = {}
): string {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find(tab => tab.id === editor.activeTabId)
  if (!activeTab || activeTab.kind === 'diff') return ''
  const view = getEditorView(activeTab.id)
  return view ? editorSelectionSeed(view.state, options) : ''
}
