import { describe, expect, it } from 'vitest'
import { applyServerRequest, approvalResponse, emptyState, userAnswerResponse, type ApprovalView } from './conversation'
import { userInputAnswers, userInputComplete } from './userInput'

function request(params: Record<string, unknown>): ApprovalView {
  const state = applyServerRequest(emptyState(), {
    id: 1,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 't', turnId: null, serverName: '服务', message: '说明', ...params },
  } as never)
  return state.threads.t!.pendingApprovals[0]!
}

const form = (properties: Record<string, unknown>, required: string[] = []) =>
  request({ mode: 'form', requestedSchema: { type: 'object', properties, required } })

describe('MCP elicitation', () => {
  it('轮次之外的请求不把会话改成运行中', () => {
    const state = applyServerRequest(emptyState(), {
      id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 't', turnId: null },
    } as never)
    expect(state.threads.t!.status).toBe('idle')
  })

  it('无字段的请求只提供允许与拒绝', () => {
    const approval = form({})
    expect(approval.decisions).toEqual(['accept', 'decline'])
    expect(approvalResponse(approval, 'accept')).toEqual({ action: 'accept', content: {}, _meta: null })
    expect(approvalResponse(approval, 'decline')).toEqual({ action: 'decline', content: null, _meta: null })
    expect(approvalResponse(approval, 'acceptForSession')).toMatchObject({ action: 'decline' })
  })

  it('表单按字段类型组装回答，空回答表示拒绝', () => {
    const approval = form({
      name: { type: 'string' },
      count: { type: 'integer' },
      agree: { type: 'boolean' },
      color: { type: 'string', oneOf: [{ const: 'r', title: '红' }, { const: 'g', title: '绿' }] },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      note: { type: 'string' },
    }, ['name', 'count'])
    const questions = approval.questions!
    expect(userInputComplete(questions, { name: ['甲'], count: ['1.5'] })).toBe(false)
    expect(userInputComplete(questions, { name: ['甲'], count: ['2'] })).toBe(true)
    expect(userAnswerResponse(approval, {
      ...userInputAnswers(questions, {}), name: ['甲'], count: ['2'], agree: ['否'], color: ['绿'], tags: ['a', 'b'],
    })).toEqual({ action: 'accept', content: { name: '甲', count: 2, agree: false, color: 'g', tags: ['a', 'b'] }, _meta: null })
    expect(userAnswerResponse(approval, {})).toMatchObject({ action: 'decline' })
  })

  it('认不出的必填字段与网址请求按各自能力处理', () => {
    expect(form({ blob: { type: 'object' } }, ['blob']).decisions).toEqual(['decline'])
    const url = request({ mode: 'url', url: 'https://example.com/a', elicitationId: 'e' })
    expect(url.decisions).toEqual(['accept', 'decline'])
    expect(url.detail).toContain('https://example.com/a')
  })
})
