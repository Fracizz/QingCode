import { describe, expect, it } from 'vitest'
import { RunOutputBuffer } from './buffer'

describe('RunOutputBuffer', () => {
  it('seq 递增，按 sinceSeq 取增量', () => {
    const buffer = new RunOutputBuffer(100)
    buffer.push('stdout', 'a')
    buffer.push('stderr', 'b')
    buffer.push('stdout', 'c')
    expect(buffer.lastSeq).toBe(3)
    expect(buffer.since(1)).toEqual({
      chunks: [
        { seq: 2, stream: 'stderr', data: 'b' },
        { seq: 3, stream: 'stdout', data: 'c' },
      ],
      truncated: false,
    })
  })

  it('超过字节上限丢最旧并标记 truncated', () => {
    const buffer = new RunOutputBuffer(10)
    buffer.push('stdout', '1234')
    buffer.push('stdout', '5678')
    buffer.push('stdout', 'abcd')
    const all = buffer.since(0)
    expect(all.chunks.map((c) => c.seq)).toEqual([2, 3])
    expect(all.truncated).toBe(true)
    // 已拿到被丢弃部分的客户端不算截断。
    expect(buffer.since(1).truncated).toBe(false)
  })

  it('按 UTF-8 字节计量', () => {
    const buffer = new RunOutputBuffer(6)
    buffer.push('stdout', '中文')
    buffer.push('stdout', '字')
    expect(buffer.since(0).chunks.map((c) => c.data)).toEqual(['字'])
  })

  it('单块超限只保留尾部', () => {
    const buffer = new RunOutputBuffer(8)
    const chunk = buffer.push('stdout', '0123456789abcdef')
    expect(chunk.data).toBe('89abcdef')
    expect(buffer.since(0).truncated).toBe(true)
    expect(buffer.since(1).truncated).toBe(false)
    const wide = new RunOutputBuffer(7)
    expect(Buffer.byteLength(wide.push('stdout', '一二三四五').data)).toBeLessThanOrEqual(7)
  })
})
