import { describe, expect, it } from 'vitest'
import { classifyDiffLine, diffRows, isAtBottom, lineCount, tailLines } from './diff'

describe('输出与 diff 展示', () => {
  it('只保留末尾 N 行并兼容 CRLF', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc')
    expect(tailLines('a\r\nb\r\n', 2)).toBe('a\nb')
    expect(tailLines('', 2)).toBe('')
    expect(tailLines('a\nb', 0)).toBe('a\nb')
    expect(lineCount('a\nb\n')).toBe(2)
  })

  it('区分 diff 头信息、增删行和上下文', () => {
    expect(classifyDiffLine('+++ b/a.txt')).toBe('meta')
    expect(classifyDiffLine('--- a/a.txt')).toBe('meta')
    expect(classifyDiffLine('@@ -1,2 +1,3 @@')).toBe('meta')
    expect(classifyDiffLine('+新增')).toBe('add')
    expect(classifyDiffLine('-删除')).toBe('remove')
    expect(classifyDiffLine(' 上下文')).toBe('context')
    expect(diffRows('--- a/x\n+hi\n')).toEqual([
      { text: '--- a/x', kind: 'meta' },
      { text: '+hi', kind: 'add' },
    ])
    expect(diffRows('')).toEqual([])
  })

  it('判断滚动是否贴近底部', () => {
    expect(isAtBottom(952, 1000, 100)).toBe(true)
    expect(isAtBottom(900, 1000, 100)).toBe(true)
    expect(isAtBottom(500, 1000, 100)).toBe(false)
    expect(isAtBottom(0, 100, 100, 0)).toBe(true)
  })
})
