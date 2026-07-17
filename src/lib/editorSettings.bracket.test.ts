import { describe, expect, it } from 'vitest'
import { readEditorPreferences } from './editorSettings'

describe('readEditorPreferences bracket / paste flags', () => {
  it('defaults bracket features on and formatOnPaste off', () => {
    const prefs = readEditorPreferences({})
    expect(prefs.formatOnPaste).toBe(false)
    expect(prefs.bracketPairColorization).toBe(true)
    expect(prefs.bracketPairGuides).toBe(true)
  })

  it('reads VS Code-style keys', () => {
    const prefs = readEditorPreferences({
      'editor.formatOnPaste': true,
      'editor.bracketPairColorization.enabled': false,
      'editor.guides.bracketPairs': false,
    })
    expect(prefs.formatOnPaste).toBe(true)
    expect(prefs.bracketPairColorization).toBe(false)
    expect(prefs.bracketPairGuides).toBe(false)
  })
})
