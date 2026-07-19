import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import {
  classifyLineFallback,
  collectQuickViewLines,
  colorForLineKind,
  resolveLineCharColors,
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
    const colors = resolveLineCharColors(state, 0, 'const x = 1', palette, palette.code)
    expect(colors).toHaveLength(11)
    expect(colors.every(color => typeof color === 'string' && color.length > 0)).toBe(true)
  })
})
