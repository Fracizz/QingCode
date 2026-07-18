import { describe, expect, it } from 'vitest'
import {
  filterHelpSections,
  flattenText,
  helpHeadingId,
  isChineseHelpLanguage,
  joinHelpSections,
  splitHelpSections,
} from './helpDocument'

const SAMPLE = `# Title

Intro paragraph.

## First

Body of first.

### Nested

Still in first.

## Second

Second body.
`

describe('splitHelpSections', () => {
  it('splits preamble and ## sections without breaking ###', () => {
    const sections = splitHelpSections(SAMPLE)
    expect(sections).toHaveLength(3)
    expect(sections[0]).toMatchObject({ title: '' })
    expect(sections[0].markdown).toContain('# Title')
    expect(sections[0].markdown).toContain('Intro paragraph.')
    expect(sections[1]).toMatchObject({ title: 'First' })
    expect(sections[1].markdown).toContain('### Nested')
    expect(sections[1].markdown).toContain('Still in first.')
    expect(sections[2]).toMatchObject({ title: 'Second' })
  })

  it('returns empty for blank input', () => {
    expect(splitHelpSections('   \n  ')).toEqual([])
  })
})

describe('filterHelpSections', () => {
  it('returns all sections when query is empty', () => {
    const sections = splitHelpSections(SAMPLE)
    expect(filterHelpSections(sections, '  ')).toEqual(sections)
  })

  it('matches title or body case-insensitively', () => {
    const sections = splitHelpSections(SAMPLE)
    expect(filterHelpSections(sections, 'SECOND').map(s => s.title)).toEqual(['Second'])
    expect(filterHelpSections(sections, 'nested').map(s => s.title)).toEqual(['First'])
    expect(filterHelpSections(sections, 'intro').map(s => s.title)).toEqual([''])
  })
})

describe('joinHelpSections', () => {
  it('rejoins markdown with blank lines between sections', () => {
    const joined = joinHelpSections(splitHelpSections(SAMPLE))
    expect(joined).toContain('## First')
    expect(joined).toContain('## Second')
  })
})

describe('helpHeadingId', () => {
  it('matches help TOC slug style', () => {
    expect(helpHeadingId('快速开始')).toBe('快速开始')
    expect(helpHeadingId('Git 源代码管理')).toBe('git-源代码管理')
  })
})

describe('flattenText', () => {
  it('flattens nested children', () => {
    expect(flattenText(['a', { props: { children: ['b', 'c'] } }, 1])).toBe('abc1')
  })
})

describe('isChineseHelpLanguage', () => {
  it('treats zh-CN and zh-* as Chinese help', () => {
    expect(isChineseHelpLanguage('zh-CN')).toBe(true)
    expect(isChineseHelpLanguage('zh')).toBe(true)
    expect(isChineseHelpLanguage('zh-TW')).toBe(true)
  })

  it('uses English help for non-Chinese locales', () => {
    expect(isChineseHelpLanguage('en')).toBe(false)
    expect(isChineseHelpLanguage('ja')).toBe(false)
    expect(isChineseHelpLanguage('fr-FR')).toBe(false)
  })
})
