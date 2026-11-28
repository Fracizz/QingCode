import { describe, expect, it, vi } from 'vitest'
import type { CodexRpcLike } from './api'
import {
  applyEarlierPlan, applyNotification, emptyState, loadRecentThreadHistory, loadThread, prependThreadHistory,
  type ConversationState,
} from './conversation'
import { parsePlan, planProgress, readEarlierPlan } from './plan'
import type { ServerNotification, Thread, Turn } from './codex-types'

const steps = (status: string, step = '读代码') => ({ explanation: null, plan: [{ step, status }] })
const turn = (id: string, plan?: unknown) => ({ id, status: 'completed', items: [], ...(plan ? { plan } : {}) }) as unknown as Turn
const thread = (turns: Turn[]) => ({ id: 't', status: { type: 'idle' }, turns }) as unknown as Thread
const planOf = (state: ConversationState) => state.threads.t?.plan
const update = (state: ConversationState, turnId: string, plan: unknown) => applyNotification(state, {
  method: 'turn/plan/updated', params: { threadId: 't', turnId, explanation: '说明', plan },
} as unknown as ServerNotification)

describe('计划清单', () => {
  it('解析清单：丢弃无效步骤，未知状态按未开始', () => {
    expect(parsePlan({ explanation: '', plan: [{ step: '一', status: 'inProgress' }, { step: '' }, { step: '二', status: '??' }, 3] }, 'u'))
      .toEqual({ turnId: 'u', explanation: null, steps: [{ step: '一', status: 'inProgress' }, { step: '二', status: 'pending' }] })
    expect(parsePlan({ explanation: null }, 'u')).toBeNull()
    expect(parsePlan(null, 'u')).toBeNull()
  })

  it('进度取进行中的步骤，没有时取第一个未开始的', () => {
    const plan = parsePlan({ plan: [{ step: '一', status: 'completed' }, { step: '二', status: 'pending' }] }, 'u')!
    expect(planProgress(plan)).toEqual({ done: 1, total: 2, current: { step: '二', status: 'pending' } })
    expect(planProgress(parsePlan({ plan: [{ step: '一', status: 'completed' }] }, 'u')!).current).toBeUndefined()
  })

  it('实时通知整份替换，清空后保留空清单', () => {
    let state = update(emptyState(), 'u1', [{ step: '一', status: 'pending' }])
    expect(planOf(state)).toMatchObject({ turnId: 'u1', explanation: '说明', steps: [{ step: '一' }] })
    state = update(state, 'u2', [])
    expect(planOf(state)).toEqual({ turnId: 'u2', explanation: '说明', steps: [] })
  })

  it('历史取最后一份清单；历史不带清单时沿用已知的', () => {
    const loaded = loadThread(emptyState(), thread([turn('a', steps('pending')), turn('b', steps('completed')), turn('c')]))
    expect(planOf(loaded)).toMatchObject({ turnId: 'b', steps: [{ status: 'completed' }] })
    expect(planOf(loadThread(loaded, thread([turn('d')])))).toEqual(planOf(loaded))
  })

  it('读历史期间收到的清单优先于历史里的旧清单', () => {
    const before = loadThread(emptyState(), thread([turn('a', steps('pending'))])).threads.t!
    const live = update({ threads: { t: before } }, 'b', [{ step: '新', status: 'inProgress' }])
    const merged = loadRecentThreadHistory(live, thread([turn('a', steps('pending'))]), null, before)
    expect(planOf(merged)).toMatchObject({ turnId: 'b' })
  })

  it('向前翻页只在还没有清单时采用更早页里的', () => {
    const recent = loadThread(emptyState(), thread([turn('c')]))
    const earlier = prependThreadHistory(recent, 't', { turns: [turn('a', steps('pending'))], earlier: null })
    expect(planOf(earlier)).toMatchObject({ turnId: 'a' })
    const cleared = update(recent, 'c', [])
    expect(planOf(prependThreadHistory(cleared, 't', { turns: [turn('a', steps('pending'))], earlier: null }))?.steps).toEqual([])
    expect(applyEarlierPlan(cleared, 't', parsePlan(steps('pending'), 'a')!)).toBe(cleared)
  })

  it('补读只取轮次摘要，翻到第一份清单为止', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [turn('c')], nextCursor: 'older' })
      .mockResolvedValueOnce({ data: [turn('b', steps('inProgress')), turn('a', steps('pending'))], nextCursor: 'oldest' })
    const plan = await readEarlierPlan({ request } as unknown as CodexRpcLike, 't', { turns: 'first' })
    expect(plan?.turnId).toBe('b')
    expect(request.mock.calls.map(([, params]) => [params.cursor, params.itemsView])).toEqual([['first', 'notLoaded'], ['older', 'notLoaded']])
  })

  it('补读有页数上限，出错或没有游标时返回 null', async () => {
    let page = 0
    const endless = vi.fn(async () => ({ data: [], nextCursor: `p${++page}` }))
    expect(await readEarlierPlan({ request: endless } as unknown as CodexRpcLike, 't', { turns: 'p0' })).toBeNull()
    expect(endless).toHaveBeenCalledTimes(3)
    const failing = vi.fn(async () => { throw new Error('不支持') })
    expect(await readEarlierPlan({ request: failing } as unknown as CodexRpcLike, 't', { turns: 'p0' })).toBeNull()
    expect(await readEarlierPlan({ request: failing } as unknown as CodexRpcLike, 't', null)).toBeNull()
    expect(failing).toHaveBeenCalledTimes(1)
  })
})
