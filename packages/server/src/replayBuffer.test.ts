import { describe, expect, it } from 'vitest'
import { ReplayBuffer } from './replayBuffer'

const msg = (n: number): Record<string, unknown> => ({ method: 'tick', params: { n } })

describe('ReplayBuffer', () => {
  it('seq 从 1 递增，since 只回放区间内的消息', () => {
    const buffer = new ReplayBuffer()
    expect(buffer.lastSeq).toBe(0)
    for (let i = 1; i <= 5; i++) expect(buffer.push(msg(i)).seq).toBe(i)
    expect(buffer.since(0)).toEqual({
      messages: [1, 2, 3, 4, 5].map((n) => ({ seq: n, msg: msg(n) })),
      truncated: false,
    })
    expect(buffer.since(3).messages.map((m) => m.seq)).toEqual([4, 5])
    expect(buffer.since(5)).toEqual({ messages: [], truncated: false })
  })

  it('条数上限淘汰旧消息并标记 truncated', () => {
    const buffer = new ReplayBuffer({ maxEntries: 3 })
    for (let i = 1; i <= 5; i++) buffer.push(msg(i))
    expect(buffer.size).toBe(3)
    expect(buffer.since(2)).toEqual({
      messages: [3, 4, 5].map((n) => ({ seq: n, msg: msg(n) })),
      truncated: false,
    })
    expect(buffer.since(0).messages.map((m) => m.seq)).toEqual([3, 4, 5])
    expect(buffer.since(0).truncated).toBe(true)
    expect(buffer.lastSeq).toBe(5)
  })

  it('字节上限淘汰旧消息', () => {
    // 只够放一条：第二条进来时第一条被淘汰。
    const oneSize = JSON.stringify(msg(1)).length
    const buffer = new ReplayBuffer({ maxBytes: oneSize + 5 })
    buffer.push(msg(1))
    buffer.push(msg(2))
    expect(buffer.size).toBe(1)
    const replay = buffer.since(0)
    expect(replay.messages.map((m) => m.seq)).toEqual([2])
    expect(replay.truncated).toBe(true)
  })

  it('非法 sinceSeq 按 0 处理', () => {
    const buffer = new ReplayBuffer({ maxEntries: 1 })
    buffer.push(msg(1))
    expect(buffer.since(Number.NaN).messages.map((m) => m.seq)).toEqual([1])
  })
})
