import { describe, expect, it } from 'vitest'
import { filterCommands, fuzzyScore, type AppCommand } from './commands'

describe('fuzzyScore', () => {
  it('scores empty query as match-all', () => {
    expect(fuzzyScore('', '格式化文档')).toBe(1)
    expect(fuzzyScore('  ', 'Format')).toBe(1)
  })

  it('prefers exact and prefix matches', () => {
    expect(fuzzyScore('format', 'format')).toBeGreaterThan(fuzzyScore('format', 'reformat'))
    expect(fuzzyScore('格式', '格式化文档')).toBeGreaterThan(fuzzyScore('格式', '文档格式化'))
  })

  it('matches subsequences', () => {
    expect(fuzzyScore('fmd', 'format document')).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'format document')).toBe(0)
  })
})

describe('filterCommands', () => {
  const commands: AppCommand[] = [
    { id: 'a', title: '格式化文档', keywords: 'format prettier', run: () => {} },
    { id: 'b', title: '打开设置', keywords: 'settings', run: () => {} },
    { id: 'c', title: '切换终端', keywords: 'terminal', when: () => false, run: () => {} },
  ]

  it('filters by title and keywords', () => {
    const hits = filterCommands(commands, 'format', key => key)
    expect(hits.map(c => c.id)).toEqual(['a'])
  })

  it('respects when()', () => {
    const hits = filterCommands(commands, '', key => key)
    expect(hits.map(c => c.id).sort()).toEqual(['a', 'b'])
  })

  it('uses translator for display matching', () => {
    const hits = filterCommands(commands, 'settings', (key, values) => {
      void values
      if (key === '打开设置') return 'Open Settings'
      return key
    })
    expect(hits.map(c => c.id)).toEqual(['b'])
  })
})
