import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_RAW_BYTES, TermOutputBuffer, planAttach } from './termBuffer.mjs'

describe('TermOutputBuffer', () => {
  it('按 seq 追加 base64 分块，原始字节可原样还原（含非法 UTF-8）', () => {
    const buffer = new TermOutputBuffer()
    const raw = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x80, 0x0d, 0x0a])
    const first = buffer.append(raw)
    expect(first.seq).toBe(1)
    expect(Buffer.from(first.data, 'base64')).toEqual(raw)
    expect(buffer.lastSeq).toBe(1)
    expect(buffer.bytes).toBe(raw.byteLength)
  })

  it('since 只补发断点之后的分块', () => {
    const buffer = new TermOutputBuffer()
    const one = buffer.append(Buffer.from('a'))
    const two = buffer.append(Buffer.from('bb'))
    expect(buffer.since(0).chunks.map((c) => c.seq)).toEqual([1, 2])
    expect(buffer.since(one.seq).chunks.map((c) => c.seq)).toEqual([two.seq])
    expect(buffer.since(2)).toMatchObject({ chunks: [], lastSeq: 2, truncated: false, bytes: 0 })
  })

  it('按原始字节上限淘汰旧分块，并给出 truncated', () => {
    const buffer = new TermOutputBuffer({ maxRawBytes: 10 })
    buffer.append(Buffer.alloc(4, 0x61))
    buffer.append(Buffer.alloc(4, 0x62))
    buffer.append(Buffer.alloc(4, 0x63))
    const replay = buffer.since(0)
    expect(replay.chunks.map((c) => c.seq)).toEqual([2, 3])
    expect(replay.truncated).toBe(true)
    expect(replay.bytes).toBe(8)
    expect(buffer.bytes).toBe(8)
    expect(buffer.lastSeq).toBe(3)
  })

  it('按条数上限淘汰，断点在存活区间内时 truncated 为 false', () => {
    const buffer = new TermOutputBuffer({ maxChunks: 2 })
    buffer.append(Buffer.from('1'))
    buffer.append(Buffer.from('2'))
    buffer.append(Buffer.from('3'))
    expect(buffer.since(1).truncated).toBe(false)
    expect(buffer.since(1).chunks.map((c) => c.seq)).toEqual([2, 3])
    expect(buffer.since(0).truncated).toBe(true)
  })

  it('clear 清数据但不清 seq', () => {
    const buffer = new TermOutputBuffer()
    buffer.append(Buffer.from('x'))
    buffer.clear()
    expect(buffer.bytes).toBe(0)
    expect(buffer.lastSeq).toBe(1)
    expect(buffer.append(Buffer.from('y')).seq).toBe(2)
  })

  it('默认上限 2 MiB', () => {
    expect(DEFAULT_MAX_RAW_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe('planAttach 接回决策', () => {
  const replay = (truncated: boolean, lastSeq: number) => ({
    chunks: [],
    lastSeq,
    truncated,
    bytes: 0,
    oldestSeq: null,
  })

  it('缓冲完整时直接补发增量', () => {
    expect(planAttach(replay(false, 10), { hasSnapshot: false, sinceSeq: 6 }).mode).toBe('replay')
  })

  it('缓冲截断但有屏幕快照时用快照 + 增量', () => {
    expect(planAttach(replay(true, 10), { hasSnapshot: true, sinceSeq: 1 }).mode).toBe('snapshot')
  })

  it('缓冲截断且无快照时只能 resync', () => {
    expect(planAttach(replay(true, 10), { hasSnapshot: false, sinceSeq: 1 }).mode).toBe('resync')
  })
})
