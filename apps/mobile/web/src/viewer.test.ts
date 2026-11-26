import { describe, expect, it } from 'vitest'
import {
  appendRead,
  classifyDiffLine,
  diffRows,
  formatBytes,
  nextOffset,
  numberLines,
  parseFsRead,
  viewerError,
  viewKind,
} from './viewer'

describe('fs.read 结果', () => {
  it('按 FsReadResult 字段归一化，缺字段时推算', () => {
    const view = parseFsRead({ path: '/a.ts', content: 'abc', encoding: 'utf8', size: 10, offset: 0, length: 3, truncated: true, binary: false })
    expect(view).toMatchObject({ path: '/a.ts', size: 10, length: 3, truncated: true })
    expect(nextOffset(view!)).toBe(3)
    expect(parseFsRead({ content: 'xy', size: 5 }, '/b.ts')).toMatchObject({ path: '/b.ts', length: 2, truncated: true, encoding: 'utf8' })
    expect(parseFsRead({ path: '/c' })).toBeNull()
    expect(parseFsRead(null)).toBeNull()
  })

  it('续读拼接；偏移不连续时以新结果为准', () => {
    const first = parseFsRead({ path: '/a', content: 'abc', size: 6, offset: 0, length: 3, truncated: true })!
    const second = parseFsRead({ path: '/a', content: 'def', size: 6, offset: 3, length: 3, truncated: false })!
    expect(appendRead(first, second)).toMatchObject({ content: 'abcdef', length: 6, truncated: false, offset: 0 })
    const jump = parseFsRead({ path: '/a', content: 'zz', size: 9, offset: 7, length: 2, truncated: false })!
    expect(appendRead(first, jump)).toBe(jump)
  })

  it('按编码与二进制标记区分文本 / 图片 / 二进制', () => {
    expect(viewKind(parseFsRead({ path: '/a.png', content: 'AAAA', encoding: 'base64' })!)).toBe('image')
    expect(viewKind(parseFsRead({ path: '/a.bin', content: 'AAAA', encoding: 'base64' })!)).toBe('binary')
    expect(viewKind(parseFsRead({ path: '/a.exe', content: '', binary: true })!)).toBe('binary')
    expect(viewKind(parseFsRead({ path: '/a.ts', content: 'x' })!)).toBe('text')
  })

  it('带行号的文本，末尾换行不算一行', () => {
    expect(numberLines('a\r\nb\n')).toEqual([
      { no: 1, text: 'a' },
      { no: 2, text: 'b' },
    ])
    expect(numberLines('x', 10)).toEqual([{ no: 10, text: 'x' }])
    expect(numberLines('')).toEqual([])
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MiB')
  })
})

describe('统一 diff 着色', () => {
  it('分类增删行、hunk 与文件头', () => {
    expect(classifyDiffLine('+++ b/a')).toBe('meta')
    expect(classifyDiffLine('--- a/a')).toBe('meta')
    expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk')
    expect(classifyDiffLine('+x')).toBe('add')
    expect(classifyDiffLine('-x')).toBe('remove')
    expect(classifyDiffLine(' x')).toBe('context')
    expect(classifyDiffLine('\\ No newline at end of file')).toBe('meta')
  })

  it('按 hunk 头推算新旧行号，超过上限截断', () => {
    const text = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -10,3 +10,3 @@ fn', ' a', '-b', '+c', ' d', ''].join('\n')
    const { rows, truncated } = diffRows(text)
    expect(truncated).toBe(false)
    expect(rows.map((row) => row.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'context'])
    expect(rows[4]).toMatchObject({ oldNo: 10, newNo: 10 })
    expect(rows[5]).toMatchObject({ oldNo: 11 })
    expect(rows[6]).toMatchObject({ newNo: 11 })
    expect(rows[7]).toMatchObject({ oldNo: 12, newNo: 12 })
    expect(diffRows(text, 3)).toMatchObject({ truncated: true })
    expect(diffRows('  \n')).toEqual({ rows: [], truncated: false })
    // 没有 hunk 头的片段（如 Claude 生成的简化 diff）也能着色。
    expect(diffRows('+a\n-b').rows.map((row) => row.kind)).toEqual(['add', 'remove'])
  })

  it('错误码转成可读提示', () => {
    expect(viewerError({ code: 'not_found', message: 'x' }, '失败')).toBe('文件不存在或已被删除')
    expect(viewerError({ code: 'not_repo' }, '失败')).toBe('该目录不在 Git 仓库中')
    expect(viewerError({ code: 'forbidden' }, '失败')).toContain('版本过旧')
    expect(viewerError({ message: '其他错误' }, '失败')).toBe('其他错误')
    expect(viewerError(null, '失败')).toBe('失败')
  })
})
