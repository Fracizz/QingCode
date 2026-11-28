import { describe, expect, it } from 'vitest'
import type { UserInput } from './codex-types'
import type { ItemView, ThreadView } from './conversation'
import { CodexRpcError } from './rpc'
import {
  alternateSendMode, isSlashDraft, isSteerRejected, parseRunningSend, planSteer, runningSendMode, turnSteerBlock,
} from './runningSend'

const input = (text: string): UserInput[] => [{ type: 'text', text, text_elements: [] }]

function running(items: ItemView[] = [], activeTurnId: string | null = 'turn'): ThreadView {
  return {
    id: 'thread', status: 'running', activeTurnId, items, pendingApprovals: [],
    turns: [{ id: 'turn', itemIds: items.map((item) => item.id) }],
  } as unknown as ThreadView
}

const other = (id: string, type: string, status?: string): ItemView => ({ kind: 'other', id, type, summary: '', status })

describe('运行中发送', () => {
  it('设置默认引导，打断对应立即发送，备选方式不含打断', () => {
    expect(parseRunningSend(null)).toBe('steer')
    expect(parseRunningSend('bad')).toBe('steer')
    expect(parseRunningSend('interrupt')).toBe('interrupt')
    expect(runningSendMode('interrupt')).toBe('immediate')
    expect(runningSendMode('queue')).toBe('queue')
    expect([alternateSendMode('steer'), alternateSendMode('queue'), alternateSendMode('interrupt')])
      .toEqual(['queue', 'steer', 'queue'])
  })

  it('识别斜杠命令；路径不算，技能只在 Claude 与 pi 上算命令', () => {
    expect(isSlashDraft('codex', '/review')).toBe(true)
    expect(isSlashDraft('claude', '  /plugin:skill 参数')).toBe(true)
    expect(isSlashDraft('codex', '/usr/bin 下有什么')).toBe(false)
    expect(isSlashDraft('codex', '看看 /tmp')).toBe(false)
    expect(isSlashDraft('codex', '总结', 1)).toBe(false)
    expect(isSlashDraft('claude', '总结', 1)).toBe(true)
    expect(isSlashDraft('pi', '总结', 1)).toBe(true)
  })

  it('运行中的普通消息引导当前一轮', () => {
    expect(planSteer({ agent: 'codex', view: running(), input: input('补充') })).toEqual({ route: 'steer', turnId: 'turn' })
  })

  it('没有运行中的轮次时按普通消息发送', () => {
    expect(planSteer({ agent: 'codex', view: undefined, input: input('补充') })).toEqual({ route: 'send' })
    const idle = { ...running(), status: 'idle', activeTurnId: null } as ThreadView
    expect(planSteer({ agent: 'codex', view: idle, input: input('补充'), expectedTurnId: 'turn' })).toEqual({ route: 'send' })
  })

  it.each([
    ['启动压缩中', { compactionStarting: true }, 'compacting'],
    ['轮次已切换', { expectedTurnId: 'old' }, 'turnChanged'],
    ['轮次编号未到', { view: running([], null) }, 'noTurn'],
    ['压缩条目进行中', { view: running([other('c', 'contextCompaction', 'inProgress')]) }, 'compacting'],
    ['审查轮次', { view: running([other('r', 'enteredReviewMode')]) }, 'review'],
    ['斜杠命令', { input: input('/compact') }, 'slash'],
  ])('%s时转入排队', (_name, patch, reason) => {
    expect(planSteer({ agent: 'codex', view: running(), input: input('补充'), ...patch })).toEqual({ route: 'queue', reason })
  })

  it('压缩完成或审查结束后可以继续引导；其他轮次的条目不影响', () => {
    expect(turnSteerBlock('codex', running([other('c', 'contextCompaction', 'completed')]))).toBeNull()
    expect(turnSteerBlock('codex', running([other('r', 'enteredReviewMode'), other('x', 'exitedReviewMode')]))).toBeNull()
    // 条目不属于当前一轮（turns 里没有它）。
    const view = { ...running([other('r', 'enteredReviewMode')]), turns: [] }
    expect(turnSteerBlock('codex', view)).toBeNull()
  })

  it('只有明确拒绝才算未送达', () => {
    expect(isSteerRejected(new CodexRpcError('no active turn', -32600))).toBe(true)
    expect(isSteerRejected(new CodexRpcError('invalid', -32602))).toBe(true)
    expect(isSteerRejected(new CodexRpcError('review', -32000, { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } }))).toBe(true)
    expect(isSteerRejected(new CodexRpcError('timeout', -32000))).toBe(false)
    expect(isSteerRejected(new CodexRpcError('internal', -32603))).toBe(false)
    expect(isSteerRejected(new Error('disposed'))).toBe(false)
  })
})
