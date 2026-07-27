// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { search, searchKeymap, getSearchQuery } from '@codemirror/search'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorFindReplacePanel } from '../components/EditorFindReplacePanel'
import { openFindInEditorView } from './editorFind'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.replaceChildren()
})

describe('openFindInEditorView', () => {
  it('opens find and prefills from the selected (double-click style) text', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'before selectedName after',
        selection: EditorSelection.range(7, 19),
        extensions: [
          keymap.of(searchKeymap),
          search({ top: true, createPanel: createEditorFindReplacePanel }),
        ],
      }),
    })

    expect(openFindInEditorView(view)).toBe(true)
    expect(getSearchQuery(view.state).search).toBe('selectedName')
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[main-field]')?.value).toBe(
        'selectedName'
      )
    )
  })

  it('updates an already-open find panel when the selection changes', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'alpha beta',
        selection: EditorSelection.range(0, 5),
        extensions: [
          keymap.of(searchKeymap),
          search({ top: true, createPanel: createEditorFindReplacePanel }),
        ],
      }),
    })

    openFindInEditorView(view)
    expect(getSearchQuery(view.state).search).toBe('alpha')

    view.dispatch({ selection: EditorSelection.range(6, 10) })
    openFindInEditorView(view)
    expect(getSearchQuery(view.state).search).toBe('beta')
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[main-field]')?.value).toBe('beta')
    )
  })
})
