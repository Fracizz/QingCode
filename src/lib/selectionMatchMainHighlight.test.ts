import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  collectOtherSelectionMatchRanges,
  editorHasOccurrenceHighlight,
  mainSelectionMatchRange,
  occurrenceHighlightMarker,
  shouldDecorateMainSelectionMatch,
} from './selectionMatchMainHighlight'

describe('selectionMatchMainHighlight', () => {
  it('marks editor states that include occurrence highlighting', () => {
    const plain = EditorState.create({ doc: 'x' })
    expect(editorHasOccurrenceHighlight(plain)).toBe(false)
    const marked = EditorState.create({
      doc: 'x',
      extensions: [occurrenceHighlightMarker()],
    })
    expect(editorHasOccurrenceHighlight(marked)).toBe(true)
  })

  it('decorates a non-empty single selection within length bounds', () => {
    const state = EditorState.create({
      doc: 'foo bar foo',
      selection: EditorSelection.single(0, 3),
    })
    expect(shouldDecorateMainSelectionMatch(state.selection)).toBe(true)
    expect(mainSelectionMatchRange(state)).toEqual(EditorSelection.single(0, 3).main)
  })

  it('skips empty, multi-range, and oversized selections', () => {
    const empty = EditorState.create({
      doc: 'alpha',
      selection: EditorSelection.cursor(2),
    })
    expect(mainSelectionMatchRange(empty)).toBeNull()

    const multi = EditorSelection.create([
      EditorSelection.range(0, 2),
      EditorSelection.range(8, 10),
    ])
    expect(shouldDecorateMainSelectionMatch(multi)).toBe(false)

    const long = EditorState.create({
      doc: 'x'.repeat(250),
      selection: EditorSelection.single(0, 201),
    })
    expect(mainSelectionMatchRange(long)).toBeNull()
  })

  it('keeps other matches when over the cap instead of clearing all', () => {
    const token = 'item'
    const doc = Array.from({ length: 120 }, () => token).join(' ')
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0, token.length),
    })
    const matches = collectOtherSelectionMatchRanges(state, 0, doc.length, {
      maxMatches: 40,
    })
    expect(matches.length).toBe(40)
    expect(matches[0]?.from).toBeGreaterThan(0)
  })
})
