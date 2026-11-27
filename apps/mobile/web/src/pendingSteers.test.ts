import type { ItemView } from '@qn/codex-client'
import { describe, expect, it } from 'vitest'
import { echoedSteerIds, withoutPendingSteers, withPendingSteer, type PendingSteer } from './pendingSteers'

const steer = (id: string): PendingSteer => ({ id, text: id, attachments: 0, sentAt: 1 })

describe('pendingSteers', () => {
  it('按条目 id 或 clientId 识别已回显的引导', () => {
    const items: ItemView[] = [
      { kind: 'agent', id: 'a', text: '回复', streaming: false },
      { kind: 'user', id: 's1', text: 's1', steering: 'currentTurn' },
      { kind: 'user', id: 'server-id', clientId: 's2', text: 's2', steering: 'nextTurn' },
    ]
    expect(echoedSteerIds([steer('s1'), steer('s2'), steer('s3')], items)).toEqual(['s1', 's2'])
  })

  it('非用户条目同 id 不算回显', () => {
    expect(echoedSteerIds([steer('x')], [{ kind: 'agent', id: 'x', text: '', streaming: false }])).toEqual([])
  })

  it('增删按会话分组，空列表时移除分组', () => {
    let all = withPendingSteer({}, 'k', steer('a'))
    expect(withPendingSteer(all, 'k', steer('a'))).toBe(all)
    all = withPendingSteer(all, 'k', steer('b'))
    expect(all.k?.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(withoutPendingSteers(all, 'k', ['missing'])).toBe(all)
    all = withoutPendingSteers(all, 'k', ['a'])
    expect(all.k?.map((entry) => entry.id)).toEqual(['b'])
    expect(withoutPendingSteers(all, 'k', ['b'])).toEqual({})
  })
})
