import { describe, expect, it } from 'vitest'
import { ThreadUsage } from './threadUsage'

const usage = { total: { totalTokens: 10 }, last: { totalTokens: 4 }, modelContextWindow: 100 }

describe('ThreadUsage', () => {
  it('把最近一次上报的用量附到打开会话的响应里', () => {
    const cache = new ThreadUsage()
    cache.notification({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', turnId: 'u1', tokenUsage: usage } })
    expect(cache.history({ thread: { id: 't1', turns: [] } })).toEqual({ thread: { id: 't1', turns: [], tokenUsage: usage } })
    expect(cache.history({ thread: { id: 't2' } })).toEqual({ thread: { id: 't2' } })
  })

  it('响应已自带用量或不是会话响应时原样返回', () => {
    const cache = new ThreadUsage()
    cache.notification({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage } })
    const own = { thread: { id: 't1', tokenUsage: { last: { totalTokens: 1 } } } }
    expect(cache.history(own)).toBe(own)
    const page = { data: [] }
    expect(cache.history(page)).toBe(page)
    cache.clear()
    const plain = { thread: { id: 't1' } }
    expect(cache.history(plain)).toBe(plain)
  })
})
