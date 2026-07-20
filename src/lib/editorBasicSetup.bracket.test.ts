import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { json } from '@codemirror/lang-json'
import type { MatchResult } from '@codemirror/language'
import {
  CURSOR_BRACKET_CLASS,
  cursorBracketDecorations,
  cursorBracketHighlightMarker,
  cursorSideBracketRange,
  editorHasCursorBracketHighlight,
} from './editorBasicSetup'

describe('cursorSideBracketRange', () => {
  it('collapses a multi-char match.start down to the brace beside the caret', () => {
    const doc = '{ "a": 1 }'
    const open = 0
    const close = doc.length - 1
    const state = EditorState.create({ doc })
    const match: MatchResult = {
      start: { from: open, to: close + 1 },
      end: { from: close, to: close + 1 },
      matched: true,
    }
    expect(match.start.to - match.start.from).toBeGreaterThan(1)

    const side = cursorSideBracketRange(state, match, open)
    expect(side).toEqual({ from: open, to: open + 1 })
    expect(state.sliceDoc(side!.from, side!.to)).toBe('{')

    const closeSide = cursorSideBracketRange(state, match, close)
    expect(closeSide).toEqual({ from: close, to: close + 1 })
    expect(state.sliceDoc(closeSide!.from, closeSide!.to)).toBe('}')
  })
})

describe('cursorBracketDecorations', () => {
  it('lights both ends of a matched pair', () => {
    const doc = '{\n  "x": 1\n}'
    const open = 0
    const close = doc.length - 1
    const state = EditorState.create({
      doc,
      selection: { anchor: open },
      extensions: [json()],
    })
    const set = cursorBracketDecorations(state)
    const ranges: { from: number; to: number; text: string; cls: string }[] = []
    const iter = set.iter()
    while (iter.value) {
      ranges.push({
        from: iter.from,
        to: iter.to,
        text: state.sliceDoc(iter.from, iter.to),
        cls: iter.value.spec.class as string,
      })
      iter.next()
    }
    expect(ranges).toEqual([
      { from: open, to: open + 1, text: '{', cls: CURSOR_BRACKET_CLASS },
      { from: close, to: close + 1, text: '}', cls: CURSOR_BRACKET_CLASS },
    ])
  })

  it('lights both braces when caret is on the closing brace', () => {
    const doc = `{
  "configs": [
    {
      "id": "default",
      "tasks": [1]
    }
  ]
}`
    const firstObjOpen = doc.indexOf('{', doc.indexOf('['))
    let depth = 0
    let firstObjClose = -1
    for (let i = firstObjOpen; i < doc.length; i++) {
      if (doc[i] === '{') depth++
      else if (doc[i] === '}') {
        depth--
        if (depth === 0) {
          firstObjClose = i
          break
        }
      }
    }
    const state = EditorState.create({
      doc,
      selection: { anchor: firstObjClose },
      extensions: [json()],
    })
    const set = cursorBracketDecorations(state)
    const positions: number[] = []
    const iter = set.iter()
    while (iter.value) {
      positions.push(iter.from)
      iter.next()
    }
    expect(positions).toContain(firstObjOpen)
    expect(positions).toContain(firstObjClose)
  })

  it('lights both [ and ] for a JSON array', () => {
    const doc = '{\n  "tasks": [\n    1\n  ]\n}'
    const open = doc.indexOf('[')
    const close = doc.indexOf(']')
    const state = EditorState.create({
      doc,
      selection: { anchor: open + 1 },
      extensions: [json()],
    })
    const set = cursorBracketDecorations(state)
    const marked = new Map<number, string>()
    const iter = set.iter()
    while (iter.value) {
      marked.set(iter.from, state.sliceDoc(iter.from, iter.to))
      iter.next()
    }
    expect(marked.get(open)).toBe('[')
    expect(marked.get(close)).toBe(']')
  })
})

describe('qingBasicSetup cursor-bracket rev', () => {
  it('marks states built with current caret-bracket wiring', () => {
    const plain = EditorState.create({ doc: '{}' })
    expect(editorHasCursorBracketHighlight(plain)).toBe(false)
    const marked = EditorState.create({
      doc: '{}',
      extensions: [cursorBracketHighlightMarker()],
    })
    expect(editorHasCursorBracketHighlight(marked)).toBe(true)
  })
})
