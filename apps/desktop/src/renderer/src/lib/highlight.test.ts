import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_MAX_CHARS, langFromClassName, normalizeLang, shouldHighlight } from './highlight'

describe('normalizeLang', () => {
  it('别名映射到 shiki id', () => {
    expect(normalizeLang('ts')).toBe('typescript')
    expect(normalizeLang('SH')).toBe('bash')
    expect(normalizeLang('ps1')).toBe('powershell')
    expect(normalizeLang('yml')).toBe('yaml')
  })

  it('未知语言原样返回（小写）', () => {
    expect(normalizeLang('Zig')).toBe('zig')
  })

  it('纯文本类返回 null', () => {
    expect(normalizeLang('')).toBeNull()
    expect(normalizeLang('text')).toBeNull()
    expect(normalizeLang(undefined)).toBeNull()
  })
})

describe('langFromClassName', () => {
  it('解析 language-xxx', () => {
    expect(langFromClassName('language-tsx')).toBe('tsx')
    expect(langFromClassName('foo language-py bar')).toBe('python')
  })

  it('没有语言时返回 null', () => {
    expect(langFromClassName(undefined)).toBeNull()
    expect(langFromClassName('foo')).toBeNull()
  })
})

describe('shouldHighlight', () => {
  it('无语言或超长时不高亮', () => {
    expect(shouldHighlight('x', null)).toBe(false)
    expect(shouldHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS + 1), 'ts')).toBe(false)
    expect(shouldHighlight('const a = 1', 'typescript')).toBe(true)
  })
})
