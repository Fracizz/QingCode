import { describe, expect, it } from 'vitest'
import type { ItemView, TurnMeta } from './conversation'
import { branchPoint, canReviseMessage, revisionNote, turnOpeningMessages } from './turnPoints'

const user = (id: string, extra: Partial<Extract<ItemView, { kind: 'user' }>> = {}): ItemView =>
  ({ kind: 'user', id, text: id, ...extra })
const agent = (id: string): ItemView => ({ kind: 'agent', id, text: id, streaming: false })
const turn = (id: string, ...itemIds: string[]): TurnMeta =>
  ({ id, itemIds, outcome: 'completed', startedAtMs: null, durationMs: null })

const items = [user('u1'), agent('a1'), user('u2'), agent('a2'), user('s2', { steering: 'currentTurn' })]
const turns = [turn('one', 'u1', 'a1'), turn('two', 'u2', 'a2', 's2')]

describe('轮次定位', () => {
  it('只有开启一轮的用户消息可作为起点', () => {
    expect([...turnOpeningMessages({ items, turns })]).toEqual([['u1', 'one'], ['u2', 'two']])
  })

  it('Agent 自行开始的轮次里并入的消息、待确认气泡不算', () => {
    const view = {
      items: [agent('auto'), user('late', { steering: 'nextTurn' }), user('pending', { pending: true })],
      turns: [turn('auto-turn', 'auto', 'late'), turn('next', 'pending')],
    }
    expect(turnOpeningMessages(view).size).toBe(0)
  })

  it('同一条目有实时和历史两份轮次记录时用后写入的', () => {
    expect(turnOpeningMessages({ items: [user('u1')], turns: [turn('live-uuid', 'u1'), turn('turn-x-0', 'u1')] }).get('u1'))
      .toBe('turn-x-0')
  })

  it('分支点是上一轮；第一条消息开新会话', () => {
    expect(branchPoint({ items, turns }, 'u2')).toEqual({ kind: 'turn', turnId: 'one' })
    expect(branchPoint({ items, turns }, 'u1')).toEqual({ kind: 'start' })
  })

  it('上一轮未加载时要求向前翻页', () => {
    const view = { items: items.slice(2), turns: turns.slice(1), historyCursor: { turns: 'c' } }
    expect(branchPoint(view, 'u2')).toEqual({ kind: 'earlier' })
  })

  it('归属不明时不猜测，提示条目忽略', () => {
    expect(branchPoint({ items: [user('lost'), user('u2')], turns: [turn('two', 'u2')] }, 'u2')).toBeNull()
    expect(branchPoint({ items, turns }, 'missing')).toBeNull()
    const noticed = [items[0]!, items[1]!, { kind: 'notice', id: 'n', text: '' } as ItemView, items[2]!]
    expect(branchPoint({ items: noticed, turns }, 'u2')).toEqual({ kind: 'turn', turnId: 'one' })
  })
})

describe('编辑重发规则（两端共用）', () => {
  const openers = turnOpeningMessages({ items, turns })

  it('运行中都不能改；能回退的任意消息，只能分支的只限开启一轮的消息', () => {
    expect(canReviseMessage({ revert: true, fork: true }, true, 'u1', openers)).toBe(false)
    expect(canReviseMessage({ revert: true, fork: true }, false, 's2', openers)).toBe(true)
    expect(canReviseMessage({ revert: false, fork: true }, false, 'u2', openers)).toBe(true)
    expect(canReviseMessage({ revert: false, fork: true }, false, 's2', openers)).toBe(false)
    expect(canReviseMessage({ revert: false, fork: false }, false, 'u1', openers)).toBe(false)
  })

  it('只有分支重发才在编辑框里说明', () => {
    expect(revisionNote({ revert: true, fork: true }, true)).toBeUndefined()
    expect(revisionNote({ revert: false, fork: true }, true)).toContain('第一条消息')
    expect(revisionNote({ revert: false, fork: true }, false)).toContain('上一轮')
  })
})
