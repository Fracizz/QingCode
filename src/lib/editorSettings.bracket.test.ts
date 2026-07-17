import { describe, expect, it } from 'vitest'
import { readEditorPreferences } from './editorSettings'
import { DEFAULT_GLOBAL_SETTINGS } from './projectSettings'

describe('readEditorPreferences bracket / paste flags', () => {
  it('defaults bracket features on and formatOnPaste off', () => {
    const prefs = readEditorPreferences(DEFAULT_GLOBAL_SETTINGS)
    expect(prefs.formatOnPaste).toBe(false)
    expect(prefs.bracketPairColorization).toBe(true)
    expect(prefs.bracketPairGuides).toBe(true)
    expect(prefs.encoding).toBe('utf8')
  })

  it('reads VS Code-style keys', () => {
    const prefs = readEditorPreferences({
      ...DEFAULT_GLOBAL_SETTINGS,
      'editor.formatOnPaste': true,
      'editor.bracketPairColorization.enabled': false,
      'editor.guides.bracketPairs': false,
      'files.encoding': 'gbk',
    })
    expect(prefs.formatOnPaste).toBe(true)
    expect(prefs.bracketPairColorization).toBe(false)
    expect(prefs.bracketPairGuides).toBe(false)
    expect(prefs.encoding).toBe('gbk')
  })
})
