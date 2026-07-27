import { SearchQuery, getSearchQuery, openSearchPanel, setSearchQuery } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { getEditorView } from './editorSession'
import { editorSelectionSeed } from './editorSelectionSeed'
import { useEditorStore } from '../store/editorStore'

/** CodeMirror's defaultQuery also caps selection at 100 characters. */
const FIND_SEED_MAX_LENGTH = 100

/**
 * Prefill the editor find panel from the primary selection (e.g. a double-clicked
 * word), then open/focus the panel. Returns false when no editor view is active.
 */
export function openFindInEditorView(view: EditorView): boolean {
  const seeded = editorSelectionSeed(view.state, {
    maxLength: FIND_SEED_MAX_LENGTH,
    singleLine: true,
  })
  if (seeded) {
    const current = getSearchQuery(view.state)
    if (seeded !== current.search) {
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: seeded,
            replace: current.replace,
            caseSensitive: current.caseSensitive,
            regexp: current.regexp,
            wholeWord: current.wholeWord,
          })
        ),
      })
    }
  }
  return openSearchPanel(view)
}

/** Open find in the active editor tab, seeding from the current selection. */
export function openFindInActiveEditor(): boolean {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find(tab => tab.id === editor.activeTabId)
  if (!activeTab || activeTab.kind === 'diff') return false
  const view = getEditorView(activeTab.id)
  return view ? openFindInEditorView(view) : false
}
