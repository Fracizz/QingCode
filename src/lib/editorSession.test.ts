import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_STATE_CACHE_MAX,
  clearCachedEditorStates,
  getCachedEditorState,
  setCachedEditorState,
  setEditorStateCacheMax,
} from './editorSession'

afterEach(() => {
  clearCachedEditorStates()
  setEditorStateCacheMax(DEFAULT_EDITOR_STATE_CACHE_MAX)
})

describe('editorSession state cache budget', () => {
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
