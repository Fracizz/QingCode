import { describe, expect, it } from 'vitest'
import { listHistoryItems, listHistoryTurns } from './historyPages'

describe('适配器历史分页', () => {
  it('以 UTF-8 字节限制页长，允许单条超预算，游标在翻页和反向时保留位置', () => {
    const turns = ['a', 'b', 'c'].map((id) => ({
      id,
      items: [{ id: `${id}-1`, type: 'agentMessage', text: '中文'.repeat(id === 'a' ? 150_000 : 80_000) }],
    }))
    const opts = { limit: 10, itemsView: 'full' }
    const latest = listHistoryTurns('thread-1', turns, opts)
    expect(latest).toMatchObject({ data: [{ id: 'c' }], nextCursor: expect.any(String) })
    const older = listHistoryTurns('thread-1', turns, { ...opts, cursor: latest.nextCursor })
    expect(older).toMatchObject({ data: [{ id: 'b' }], nextCursor: expect.any(String) })
    expect(listHistoryTurns('thread-1', turns, { ...opts, cursor: older.nextCursor }))
      .toMatchObject({ data: [{ id: 'a' }], nextCursor: null })
    expect(listHistoryTurns('thread-1', turns, { ...opts, sortDirection: 'asc', cursor: older.backwardsCursor }))
      .toMatchObject({ data: [{ id: 'b' }] })
    expect(() => listHistoryTurns('thread-2', turns, { ...opts, cursor: latest.nextCursor })).toThrow('历史分页游标无效')
  })

  it('下一页定位到稳定 ID，活动轮退出后仍能回读旧轮；条目锚点是排他的', () => {
    const done = { id: 'saved', items: [{ id: 'item-1' }, { id: 'item-2' }] }
    const active = { id: 'active', items: [] }
    const first = listHistoryTurns('thread', [done, active], { limit: 1 })
    expect(first).toMatchObject({ data: [{ id: active.id }], nextCursor: expect.any(String) })
    expect(listHistoryTurns('thread', [done], { limit: 1, cursor: first.nextCursor }))
      .toMatchObject({ data: [{ id: done.id }], nextCursor: null })
    expect(listHistoryItems('thread', [done], { turnId: done.id, cursor: { type: 'item', itemId: 'item-1' } }))
      .toMatchObject({ data: [{ turnId: done.id, item: { id: 'item-2' } }], nextCursor: null })
  })
})
