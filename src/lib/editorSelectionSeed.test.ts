import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { editorSelectionSeed } from './editorSelectionSeed'

describe('editorSelectionSeed', () => {
  it('returns the trimmed primary selection', () => {
    const state = EditorState.create({
      doc: 'before  selectedName  after',
      selection: EditorSelection.range(6, 22),
    })

    expect(editorSelectionSeed(state)).toBe('selectedName')
  })

  it('ignores empty, multiline, and oversized selections when requested', () => {
    const empty = EditorState.create({ doc: 'name', selection: { anchor: 2 } })
    expect(editorSelectionSeed(empty)).toBe('')

    const multiline = EditorState.create({
      doc: 'first\nsecond',
      selection: EditorSelection.range(0, 12),
    })
    expect(editorSelectionSeed(multiline, { singleLine: true })).toBe('')
    expect(editorSelectionSeed(multiline)).toBe('first\nsecond')

    const oversized = EditorState.create({
      doc: 'abcdef',
      selection: EditorSelection.range(0, 6),
    })
    expect(editorSelectionSeed(oversized, { maxLength: 5 })).toBe('')
  })
})
