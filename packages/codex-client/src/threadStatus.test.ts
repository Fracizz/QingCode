import { describe, expect, it } from 'vitest'
import { sessionStatus } from './threadStatus'

describe('sessionStatus', () => {
  const view = (pendingApprovals: unknown[]) => ({ status: 'running' as const, activity: 'running' as const, pendingApprovals })

  it('只剩 Agent 提问时显示待回答，而不是待审批', () => {
    expect(sessionStatus(view([{ questions: [{ id: 'q' }] }]))).toBe('input')
  })

  it('有任一真正的审批时仍显示待审批', () => {
    expect(sessionStatus(view([{ questions: [{ id: 'q' }] }, { kind: 'command' }]))).toBe('pending')
    expect(sessionStatus(view([{ questions: [] }]))).toBe('pending')
  })
})
