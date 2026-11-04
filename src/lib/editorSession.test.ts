import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '../store/editorStore'
import {
  DEFAULT_EDITOR_STATE_CACHE_MAX,
  clearCachedEditorStates,
  flushAllLiveEditorContents,
  getCachedEditorState,
  setCachedEditorState,
  setEditorStateCacheMax,
} from './editorSession'

afterEach(() => {
  clearCachedEditorStates()
  setEditorStateCacheMax(DEFAULT_EDITOR_STATE_CACHE_MAX)
})

describe('editorSession state cache budget', () => {
  it('settles session persistence after flushing a cached buffer instead of saving forever', async () => {
    vi.useFakeTimers()
    useEditorStore.setState({
      tabs: [],
      projectSessions: { inactive: { tabs: [{
        id: 'cached', path: 'D:/project/a.ts', name: 'a.ts', content: 'old',
        dirty: true, language: 'typescript',
      }], activeTabId: 'cached', pendingReveal: null } },
    })
    setCachedEditorState('cached', EditorState.create({ doc: 'new unsaved buffer' }))
    const persist = vi.fn(() => flushAllLiveEditorContents())
    const unsubscribe = useEditorStore.subscribe(() => { setTimeout(persist, 400) })
    try {
      flushAllLiveEditorContents()
      await vi.advanceTimersByTimeAsync(5000)
      expect(useEditorStore.getState().findTab('cached')?.content).toBe('new unsaved buffer')
      expect(persist).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('evicts the least-recent state immediately when the custom budget is exceeded', () => {
    setEditorStateCacheMax(2)
    setCachedEditorState('a', EditorState.create({ doc: 'a' }))
    setCachedEditorState('b', EditorState.create({ doc: 'b' }))
    setCachedEditorState('a', EditorState.create({ doc: 'a2' }))
    setCachedEditorState('c', EditorState.create({ doc: 'c' }))

    expect(getCachedEditorState('a')?.doc.toString()).toBe('a2')
    expect(getCachedEditorState('b')).toBeUndefined()
    expect(getCachedEditorState('c')?.doc.toString()).toBe('c')
  })
})
