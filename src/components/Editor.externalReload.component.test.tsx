// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Editor from './Editor'
import { useEditorStore } from '../store/editorStore'
import { disposeEditorSession, getEditorView } from '../lib/editorSession'

vi.mock('./EditorMinimap', () => ({ default: () => null }))

const initialState = useEditorStore.getState()

describe('Editor external file reload', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    })
    useEditorStore.setState({
      tabs: [
        {
          id: 'reload-tab',
          path: '/test/file.txt',
          name: 'file.txt',
          content: 'old content',
          dirty: false,
        },
      ],
      activeTabId: 'reload-tab',
    })
  })

  afterEach(() => {
    cleanup()
    disposeEditorSession('reload-tab')
    useEditorStore.setState(initialState, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
  })

  it('replaces the live CodeMirror buffer after a disk reload instead of restoring stale text', async () => {
    render(<Editor />)
    await waitFor(() =>
      expect(getEditorView('reload-tab')?.state.doc.toString()).toBe('old content')
    )
    await act(() => useEditorStore.getState().reloadFromDisk('reload-tab', 'changed on disk', 123))
    await waitFor(() =>
      expect(getEditorView('reload-tab')?.state.doc.toString()).toBe('changed on disk')
    )
    expect(useEditorStore.getState().findTab('reload-tab')).toMatchObject({
      content: 'changed on disk',
      dirty: false,
      diskMtime: 123,
    })
  })
})
