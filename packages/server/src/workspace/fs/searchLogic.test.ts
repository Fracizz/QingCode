import path from 'node:path'
import type { FsSearchResultEvt } from '@qn/protocol'
import { describe, expect, it } from 'vitest'
import {
  BATCH_MAX_MATCHES,
  SearchBatcher,
  cleanRelPath,
  parseRgMatch,
  shouldFlushBatch,
} from './searchLogic'

const matchLine = (data: Record<string, unknown>): string =>
  JSON.stringify({ type: 'match', data })

describe('rg --json 解析', () => {
  it('把相对路径补成绝对路径，带上行列与截断文本', () => {
    const line = matchLine({
      path: { text: 'src/a.ts' },
      lines: { text: 'hello world\n' },
      line_number: 7,
      submatches: [{ match: { text: 'hello' }, start: 4, end: 9 }],
    })
    expect(parseRgMatch(line, '/work')).toEqual({
      path: path.resolve('/work', 'src/a.ts'),
      line: 7,
      column: 5,
      text: 'hello world',
    })
  })

  it('绝对路径原样保留，文本超过 300 字符截断', () => {
    const absolute = path.resolve('/work', 'x.ts')
    const line = matchLine({
      path: { text: absolute },
      lines: { text: `${'x'.repeat(400)}\n` },
      line_number: 1,
      submatches: [],
    })
    const match = parseRgMatch(line, '/work')
    expect(match?.path).toBe(absolute)
    expect(match?.text).toHaveLength(300)
    expect(match?.column).toBe(1)
  })

  it('忽略 begin/end/summary、坏行与缺字段的行', () => {
    expect(parseRgMatch('{not json', '/work')).toBeNull()
    expect(parseRgMatch(JSON.stringify({ type: 'begin', data: {} }), '/work')).toBeNull()
    expect(parseRgMatch(JSON.stringify({ type: 'summary', data: {} }), '/work')).toBeNull()
    expect(parseRgMatch(matchLine({ lines: { text: 'x' } }), '/work')).toBeNull()
    expect(parseRgMatch(matchLine({ path: { text: 'a.ts' } }), '/work')).not.toBeNull()
  })

  it('清洗 rg --files 输出的相对路径前缀', () => {
    expect(cleanRelPath('.\\src\\a.ts')).toBe('src/a.ts')
    expect(cleanRelPath('./src/a.ts')).toBe('src/a.ts')
    expect(cleanRelPath('src/a.ts')).toBe('src/a.ts')
  })
})

describe('搜索结果批处理节流', () => {
  it('按条数或 100ms 间隔触发推送', () => {
    expect(shouldFlushBatch(BATCH_MAX_MATCHES, 0)).toBe(true)
    expect(shouldFlushBatch(BATCH_MAX_MATCHES - 1, 50)).toBe(false)
    expect(shouldFlushBatch(1, 100)).toBe(true)
    expect(shouldFlushBatch(0, 1000)).toBe(false)
  })

  it('每批不超过 200 条，最后一次一定 done', () => {
    let now = 0
    const events: FsSearchResultEvt[] = []
    const batcher = new SearchBatcher('s1', 450, (evt) => events.push(evt), () => now)
    for (let i = 0; i < 450; i++) {
      now += 1
      batcher.push({ path: `/f${i}` })
    }
    batcher.finish(true)
    const batches = events.filter((evt) => !evt.done)
    const total = batches.reduce((sum, evt) => sum + evt.matches.length, 0)
    expect(total).toBe(450)
    expect(batches.every((evt) => evt.matches.length <= BATCH_MAX_MATCHES)).toBe(true)
    expect(events.at(-1)).toMatchObject({ done: true, truncated: true, matches: [] })
  })

  it('达到 maxResults 后停止接收，finish 只执行一次', () => {
    const events: FsSearchResultEvt[] = []
    const batcher = new SearchBatcher('s2', 3, (evt) => events.push(evt), () => 0)
    expect(batcher.push({ path: '/a' })).toBe(false)
    expect(batcher.push({ path: '/b' })).toBe(false)
    expect(batcher.push({ path: '/c' })).toBe(true)
    expect(batcher.push({ path: '/d' })).toBe(true)
    expect(batcher.count).toBe(3)
    batcher.finish(true, '限制')
    batcher.finish(true, '限制')
    expect(events.filter((evt) => evt.done)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ done: true, truncated: true, error: '限制' })
  })
})
