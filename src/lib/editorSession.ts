import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  EDIT_DEGRADED_BYTES,
  EDIT_WARN_BYTES,
  editorPerfProfileForTab,
  type EditorPerfProfile,
} from './fileSizePolicy'
import { useEditorStore } from '../store/editorStore'

/** Documents at/above this size use a lighter first-paint editor setup (full profile only). */
export const LARGE_DOC_CHARS = 512 * 1024

/**
 * Skip language highlighting entirely within the full profile (soft warn band).
 * Degraded/plain never load language packs.
 */
export const HUGE_DOC_CHARS = EDIT_WARN_BYTES

/** Max cached EditorState entries for non-plain tabs (LRU). */
export const EDITOR_STATE_CACHE_MAX = 12

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

/** LRU order for `states` (oldest at front). */
const stateLru: string[] = []

/** Viewport scroll is view/DOM state and must be stored separately. */
const scrolls = new Map<string, EditorScrollPos>()

export function isLargeDocument(content: string | undefined | null): boolean {
  return (content?.length ?? 0) >= LARGE_DOC_CHARS
}

export function isHugeDocument(content: string | undefined | null): boolean {
  return (content?.length ?? 0) >= HUGE_DOC_CHARS
}

export function tabEditorPerfProfile(tabId: string): EditorPerfProfile {
  const tab = useEditorStore.getState().findTab(tabId)
  if (!tab) return 'full'
  return editorPerfProfileForTab(tab)
}

/** Whether match-count / heavy search scans should be skipped. */
export function shouldSkipSearchMatchCount(docLength: number): boolean {
  return docLength >= EDIT_DEGRADED_BYTES
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

/**
 * Replace the tab document with `content` (format / external rewrite).
 * Prefers a live view dispatch so undo history is preserved.
 * @returns whether the buffer changed
 */
export function applyEditorDocument(tabId: string, content: string): boolean {
  const view = views.get(tabId)
  if (view) {
    const current = view.state.doc.toString()
    if (current === content) return false
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    })
    useEditorStore.getState().setTabContent(tabId, content)
    useEditorStore.getState().markDirty(tabId)
    return true
  }

  const cached = states.get(tabId)
  if (cached) {
    const current = cached.doc.toString()
    if (current === content) return false
    // Drop cached state so the next bind rebuilds from Zustand with new text.
    states.delete(tabId)
    const idx = stateLru.indexOf(tabId)
    if (idx >= 0) stateLru.splice(idx, 1)
    useEditorStore.getState().setTabContent(tabId, content)
    useEditorStore.getState().markDirty(tabId)
    useEditorStore.getState().bumpContentEpoch(tabId)
    return true
  }

  const tab = useEditorStore.getState().findTab(tabId)
  if (!tab || tab.content === content) return false
  useEditorStore.getState().setTabContent(tabId, content)
  useEditorStore.getState().markDirty(tabId)
  useEditorStore.getState().bumpContentEpoch(tabId)
  return true
}

/** Push the live buffer into the editor store so tab switches / save stay correct. */
export function flushLiveEditorContent(tabId: string) {
  const content = getLiveEditorContent(tabId)
  if (content === null) return
  // Never let a transient empty EditorView wipe a real buffer (create→bind race).
  if (content === '') {
    const tab = useEditorStore.getState().findTab(tabId)
    if (tab?.content && tab.content.length > 0) return
  }
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

function touchStateLru(tabId: string) {
  const idx = stateLru.indexOf(tabId)
  if (idx >= 0) stateLru.splice(idx, 1)
  stateLru.push(tabId)
}

function evictStateCacheIfNeeded() {
  while (states.size > EDITOR_STATE_CACHE_MAX && stateLru.length > 0) {
    const oldest = stateLru.shift()
    if (!oldest || !states.has(oldest)) continue
    const state = states.get(oldest)
    if (state) {
      useEditorStore.getState().setTabContent(oldest, state.doc.toString())
    }
    states.delete(oldest)
  }
}

/**
 * Store a detached EditorState for a tab that is not currently on the view.
 * Plain-profile tabs are not cached (flush first, drop undo history).
 */
export function setCachedEditorState(tabId: string, state: EditorState) {
  if (tabEditorPerfProfile(tabId) === 'plain') {
    useEditorStore.getState().setTabContent(tabId, state.doc.toString())
    states.delete(tabId)
    const idx = stateLru.indexOf(tabId)
    if (idx >= 0) stateLru.splice(idx, 1)
    return
  }
  states.set(tabId, state)
  touchStateLru(tabId)
  evictStateCacheIfNeeded()
}

/** Take ownership of a cached state (removes it from the cache). */
export function takeCachedEditorState(tabId: string): EditorState | undefined {
  const state = states.get(tabId)
  if (state) {
    states.delete(tabId)
    const idx = stateLru.indexOf(tabId)
    if (idx >= 0) stateLru.splice(idx, 1)
  }
  return state
}

/** Drop all cached EditorStates (e.g. after extension-set changes that are not compartmentalized). */
export function clearCachedEditorStates() {
  states.clear()
  stateLru.length = 0
}

/** Drop Zustand content copy for active plain tabs (CM is source of truth). */
export function clearTabContentBuffer(tabId: string) {
  useEditorStore.getState().clearTabContentBuffer(tabId)
}

export function captureEditorScroll(tabId: string, view: EditorView) {
  scrolls.set(tabId, {
    top: view.scrollDOM.scrollTop,
    left: view.scrollDOM.scrollLeft,
  })
}

export function getEditorScroll(tabId: string): EditorScrollPos | undefined {
  return scrolls.get(tabId)
}

export function setEditorScroll(tabId: string, pos: EditorScrollPos) {
  scrolls.set(tabId, { top: pos.top, left: pos.left })
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
  const idx = stateLru.indexOf(tabId)
  if (idx >= 0) stateLru.splice(idx, 1)
  scrolls.delete(tabId)
}

export function disposeEditorSessions(tabIds: Iterable<string>) {
  for (const tabId of tabIds) {
    disposeEditorSession(tabId)
  }
}
