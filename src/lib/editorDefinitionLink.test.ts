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
  it('does not navigate on Ctrl-hover and navigates on Ctrl+left mousedown', () => {
    const navigate = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'target()',
        extensions: [
          editorDefinitionLink({
            navigate,
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

    expect(view.dom.querySelector('.cm-definition-link')).not.toBeNull()
    expect(navigate).not.toHaveBeenCalled()

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

  it('does not navigate twice when WebView2 emits click after the handled mousedown', () => {
    const navigate = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'target()',
        extensions: [editorDefinitionLink({ navigate })],
      }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2)

    for (const type of ['mousedown', 'click']) {
      view.contentDOM.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 10,
          clientY: 10,
          ctrlKey: true,
        })
      )
    }

    expect(navigate).toHaveBeenCalledOnce()
  })

  it('uses Ctrl+click as a fallback when mousedown was not delivered', () => {
    const navigate = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'target()',
        extensions: [editorDefinitionLink({ navigate })],
      }),
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2)

    view.contentDOM.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        ctrlKey: true,
      })
    )

    expect(navigate).toHaveBeenCalledOnce()
  })

  it('hides the Ctrl-hover link but still reports an explicit Ctrl+mousedown when disabled', () => {
    const navigate = vi.fn()
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
  })
})
