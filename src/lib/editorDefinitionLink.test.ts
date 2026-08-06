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

  it('uses the held Control key when WebView2 omits ctrlKey from mousedown', () => {
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
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Control',
        ctrlKey: true,
      })
    )
    view.contentDOM.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      })
    )

    expect(navigate).toHaveBeenCalledOnce()
  })

  it('tracks Control on window when packaged WebView2 never delivers keydown to the editor', () => {
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

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Control',
        ctrlKey: true,
      })
    )
    view.contentDOM.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      })
    )

    expect(navigate).toHaveBeenCalledOnce()
  })

  it('keeps Ctrl-hover state for a mousedown that drops ctrlKey', () => {
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
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 10,
        clientY: 10,
        ctrlKey: true,
      })
    )
    expect(view.dom.querySelector('.cm-definition-link')).not.toBeNull()

    view.contentDOM.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      })
    )

    expect(navigate).toHaveBeenCalledOnce()
  })

  it('uses the native modifier state when packaged WebView2 drops all Ctrl events', async () => {
    const navigate = vi.fn()
    const nativeModifierPressed = vi.fn().mockResolvedValue(true)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'target()',
        extensions: [editorDefinitionLink({ navigate, nativeModifierPressed })],
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
      })
    )

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    expect(nativeModifierPressed).toHaveBeenCalledOnce()
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
