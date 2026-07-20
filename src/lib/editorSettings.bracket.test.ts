import { describe, expect, it } from 'vitest'
import { readEditorPreferences } from './editorSettings'
import { DEFAULT_GLOBAL_SETTINGS } from './projectSettings'

describe('readEditorPreferences bracket / paste flags', () => {
  it('defaults bracket and indent guide features on and formatOnPaste off', () => {
    const prefs = readEditorPreferences(DEFAULT_GLOBAL_SETTINGS)
    expect(prefs.formatOnPaste).toBe(false)
    expect(prefs.bracketPairColorization).toBe(true)
    expect(prefs.bracketPairGuides).toBe(true)
    expect(prefs.indentationGuides).toBe(true)
    expect(prefs.encoding).toBe('auto')
  })

  it('reads VS Code-style keys', () => {
    const prefs = readEditorPreferences({
      ...DEFAULT_GLOBAL_SETTINGS,
      'editor.formatOnPaste': true,
      'editor.bracketPairColorization.enabled': false,
      'editor.guides.bracketPairs': false,
      'editor.guides.indentation': false,
      'files.encoding': 'gbk',
    })
    expect(prefs.formatOnPaste).toBe(true)
    expect(prefs.bracketPairColorization).toBe(false)
    expect(prefs.bracketPairGuides).toBe(false)
    expect(prefs.indentationGuides).toBe(false)
    expect(prefs.encoding).toBe('gbk')
  })

  it('accepts automatic file-encoding detection', () => {
    const prefs = readEditorPreferences({
      ...DEFAULT_GLOBAL_SETTINGS,
      'files.encoding': 'auto',
    })
    expect(prefs.encoding).toBe('auto')
  })
})
