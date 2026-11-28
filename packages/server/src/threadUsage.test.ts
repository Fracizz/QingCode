import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseThreadUsageRecord, ThreadUsage } from './threadUsage'

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

describe('ThreadUsage 落盘', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-thread-usage-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('daemon 重启后仍能把读数附到打开会话的响应里', () => {
    const before = new ThreadUsage({ stateDir: dir, agent: 'codex' })
    before.notification({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage } })
    before.clear()
    expect(fs.existsSync(path.join(dir, 'thread-usage', 'codex.json'))).toBe(true)
    const after = new ThreadUsage({ stateDir: dir, agent: 'codex' })
    expect(after.history({ thread: { id: 't1' } })).toEqual({ thread: { id: 't1', tokenUsage: usage } })
  })

  it('同一轮内多次上报合并写盘，未到时间不写', () => {
    vi.useFakeTimers()
    try {
      const cache = new ThreadUsage({ stateDir: dir })
      cache.notification({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: usage } })
      const file = path.join(dir, 'thread-usage', 'codex.json')
      expect(fs.existsSync(file)).toBe(false)
      vi.advanceTimersByTime(2_000)
      expect(parseThreadUsageRecord(JSON.parse(fs.readFileSync(file, 'utf8'))).get('t1')).toEqual(usage)
    } finally {
      vi.useRealTimers()
    }
  })

  it('损坏的记录按空表处理，只保留合法条目并按最近更新排序', () => {
    expect(parseThreadUsageRecord('oops').size).toBe(0)
    const parsed = parseThreadUsageRecord({ threads: [['a', usage], ['', usage], ['b', 1], ['c', usage], ['a', { last: {} }]] })
    expect([...parsed.keys()]).toEqual(['c', 'a'])
    expect(parsed.get('a')).toEqual({ last: {} })
    fs.mkdirSync(path.join(dir, 'thread-usage'))
    fs.writeFileSync(path.join(dir, 'thread-usage', 'codex.json'), '{bad')
    const logs: string[] = []
    const cache = new ThreadUsage({ stateDir: dir, log: (message) => logs.push(message) })
    expect(cache.history({ thread: { id: 'a' } })).toEqual({ thread: { id: 'a' } })
    expect(logs).toHaveLength(1)
  })
})
