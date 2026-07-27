// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { search, searchKeymap } from '@codemirror/search'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorFindReplacePanel } from './EditorFindReplacePanel'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.replaceChildren()
})

describe('EditorFindReplacePanel', () => {
  it('prefills Ctrl+F from the selected editor text', () => {
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

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'f',
        ctrlKey: true,
      })
    )

    expect(document.querySelector<HTMLInputElement>('[main-field]')?.value).toBe(
      'selectedName'
    )
  })
})
