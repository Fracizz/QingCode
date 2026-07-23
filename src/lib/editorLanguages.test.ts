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
    expect(isSupportedEditorLanguage('yaml')).toBe(true)
    expect(isSupportedEditorLanguage('toml')).toBe(true)
    expect(isSupportedEditorLanguage('shell')).toBe(true)
    expect(isSupportedEditorLanguage('rust')).toBe(true)
    expect(isSupportedEditorLanguage('go')).toBe(true)
    expect(isSupportedEditorLanguage('plain')).toBe(false)
    expect(isSupportedEditorLanguage('xml')).toBe(false)
  })

  it('loads bundled highlighters synchronously', () => {
    expect(languageSupportForId('typescript')).not.toEqual([])
    expect(languageSupportForId('java')).toEqual([])
    expect(languageSupportForId('yaml')).toEqual([])
  })

  it('lazy-loads Java and config/native language packs', async () => {
    for (const id of ['java', 'yaml', 'toml', 'shell', 'rust', 'go'] as const) {
      const ext = await loadLanguageSupport(id)
      expect(ext, id).not.toEqual([])
    }
  })
})
