import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useEditorStore } from '../store/editorStore'

/** Documents at/above this size use a lighter first-paint editor setup. */
export const LARGE_DOC_CHARS = 512 * 1024

/** Skip language highlighting entirely — parse cost dominates for multi‑MB buffers. */
export const HUGE_DOC_CHARS = 5 * 1024 * 1024

export interface EditorScrollPos {
  top: number
  left: number
}

/** Live EditorView for the currently displayed tab (at most one). */
const views = new Map<string, EditorView>()

/**
 * Cached EditorState per tab — preserves undo/redo, selection, and folds when
 * the tab is not bound to the single shared EditorView.
 */
const states = new Map<string, EditorState>()

/** Viewport scroll is view/DOM state and must be stored separately. */
const scrolls = new Map<string, EditorScrollPos>()

export function isLargeDocument(content: string | undefined | null): boolean {
  return (content?.length ?? 0) >= LARGE_DOC_CHARS
}

export function isHugeDocument(content: string | undefined | null): boolean {
  return (content?.length ?? 0) >= HUGE_DOC_CHARS
}

export function registerEditorView(tabId: string, view: EditorView) {
  views.set(tabId, view)
}

export function unregisterEditorView(tabId: string, view?: EditorView) {
  const current = views.get(tabId)
  if (!current) return
  if (view && current !== view) return
  views.delete(tabId)
}

export function getEditorView(tabId: string): EditorView | undefined {
  return views.get(tabId)
}

/** Prefer live CodeMirror buffer over Zustand copy (avoids stale/missing content). */
export function getLiveEditorContent(tabId: string): string | null {
  const view = views.get(tabId)
  if (view) return view.state.doc.toString()
  const cached = states.get(tabId)
  return cached ? cached.doc.toString() : null
}

/** Push the live buffer into the editor store so tab switches / save stay correct. */
export function flushLiveEditorContent(tabId: string) {
  const content = getLiveEditorContent(tabId)
  if (content === null) return
  useEditorStore.getState().setTabContent(tabId, content)
}

export function flushAllLiveEditorContents() {
  const ids = new Set<string>([...views.keys(), ...states.keys()])
  for (const tabId of ids) {
    flushLiveEditorContent(tabId)
  }
}

export function getCachedEditorState(tabId: string): EditorState | undefined {
  return states.get(tabId)
}

/** Store a detached EditorState for a tab that is not currently on the view. */
export function setCachedEditorState(tabId: string, state: EditorState) {
  states.set(tabId, state)
}

/** Take ownership of a cached state (removes it from the cache). */
export function takeCachedEditorState(tabId: string): EditorState | undefined {
  const state = states.get(tabId)
  if (state) states.delete(tabId)
  return state
}

export function captureEditorScroll(tabId: string, view: EditorView) {
  scrolls.set(tabId, {
    top: view.scrollDOM.scrollTop,
    left: view.scrollDOM.scrollLeft,
  })
}

export function restoreEditorScroll(tabId: string, view: EditorView) {
  const pos = scrolls.get(tabId)
  if (!pos) return
  const apply = () => {
    view.scrollDOM.scrollTop = pos.top
    view.scrollDOM.scrollLeft = pos.left
  }
  apply()
  requestAnimationFrame(apply)
}

/** Detach and drop runtime editor session data for a closed tab. */
export function disposeEditorSession(tabId: string) {
  const view = views.get(tabId)
  if (view) {
    views.delete(tabId)
  }
  states.delete(tabId)
  scrolls.delete(tabId)
}

export function disposeEditorSessions(tabIds: Iterable<string>) {
  for (const tabId of tabIds) {
    disposeEditorSession(tabId)
  }
}
