import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 手机端纯 JS 模块，无类型声明
import { localizeReleaseNotes as localizeMobile } from '../../mobile/android/web/appUpdate.js'
import { localizeReleaseNotes } from './releaseNotes'

const bilingual = readFileSync(new URL('../../docs/release-notes/v0.1.19.md', import.meta.url), 'utf8')

describe.each([
  ['desktop', localizeReleaseNotes],
  ['mobile', localizeMobile as (body: string, language: string) => string],
])('localizeReleaseNotes (%s)', (_name, localize) => {
  it('keeps only the Chinese section for Chinese UI', () => {
    for (const language of ['zh-CN', 'zh', 'zh-TW']) {
      const notes = localize(bilingual, language)
      expect(notes.startsWith('## QingCode v0.1.19\n\nv0.1.17 之后的稳定版')).toBe(true)
      expect(notes).toContain('#### 下载')
      expect(notes).not.toContain('Language / 语言')
      expect(notes).not.toContain('The stable release after')
      expect(notes).not.toMatch(/<a\s+id=/)
      expect(notes.trimEnd().endsWith('releases')).toBe(true)
    }
  })

  it('keeps only the English section for other languages', () => {
    for (const language of ['en', 'ja', '']) {
      const notes = localize(bilingual, language)
      expect(notes.startsWith('## QingCode v0.1.19\n\nThe stable release after')).toBe(true)
      expect(notes).toContain('#### Downloads')
      expect(notes).not.toContain('### 中文')
      expect(notes).not.toContain('v0.1.17 之后的稳定版')
      expect(notes).not.toMatch(/\n---\s*$/)
    }
  })

  it('returns non-bilingual notes unchanged', () => {
    expect(localize('只有中文\n\n- 修复', 'en')).toBe('只有中文\n\n- 修复')
    expect(localize('### English\n\nonly english', 'zh-CN')).toBe('### English\n\nonly english')
  })
})
