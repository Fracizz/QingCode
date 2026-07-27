// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  editorRevealPos,
  flashField,
  isEditorPositionVisible,
  revealPosFromLineColumn,
} from './editorViewHelpers'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.replaceChildren()
})

describe('revealPosFromLineColumn', () => {
  it('maps line/column and document offsets', () => {
    const state = EditorState.create({ doc: 'alpha\nbeta\ngamma' })
    expect(revealPosFromLineColumn(state, 2, 3)).toEqual({ pos: 8, lineNum: 2 })
    expect(revealPosFromLineColumn(state, 2, undefined, 9)).toEqual({ pos: 9, lineNum: 2 })
  })
})

describe('editorRevealPos', () => {
  it('skips scrollIntoView when the target is already visible', () => {
    const parent = document.createElement('div')
    parent.style.height = '120px'
    parent.style.width = '320px'
    parent.style.overflow = 'hidden'
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'line one\nline two\nline three',
        extensions: [flashField],
      }),
    })
    const pos = view.state.doc.line(2).from
    vi.spyOn(view, 'dispatch')
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([{ from: 0, to: view.state.doc.length }])

    editorRevealPos(view, pos, 2)

    const transaction = vi.mocked(view.dispatch).mock.calls.at(-1)?.[0]
    expect(transaction?.effects?.length).toBe(1)
    expect(transaction?.selection).toEqual({ anchor: pos })
  })

  it('scrolls when the target is outside the visible range', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'line one\nline two\nline three',
        extensions: [flashField],
      }),
    })
    const pos = view.state.doc.line(3).from
    vi.spyOn(view, 'dispatch')
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([{ from: 0, to: view.state.doc.line(1).to }])

    editorRevealPos(view, pos, 3)

    const transaction = vi.mocked(view.dispatch).mock.calls.at(-1)?.[0]
    expect(transaction?.effects?.length).toBe(2)
  })
})

describe('isEditorPositionVisible', () => {
  it('checks visibleRanges membership', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'alpha\nbeta' }),
    })
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([{ from: 0, to: 4 }])
    expect(isEditorPositionVisible(view, 2)).toBe(true)
    expect(isEditorPositionVisible(view, 8)).toBe(false)
  })
})
