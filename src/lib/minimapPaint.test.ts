import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import {
  classifyLineFallback,
  collectQuickViewLines,
  colorForLineKind,
  findMinimapSelectionMatchIndexes,
  normalizeMinimapLine,
  resolveLineCharColors,
  resolveMinimapSelectionMatchQuery,
  softenColor,
  syntaxHighlightAvailable,
  type MinimapPalette,
} from './minimapPaint'

const palette: MinimapPalette = {
  code: '#aaa',
  comment: '#666',
  string: '#8c8',
  keyword: '#48f',
  number: '#db7',
  type: '#ccc',
  function: '#48f',
  property: '#999',
  density: '#555',
  caret: '#48f',
  emptyLine: 'rgba(255,255,255,0.1)',
  selectionMatch: 'rgba(153, 255, 119, 0.2)',
  selectionMatchMain: 'rgba(153, 255, 119, 0.5)',
}

describe('minimapPaint', () => {
  it('classifies common line prefixes', () => {
    expect(classifyLineFallback('')).toBe('empty')
    expect(classifyLineFallback('  // note')).toBe('comment')
    expect(classifyLineFallback('# shell')).toBe('comment')
    expect(classifyLineFallback('"hello"')).toBe('string')
    expect(classifyLineFallback('function foo() {}')).toBe('keyword')
    expect(classifyLineFallback('  value = 1')).toBe('code')
  })

  it('maps line kinds to palette colors', () => {
    expect(colorForLineKind('comment', palette)).toBe(palette.comment)
    expect(colorForLineKind('string', palette)).toBe(palette.string)
    expect(colorForLineKind('keyword', palette)).toBe(palette.keyword)
    expect(colorForLineKind('empty', palette)).toBe('transparent')
    expect(colorForLineKind('code', palette)).toBe(palette.code)
  })

  it('collects a bounded quick-view window', () => {
    const doc = Text.of(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    const peek = collectQuickViewLines(doc, 4, 2)
    expect(peek.startLine).toBe(2)
    expect(peek.lines).toEqual(['b', 'c', 'd', 'e', 'f'])
  })

  it('returns a color per character for a line prefix', () => {
    const state = EditorState.create({ doc: 'const x = 1' })
    expect(syntaxHighlightAvailable(state)).toBe(false)
    const colors = resolveLineCharColors(state, 0, 'const x = 1', palette, palette.code)
    expect(colors).toHaveLength(11)
    expect(colors.every(color => color === palette.code)).toBe(true)
  })

  it('normalizes tabs for minimap display', () => {
    expect(normalizeMinimapLine('\tfoo')).toBe('  foo')
  })

  it('softens bright syntax colors toward the background', () => {
    expect(softenColor('rgb(255, 0, 0)', 'rgb(0, 0, 0)', 0.5)).toBe('rgb(128, 0, 0)')
  })

  it('resolves a single-line selection query for minimap matches', () => {
    const state = EditorState.create({ doc: 'foo path bar path' })
    const withSel = state.update({
      selection: { anchor: 4, head: 8 },
    }).state
    expect(resolveMinimapSelectionMatchQuery(withSel)).toBe('path')
    expect(resolveMinimapSelectionMatchQuery(state)).toBeNull()
  })

  it('finds capped non-overlapping match indexes on a line', () => {
    expect(findMinimapSelectionMatchIndexes('path path path', 'path', 20)).toEqual([0, 5, 10])
    // Cap 9 keeps "path path" so the second hit at index 5 is included.
    expect(findMinimapSelectionMatchIndexes('path path path', 'path', 9)).toEqual([0, 5])
  })
})
