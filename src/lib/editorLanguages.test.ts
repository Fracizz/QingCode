import { describe, expect, it } from 'vitest'
import {
  isSupportedEditorLanguage,
  languageSupportForId,
  loadLanguageSupport,
} from './editorLanguages'

describe('editorLanguages', () => {
  it('recognizes supported language ids', () => {
    expect(isSupportedEditorLanguage('typescript')).toBe(true)
    expect(isSupportedEditorLanguage('python')).toBe(true)
    expect(isSupportedEditorLanguage('markdown')).toBe(true)
    expect(isSupportedEditorLanguage('java')).toBe(true)
    expect(isSupportedEditorLanguage('yaml')).toBe(true)
    expect(isSupportedEditorLanguage('toml')).toBe(true)
    expect(isSupportedEditorLanguage('shell')).toBe(true)
    expect(isSupportedEditorLanguage('rust')).toBe(true)
    expect(isSupportedEditorLanguage('go')).toBe(true)
    expect(isSupportedEditorLanguage('plain')).toBe(false)
    expect(isSupportedEditorLanguage('xml')).toBe(false)
  })

  it('exposes no synchronous highlighter (all packs are lazy)', () => {
    expect(languageSupportForId('typescript')).toEqual([])
    expect(languageSupportForId('java')).toEqual([])
  })

  it('lazy-loads language packs', async () => {
    for (const id of [
      'typescript',
      'python',
      'markdown',
      'json',
      'css',
      'html',
      'java',
      'yaml',
      'toml',
      'shell',
      'rust',
      'go',
    ] as const) {
      const ext = await loadLanguageSupport(id)
      expect(ext, id).not.toEqual([])
    }
  })
})
