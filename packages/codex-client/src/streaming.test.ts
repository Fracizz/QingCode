import { describe, expect, it } from 'vitest'
import { createDeltaBuffer, isStreamDelta, splitMarkdownBlocks } from './streaming'

describe('splitMarkdownBlocks', () => {
  it('按空行切块，连续空行不产生空块', () => {
    expect(splitMarkdownBlocks('# 标题\n\n第一段\n续行\n\n\n第二段')).toEqual(['# 标题', '第一段\n续行', '第二段'])
  })

  it('代码围栏内的空行不切', () => {
    const fenced = '```ts\nconst a = 1\n\nconst b = 2\n```'
    expect(splitMarkdownBlocks(`说明\n\n${fenced}\n\n结尾`)).toEqual(['说明', fenced, '结尾'])
  })

  it('未闭合的围栏（流式中）归入最后一块', () => {
    expect(splitMarkdownBlocks('前文\n\n~~~\na\n\nb')).toEqual(['前文', '~~~\na\n\nb'])
  })

  it('较短或不同字符的标记不关闭围栏', () => {
    const fenced = '````\n```\n\n~~~\n````'
    expect(splitMarkdownBlocks(`${fenced}\n\n后文`)).toEqual([fenced, '后文'])
  })

  it('前面的块在追加内容后保持不变', () => {
    const before = splitMarkdownBlocks('甲\n\n乙')
    const after = splitMarkdownBlocks('甲\n\n乙丙\n\n丁')
    expect(after[0]).toBe(before[0])
  })
})

describe('isStreamDelta', () => {
  it('只识别追加型增量', () => {
    expect(isStreamDelta({ method: 'item/agentMessage/delta' })).toBe(true)
    expect(isStreamDelta({ method: 'item/commandExecution/outputDelta' })).toBe(true)
    expect(isStreamDelta({ method: 'turn/completed' })).toBe(false)
  })
})

describe('createDeltaBuffer', () => {
  it('按会话缓冲，定时或手动冲刷，冲刷后不重复写入', async () => {
    const applied: [string, number][] = []
    const buffer = createDeltaBuffer((key, list) => applied.push([key, list.length]), 5)
    const note = { method: 'item/agentMessage/delta', params: {} } as never
    buffer.push('a', note)
    buffer.push('a', note)
    buffer.push('b', note)
    buffer.flush('a')
    expect(applied).toEqual([['a', 2]])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(applied).toEqual([['a', 2], ['b', 1]])
    buffer.push('c', note)
    buffer.drop('c')
    buffer.flushAll()
    expect(applied).toHaveLength(2)
  })
})
