import { describe, expect, it } from 'vitest'
import { askUserResult, buildUserInputRequest } from './askUser'

const input = {
  questions: [
    { question: '用哪个方案？', header: '方案', multiSelect: false, options: [{ label: 'A', description: '甲' }, { label: 'B', description: '乙' }] },
    { question: '启用哪些功能？', header: '功能', multiSelect: true, options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] },
  ],
}

describe('AskUserQuestion 映射', () => {
  it('转换为 item/tool/requestUserInput', () => {
    const request = buildUserInputRequest({ requestId: 'r1', threadId: 't', turnId: 'u', itemId: 'i', input })
    expect(request.method).toBe('item/tool/requestUserInput')
    expect(request.params).toMatchObject({
      threadId: 't',
      isBlocking: true,
      questions: [
        { id: 'q0', question: '用哪个方案？', header: '方案', isOther: true, multiSelect: false, options: [{ label: 'A', description: '甲' }, { label: 'B', description: '乙' }] },
        { id: 'q1', multiSelect: true },
      ],
    })
  })

  it('回答按问题原文回填 updatedInput.answers，多选用逗号连接', () => {
    const result = askUserResult({ id: 'r1', result: { answers: { q0: { answers: ['B'] }, q1: { answers: ['X', '自定义'] } } } }, input)
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { '用哪个方案？': 'B', '启用哪些功能？': 'X, 自定义' } },
    })
  })

  it('跳过或出错时拒绝', () => {
    expect(askUserResult({ id: 'r1', result: { answers: {} } }, input).behavior).toBe('deny')
    expect(askUserResult({ id: 'r1', error: { code: 1, message: 'x' } }, input).behavior).toBe('deny')
  })
})
