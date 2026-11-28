import { describe, expect, it } from 'vitest'
import type { ItemView, ThreadView, TurnMeta } from './conversation'
import { steerOutcome } from './steerDelivery'

const turn = (id: string, outcome?: TurnMeta['outcome']): TurnMeta =>
  ({ id, ...(outcome ? { outcome } : {}), itemIds: [], startedAtMs: null, durationMs: null })
const view = (status: ThreadView['status'], turns: TurnMeta[], items: ItemView[] = []): ThreadView =>
  ({ id: 't', status, activeTurnId: null, items, pendingApprovals: [], turns })
const steer = { clientId: 'c', turnId: 'one' }
const echo = (pending?: boolean): ItemView => ({ kind: 'user', id: 'c', text: '补充', ...(pending ? { pending } : {}) })

describe('引导送达判断', () => {
  it('回显过就是已送达', () => {
    expect(steerOutcome(view('running', [turn('one')], [echo()]), steer)).toBe('delivered')
    const piEcho: ItemView = { kind: 'user', id: 'steer-c', clientId: 'c', text: '补充' }
    expect(steerOutcome(view('idle', [turn('one', 'completed')], [piEcho]), steer)).toBe('delivered')
  })

  it('目标轮次未结束或下一轮仍在运行时继续等', () => {
    expect(steerOutcome(view('running', [turn('one')]), steer)).toBe('waiting')
    expect(steerOutcome(view('running', [turn('one', 'completed'), turn('two')]), steer)).toBe('waiting')
    expect(steerOutcome(view('idle', []), steer)).toBe('waiting')
    expect(steerOutcome(undefined, steer)).toBe('waiting')
  })

  it('停下后仍无回显，或又结束了一轮，按未送达处理', () => {
    expect(steerOutcome(view('error', [turn('one', 'interrupted')]), steer)).toBe('undelivered')
    expect(steerOutcome(view('idle', [turn('one', 'completed')]), steer)).toBe('undelivered')
    expect(steerOutcome(view('running', [turn('one', 'completed'), turn('two', 'completed'), turn('three')]), steer)).toBe('undelivered')
  })

  it('本地占位仍在说明没有回显；占位被替换说明已回显', () => {
    const ended = [turn('one', 'interrupted')]
    expect(steerOutcome(view('error', ended, [echo(true)]), { ...steer, optimistic: true })).toBe('undelivered')
    expect(steerOutcome(view('error', ended), { ...steer, optimistic: true })).toBe('delivered')
  })
})
