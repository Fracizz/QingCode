import { describe, expect, it } from 'vitest'
import { applyUnifiedDiff, diffStat, parseUnifiedDiff } from './diffModel'

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' const first = 1',
  '-const old = 2',
  '+const fresh = 2',
  '+const extra = 3',
  ' const last = 4',
  '\\ No newline at end of file',
  '@@ -10,2 +11,2 @@',
  ' context',
  '-gone',
  '+added',
  '',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('文件头不带行号，增删上下文按 hunk 推进', () => {
    const rows = parseUnifiedDiff(SAMPLE)
    expect(rows.slice(0, 4).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ['meta', null, null],
      ['meta', null, null],
      ['meta', null, null],
      ['meta', null, null],
    ])
    expect(rows.slice(4, 9).map((row) => [row.kind, row.text, row.oldLine, row.newLine])).toEqual([
      ['context', ' const first = 1', 1, 1],
      ['remove', '-const old = 2', 2, null],
      ['add', '+const fresh = 2', null, 2],
      ['add', '+const extra = 3', null, 3],
      ['context', ' const last = 4', 3, 4],
    ])
  })

  it('无换行标记不占用行号', () => {
    const rows = parseUnifiedDiff(SAMPLE)
    expect(rows[9]).toMatchObject({ kind: 'context', text: '\\ No newline at end of file', oldLine: null, newLine: null })
  })

  it('第二个 hunk 从新起点继续', () => {
    const rows = parseUnifiedDiff(SAMPLE)
    expect(rows.slice(10, 13).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ['meta', null, null],
      ['context', 10, 11],
      ['remove', 11, null],
    ])
    expect(rows[13]).toMatchObject({ kind: 'add', oldLine: null, newLine: 12 })
  })

  it('空 diff 与 CRLF', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('@@ -3 +5 @@\r\n-a\r\n+b\r\n')).toMatchObject([
      { kind: 'meta', oldLine: null, newLine: null },
      { kind: 'remove', oldLine: 3, newLine: null },
      { kind: 'add', oldLine: null, newLine: 5 },
    ])
  })
})

describe('diffStat', () => {
  it('只数增删行，忽略 --- / +++ 文件头', () => {
    expect(diffStat(SAMPLE)).toEqual({ add: 3, remove: 2 })
    expect(diffStat('')).toEqual({ add: 0, remove: 0 })
  })
})

describe('applyUnifiedDiff', () => {
  const original = ['first', 'old', 'last', 'd', 'e', 'f', 'g', 'h', 'i', 'context', 'gone', 'z'].join('\n')
  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' first',
    '-old',
    '+fresh',
    '+extra',
    ' last',
    '@@ -10,2 +11,2 @@',
    ' context',
    '-gone',
    '+added',
    '',
  ].join('\n')

  it('按 hunk 还原新版本：上下文取原文、删除跳过、新增取 diff', () => {
    const result = applyUnifiedDiff(original, patch)
    expect(result.applied).toBe(true)
    expect(result.text.split('\n')).toEqual([
      'first', 'fresh', 'extra', 'last', 'd', 'e', 'f', 'g', 'h', 'i', 'context', 'added', 'z',
    ])
  })

  it('空 diff 保持原文；CRLF 原文归一为 \n', () => {
    expect(applyUnifiedDiff(original, '')).toEqual({ text: original, applied: true })
    expect(applyUnifiedDiff('a\r\nb\r\n', '').text).toBe('a\nb\n')
  })

  it('新文件（oldStart=0）与 \\ No newline 标记', () => {
    const result = applyUnifiedDiff('', [
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '\\ No newline at end of file',
    ].join('\n'))
    expect(result).toEqual({ text: 'one\ntwo', applied: true })
  })

  it('hunk 行号与原文不匹配时标记 applied:false', () => {
    const result = applyUnifiedDiff('a\nb\n', '@@ -8 +8 @@\n x\n-y\n+z\n')
    expect(result.applied).toBe(false)
  })
})
