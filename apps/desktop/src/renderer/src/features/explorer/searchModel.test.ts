import { describe, expect, it } from 'vitest'
import type { FsSearchMatch } from '@qn/protocol'
import {
  fuzzyIndices,
  groupContentMatches,
  highlightParts,
  rankNameHits,
  scoreNameHit,
} from './searchModel'

describe('模糊排序', () => {
  it('按顺序匹配字符，大小写默认不敏感', () => {
    expect(fuzzyIndices('abc', 'xxaXbXc.ts')).toEqual([2, 4, 6])
    expect(fuzzyIndices('abc', 'ABC.ts')).toEqual([0, 1, 2])
    expect(fuzzyIndices('ABC', 'abc.ts', true)).toBe(null)
    expect(fuzzyIndices('z', 'abc')).toBe(null)
    expect(fuzzyIndices('', 'abc')).toEqual([])
  })

  it('文件名命中优先于仅路径命中', () => {
    const hits = [
      { path: '/repo/readme/notes.md' },
      { path: '/repo/src/readme.ts' },
      { path: '/repo/src/abc.ts' },
    ]
    const ranked = rankNameHits('readme', hits)
    expect(ranked.map((item) => item.path)).toEqual([
      '/repo/src/readme.ts',
      '/repo/readme/notes.md',
    ])
    expect(scoreNameHit('readme', '/repo/src/abc.ts')).toBe(null)
  })

  it('连续命中优先于分散命中', () => {
    const ranked = rankNameHits('abc', [
      { path: '/repo/aXbXc.ts' },
      { path: '/repo/abc.ts' },
      { path: '/repo/xxabc.ts' },
    ])
    expect(ranked[0]?.path).toBe('/repo/abc.ts')
    expect(ranked[1]?.path).toBe('/repo/xxabc.ts')
    expect(ranked[2]?.path).toBe('/repo/aXbXc.ts')
  })

  it('分数相同时路径短的靠前，且限制返回条数', () => {
    const ranked = rankNameHits(
      'ab',
      [
        { path: '/repo/very/long/nested/path/ab.ts' },
        { path: '/repo/ab.ts' },
        { path: '/repo/x/ab.ts' },
      ],
      false,
      2,
    )
    expect(ranked.map((item) => item.path)).toEqual(['/repo/ab.ts', '/repo/x/ab.ts'])
  })

  it('区分大小写开关生效；空查询保留原始顺序', () => {
    const hits = [{ path: '/repo/ABC.ts' }, { path: '/repo/abc.ts' }]
    expect(rankNameHits('ABC', hits, true).map((item) => item.path)).toEqual(['/repo/ABC.ts'])
    expect(rankNameHits('ABC', hits, false)).toHaveLength(2)
    expect(rankNameHits('', hits).map((item) => item.path)).toEqual([
      '/repo/ABC.ts',
      '/repo/abc.ts',
    ])
  })
})

describe('命中高亮与结果分组', () => {
  it('把一行文本切成命中/未命中片段', () => {
    expect(highlightParts('ab AB ab', 'ab')).toEqual([
      { text: 'ab', hit: true },
      { text: ' ', hit: false },
      { text: 'AB', hit: true },
      { text: ' ', hit: false },
      { text: 'ab', hit: true },
    ])
    expect(highlightParts('ab AB', 'ab', true)).toEqual([
      { text: 'ab', hit: true },
      { text: ' AB', hit: false },
    ])
    expect(highlightParts('plain', '')).toEqual([{ text: 'plain', hit: false }])
  })

  it('内容结果按文件分组并按行列排序', () => {
    const matches: FsSearchMatch[] = [
      { path: '/repo/b.ts', line: 12, column: 3, text: 'hit b' },
      { path: '/repo/a.ts', line: 9, text: 'hit a2' },
      { path: '/repo/a.ts', line: 2, text: 'hit a1' },
      { path: '/repo/b.ts', line: 1, column: 1, text: 'hit b0' },
    ]
    expect(groupContentMatches(matches)).toEqual([
      {
        path: '/repo/a.ts',
        hits: [
          { path: '/repo/a.ts', line: 2, text: 'hit a1' },
          { path: '/repo/a.ts', line: 9, text: 'hit a2' },
        ],
      },
      {
        path: '/repo/b.ts',
        hits: [
          { path: '/repo/b.ts', line: 1, column: 1, text: 'hit b0' },
          { path: '/repo/b.ts', line: 12, column: 3, text: 'hit b' },
        ],
      },
    ])
    expect(groupContentMatches([])).toEqual([])
  })
})
