// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorDefinitionLink } from './editorDefinitionLink'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.replaceChildren()
})

describe('editorDefinitionLink', () => {
  it('hides the Ctrl-hover link but still reports an explicit Ctrl+click when disabled', () => {
    const navigate = vi.fn()
    const preview = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'target()',
        extensions: [
          editorDefinitionLink({
            linkEnabled: () => false,
            navigate,
            preview,
          }),
        ],
      }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2)

    view.contentDOM.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 10,
        clientY: 10,
        ctrlKey: true,
      })
    )

    expect(view.dom.querySelector('.cm-definition-link')).toBeNull()
    expect(preview).not.toHaveBeenCalled()

    view.contentDOM.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        ctrlKey: true,
      })
    )

    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate.mock.calls[0]?.[1]).toMatchObject({ name: 'target' })
  })
})
