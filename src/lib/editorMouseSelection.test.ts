import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  reliableClickType,
  selectionForClickType,
  selectionGroupAt,
} from './editorMouseSelection'

function mouseEvent(x: number, y: number, detail = 1): MouseEvent {
  return { clientX: x, clientY: y, detail } as MouseEvent
}

describe('editorMouseSelection', () => {
  it('counts rapid clicks at the same spot', () => {
    expect(reliableClickType(mouseEvent(10, 20))).toBe(1)
    expect(reliableClickType(mouseEvent(10, 20))).toBe(2)
    expect(reliableClickType(mouseEvent(10, 20))).toBe(3)
    expect(reliableClickType(mouseEvent(10, 20))).toBe(1)
  })

  it('selects a character group on double-click positions', () => {
    const state = EditorState.create({ doc: '"assembleload.dayhoursquota"' })
    const pos = state.doc.toString().indexOf('assembleload') + 4
    const range = selectionGroupAt(state, pos, 1)
    expect(state.sliceDoc(range.from, range.to)).toBe('assembleload')
  })

  it('maps click types to cursor, word, and line selections', () => {
    const state = EditorState.create({ doc: 'alpha\nbeta gamma' })
    const wordPos = state.doc.toString().indexOf('beta') + 1
    expect(selectionForClickType(state, wordPos, 1, 1).empty).toBe(true)
    const word = selectionForClickType(state, wordPos, 1, 2)
    expect(state.sliceDoc(word.from, word.to)).toBe('beta')
    const line = selectionForClickType(state, wordPos, 1, 3)
    expect(state.sliceDoc(line.from, line.to)).toBe('beta gamma')
  })
})
