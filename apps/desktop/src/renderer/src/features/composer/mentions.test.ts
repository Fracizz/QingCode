import { describe, expect, it } from 'vitest'
import { applyMention, formatMention, mentionToken, rankMentionCandidates, serverQuery } from './mentions'

describe('mentionToken', () => {
  it('行首或空白后的 @ 触发，返回查询与范围', () => {
    expect(mentionToken('@', 1)).toEqual({ query: '', start: 0, end: 1 })
    expect(mentionToken('看下 @src/ap', 10)).toEqual({ query: 'src/ap', start: 3, end: 10 })
    expect(mentionToken('第一行\n@a', 6)).toEqual({ query: 'a', start: 4, end: 6 })
  })

  it('邮箱、词中间、已加引号的引用不触发', () => {
    expect(mentionToken('mail a@b.com', 12)).toBeNull()
    expect(mentionToken('@abc', 2)).toBeNull()
    expect(mentionToken('@"a b.ts"', 9)).toBeNull()
    expect(mentionToken('没有 at', 5)).toBeNull()
  })

  it('光标后是空白时仍可触发', () => {
    expect(mentionToken('@ap 后面', 3)).toEqual({ query: 'ap', start: 0, end: 3 })
  })
})

describe('serverQuery', () => {
  it('只取最后一段文件名部分', () => {
    expect(serverQuery('src/comp')).toBe('comp')
    expect(serverQuery('src\\a.ts')).toBe('a.ts')
    expect(serverQuery('src/')).toBe('')
    expect(serverQuery('app')).toBe('app')
  })
})

describe('applyMention', () => {
  it('替换 @片段并补空格，光标落在空格后', () => {
    const value = '看下 @ap'
    const token = mentionToken(value, value.length)!
    expect(applyMention(value, token, 'src/app.ts')).toEqual({ value: '看下 @src/app.ts ', caret: 15 })
  })

  it('后面已有空白时不重复补空格，光标跳过该空白，避免菜单再次弹出', () => {
    const value = '@ap 然后'
    const token = mentionToken(value, 3)!
    const next = applyMention(value, token, 'src/app.ts')
    expect(next).toEqual({ value: '@src/app.ts 然后', caret: 12 })
    expect(mentionToken(next.value, next.caret)).toBeNull()
  })

  it('Windows 分隔符统一为 /，含空白的路径加引号', () => {
    expect(formatMention('src\\a.ts')).toBe('@src/a.ts')
    expect(formatMention('docs/my notes.md')).toBe('@"docs/my notes.md"')
  })
})

describe('rankMentionCandidates', () => {
  const root = '/work/proj'
  const matches = [
    { path: '/work/proj/src/components/AppShell.tsx' },
    { path: '/work/proj/src/app.ts' },
    { path: '/work/proj/test/app.test.ts' },
    { path: '/other/app.ts' },
    { path: '/work/proj/src/app.ts' },
  ]

  it('只保留根内文件、去重，文件名精确命中排前', () => {
    const ranked = rankMentionCandidates('app.ts', matches, root)
    // AppShell.tsx 也按字符顺序模糊命中，但连续度差，排最后；根外的 /other/app.ts 被排除。
    expect(ranked.map((item) => item.relative)).toEqual(['src/app.ts', 'test/app.test.ts', 'src/components/AppShell.tsx'])
    expect(ranked[0]).toMatchObject({ path: '/work/proj/src/app.ts', name: 'app.ts' })
  })

  it('带目录的查询按相对路径模糊过滤', () => {
    const ranked = rankMentionCandidates('test/app', matches, root)
    expect(ranked.map((item) => item.relative)).toEqual(['test/app.test.ts'])
  })

  it('Windows 根路径转成 / 分隔的相对路径', () => {
    const ranked = rankMentionCandidates('a', [{ path: 'D:\\code\\proj\\src\\a.ts' }], 'D:\\code\\proj')
    expect(ranked[0]?.relative).toBe('src/a.ts')
  })

  it('截断到 limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `/work/proj/f${i}.ts` }))
    expect(rankMentionCandidates('f', many, root, 3)).toHaveLength(3)
  })
})
