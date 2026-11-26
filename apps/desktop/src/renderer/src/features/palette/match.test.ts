import { describe, expect, it } from 'vitest'
import { fuzzyMatch, matchCommandText, splitHighlight } from './match'

describe('fuzzyMatch', () => {
  it('连续子串优先，且不区分大小写', () => {
    const hit = fuzzyMatch('Toggle Sidebar', 'side')
    expect(hit?.positions).toEqual([7, 8, 9, 10])
    expect(hit!.score).toBeGreaterThan(fuzzyMatch('Toggle Sidebar', 'tsb')!.score)
  })

  it('子串有多处时优先取词首', () => {
    expect(fuzzyMatch('digit git', 'git')?.positions).toEqual([6, 7, 8])
  })

  it('子序列匹配，取最优起点', () => {
    const hit = fuzzyMatch('open settings', 'ost')
    expect(hit).not.toBeNull()
    expect(hit!.positions).toHaveLength(3)
    expect(hit!.positions[0]).toBe(0)
  })

  it('中文标题按字匹配', () => {
    expect(fuzzyMatch('切换资源管理器', '资源')?.positions).toEqual([2, 3])
    expect(fuzzyMatch('切换资源管理器', '切管')?.positions).toEqual([0, 4])
  })

  it('匹配不到返回 null，空查询返回空命中', () => {
    expect(fuzzyMatch('打开设置', 'xyz')).toBeNull()
    expect(fuzzyMatch('打开设置', '')).toEqual({ score: 0, positions: [] })
  })

  it('开头匹配得分高于中间匹配', () => {
    expect(fuzzyMatch('git push', 'git')!.score).toBeGreaterThan(fuzzyMatch('open git', 'git')!.score)
  })
})

describe('matchCommandText', () => {
  const command = { title: '切换资源管理器', category: '视图', keywords: ['explorer', 'files'] }

  it('标题命中给出标题高亮', () => {
    expect(matchCommandText(command, '资源')).toMatchObject({ titlePositions: [2, 3], categoryPositions: [] })
  })

  it('分类与关键字也能命中，关键字不产生高亮', () => {
    expect(matchCommandText(command, '视图')).toMatchObject({ titlePositions: [], categoryPositions: [0, 1] })
    expect(matchCommandText(command, 'explorer')).toMatchObject({ titlePositions: [], categoryPositions: [] })
  })

  it('多个词需全部命中', () => {
    expect(matchCommandText(command, '视图 资源')).toMatchObject({ titlePositions: [2, 3], categoryPositions: [0, 1] })
    expect(matchCommandText(command, '视图 git')).toBeNull()
  })

  it('标题命中得分高于仅关键字命中', () => {
    const a = matchCommandText({ title: 'Git 提交' }, 'git')!
    const b = matchCommandText({ title: '切换源代码管理', keywords: ['git'] }, 'git')!
    expect(a.score).toBeGreaterThan(b.score)
  })
})

describe('splitHighlight', () => {
  it('合并相邻命中字符', () => {
    expect(splitHighlight('abcdef', [1, 2, 4])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'd', hit: false },
      { text: 'e', hit: true },
      { text: 'f', hit: false },
    ])
  })

  it('无命中时整段返回，空串返回空数组', () => {
    expect(splitHighlight('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(splitHighlight('', [])).toEqual([])
  })
})
