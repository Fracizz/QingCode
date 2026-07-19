import { describe, expect, it } from 'vitest'
import { resolveUserEditorFontSize } from './editorSettings'

describe('resolveUserEditorFontSize', () => {
  it('reads from global settings', () => {
    expect(resolveUserEditorFontSize(18)).toBe(18)
  })

  it('ignores workspace-style defaults when pending is set', () => {
    expect(resolveUserEditorFontSize(14, 20)).toBe(20)
  })

  it('clamps invalid values', () => {
    expect(resolveUserEditorFontSize('nope', null, 14)).toBe(14)
    expect(resolveUserEditorFontSize(99)).toBe(48)
    expect(resolveUserEditorFontSize(2)).toBe(8)
  })
})
