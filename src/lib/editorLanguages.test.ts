import { describe, expect, it } from 'vitest'
import {
  isSupportedEditorLanguage,
  languageSupportForId,
  loadLanguageSupport,
} from './editorLanguages'

describe('editorLanguages', () => {
  it('recognizes bundled and lazy language ids', () => {
    expect(isSupportedEditorLanguage('typescript')).toBe(true)
    expect(isSupportedEditorLanguage('java')).toBe(true)
    expect(isSupportedEditorLanguage('plain')).toBe(false)
    expect(isSupportedEditorLanguage('rust')).toBe(false)
  })

  it('loads bundled highlighters synchronously', () => {
    expect(languageSupportForId('typescript')).not.toEqual([])
    expect(languageSupportForId('java')).toEqual([])
  })

  it('lazy-loads Java support', async () => {
    const ext = await loadLanguageSupport('java')
    expect(ext).not.toEqual([])
  })
})
