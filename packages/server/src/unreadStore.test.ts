import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { UnreadStore, parseUnreadKey, parseUnreadRecord, pruneUnread } from './unreadStore'

describe('UnreadStore', () => {
  it('丢弃非法键与非法时间', () => {
    expect(parseUnreadRecord({ 'codex:a': 1, 'x:b': 2, 'pi:': 3, 'claude:c': 'x', 'pi:d:e': 4 }))
      .toEqual({ 'codex:a': 1, 'pi:d:e': 4 })
    expect(parseUnreadKey('pi:d:e')).toEqual({ agent: 'pi', threadId: 'd:e' })
    expect(parseUnreadRecord([1])).toEqual({})
  })

  it('超出上限时丢弃最旧的条目', () => {
    expect(pruneUnread({ 'codex:a': 1, 'codex:b': 3, 'codex:c': 2 }, 2)).toEqual({ 'codex:b': 3, 'codex:c': 2 })
  })

  it('按 Agent 区分并持久化，重复设置不算变化', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qn-unread-'))
    try {
      const store = new UnreadStore(dir, () => undefined, () => 42)
      expect(store.set('claude', 't1', true)).toBe(true)
      expect(store.set('claude', 't1', true)).toBe(false)
      expect(new UnreadStore(dir, () => undefined).list()).toEqual([{ agent: 'claude', threadId: 't1', at: 42 }])
      expect(store.set('codex', 't1', false)).toBe(false)
      expect(store.set('claude', 't1', false)).toBe(true)
      expect(new UnreadStore(dir, () => undefined).list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
