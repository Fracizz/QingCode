import { describe, expect, it } from 'vitest'
import { CHUNK_MAX_BYTES, OutputCoalescer, TermOutputBuffer, planAttach } from './buffer'

const seqs = (chunks: Array<{ seq: number }>): number[] => chunks.map((c) => c.seq)

describe('TermOutputBuffer', () => {
  it('按 seq 追加，base64 可还原任意字节（含非法 UTF-8）', () => {
    const buffer = new TermOutputBuffer()
    const raw = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x80, 0x0d, 0x0a])
    const chunk = buffer.append(raw)
    expect(chunk.seq).toBe(1)
    expect(Buffer.from(chunk.data, 'base64')).toEqual(raw)
    expect(buffer.lastSeq).toBe(1)
    expect(buffer.bytes).toBe(raw.byteLength)
  })

  it('since 只补发断点之后的分块', () => {
    const buffer = new TermOutputBuffer()
    buffer.append(Buffer.from('a'))
    buffer.append(Buffer.from('bb'))
    expect(seqs(buffer.since(0).chunks)).toEqual([1, 2])
    expect(seqs(buffer.since(1).chunks)).toEqual([2])
    expect(buffer.since(2)).toMatchObject({ chunks: [], lastSeq: 2, truncated: false, bytes: 0 })
    expect(buffer.since(1).bytes).toBe(2)
  })

  it('按字节上限淘汰旧块并标记 truncated', () => {
    const buffer = new TermOutputBuffer({ maxRawBytes: 10 })
    buffer.append(Buffer.alloc(4, 0x61))
    buffer.append(Buffer.alloc(4, 0x62))
    buffer.append(Buffer.alloc(4, 0x63))
    const replay = buffer.since(0)
    expect(seqs(replay.chunks)).toEqual([2, 3])
    expect(replay.truncated).toBe(true)
    expect(buffer.bytes).toBe(8)
    expect(buffer.firstSeq).toBe(2)
    // 断点正好在淘汰边界上：缺的块都还在
    expect(buffer.since(1).truncated).toBe(false)
  })

  it('按条数上限淘汰；断点已追平时不算截断', () => {
    const buffer = new TermOutputBuffer({ maxChunks: 2 })
    for (const s of ['1', '2', '3', '4']) buffer.append(Buffer.from(s))
    expect(seqs(buffer.since(0).chunks)).toEqual([3, 4])
    expect(buffer.since(1).truncated).toBe(true)
    expect(buffer.since(2).truncated).toBe(false)
    expect(buffer.since(4).truncated).toBe(false)
    expect(buffer.since(99)).toMatchObject({ chunks: [], truncated: false })
  })

  it('单块超过上限时至少保留最新一块', () => {
    const buffer = new TermOutputBuffer({ maxRawBytes: 4 })
    buffer.append(Buffer.alloc(10))
    expect(buffer.length).toBe(1)
    expect(buffer.since(0).truncated).toBe(false)
  })

  it('大量淘汰后仍保持 seq 连续（头部压缩）', () => {
    const buffer = new TermOutputBuffer({ maxChunks: 3 })
    for (let i = 0; i < 5000; i++) buffer.append(Buffer.from([i & 0xff]))
    const replay = buffer.since(4997)
    expect(seqs(replay.chunks)).toEqual([4998, 4999, 5000])
    expect(Buffer.from(replay.chunks[2]!.data, 'base64')[0]).toBe(4999 & 0xff)
  })

  it('clear 清空内容但保留 seq 进度', () => {
    const buffer = new TermOutputBuffer()
    buffer.append(Buffer.from('x'))
    buffer.clear()
    expect(buffer.length).toBe(0)
    expect(buffer.lastSeq).toBe(1)
    expect(buffer.since(0).truncated).toBe(true)
  })
})

describe('planAttach', () => {
  const snap = (seq: number) => ({ seq, data: 'AA==', cols: 80, rows: 24 })

  it('缓冲完整：replay', () => {
    const buffer = new TermOutputBuffer()
    buffer.append(Buffer.from('a'))
    buffer.append(Buffer.from('b'))
    const plan = planAttach(buffer, 1, null)
    expect(plan).toMatchObject({ mode: 'replay', lastSeq: 2, truncated: false })
    expect(seqs(plan.chunks)).toEqual([2])
  })

  it('已截断但快照接得上：snapshot + 快照之后的增量', () => {
    const buffer = new TermOutputBuffer({ maxChunks: 2 })
    for (const s of ['1', '2', '3', '4']) buffer.append(Buffer.from(s))
    const plan = planAttach(buffer, 0, snap(2))
    expect(plan.mode).toBe('snapshot')
    expect(plan.snapshot?.seq).toBe(2)
    expect(seqs(plan.chunks)).toEqual([3, 4])
  })

  it('快照过旧（之后的块已淘汰）：resync', () => {
    const buffer = new TermOutputBuffer({ maxChunks: 2 })
    for (const s of ['1', '2', '3', '4']) buffer.append(Buffer.from(s))
    const plan = planAttach(buffer, 0, snap(1))
    expect(plan).toMatchObject({ mode: 'resync', truncated: true })
    expect(plan.snapshot).toBeUndefined()
    expect(seqs(plan.chunks)).toEqual([3, 4])
  })

  it('sinceSeq 超前（来自别的 daemon 实例）：resync 并给出全部保留块', () => {
    const buffer = new TermOutputBuffer()
    buffer.append(Buffer.from('a'))
    const plan = planAttach(buffer, 50, null)
    expect(plan).toMatchObject({ mode: 'resync', truncated: true, lastSeq: 1 })
    expect(seqs(plan.chunks)).toEqual([1])
  })

  it('未截断时即使有快照也优先 replay', () => {
    const buffer = new TermOutputBuffer()
    buffer.append(Buffer.from('a'))
    expect(planAttach(buffer, 0, snap(1)).mode).toBe('replay')
  })
})

describe('OutputCoalescer', () => {
  it('不足一块时先攒着，drain 一次取出', () => {
    const c = new OutputCoalescer(8)
    expect(c.push(Buffer.from('abc'))).toEqual([])
    expect(c.push(Buffer.from('de'))).toEqual([])
    expect(c.pendingBytes).toBe(5)
    expect(c.drain()?.toString()).toBe('abcde')
    expect(c.drain()).toBeNull()
  })

  it('攒满即切出整块，余数留待下次', () => {
    const c = new OutputCoalescer(4)
    const ready = c.push(Buffer.from('abcdefghij'))
    expect(ready.map((b) => b.toString())).toEqual(['abcd', 'efgh'])
    expect(c.pendingBytes).toBe(2)
    expect(c.push(Buffer.from('kl')).map((b) => b.toString())).toEqual(['ijkl'])
    expect(c.drain()).toBeNull()
  })

  it('默认块大小为 32 KiB，空输入忽略', () => {
    const c = new OutputCoalescer()
    expect(c.push(Buffer.alloc(0))).toEqual([])
    const ready = c.push(Buffer.alloc(CHUNK_MAX_BYTES * 2 + 1))
    expect(ready.map((b) => b.byteLength)).toEqual([CHUNK_MAX_BYTES, CHUNK_MAX_BYTES])
    expect(c.drain()?.byteLength).toBe(1)
  })
})
