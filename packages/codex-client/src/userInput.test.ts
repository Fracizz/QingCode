import { describe, expect, it } from 'vitest'
import { applyServerRequest, emptyState } from './conversation'
import type { ServerRequest } from './codex-types'
import { EMPTY_USER_INPUT_DRAFT, parseUserInputQuestions, pickUserInputOption, typeUserInputOther, userInputAnswers, userInputComplete, userInputResponse } from './userInput'

describe('requestUserInput', () => {
  const params = {
    threadId: 't1',
    turnId: 'u1',
    itemId: 'i1',
    isBlocking: true,
    questions: [
      { id: 'a', header: 'H', question: '选哪个？', isOther: false, isSecret: false, options: [{ label: '甲', description: '' }] },
      { header: '', question: '名字？', options: null },
    ],
  }

  it('解析问题，无选项时允许自由输入', () => {
    const questions = parseUserInputQuestions(params)
    expect(questions.map((q) => [q.id, q.isOther, q.multiSelect, q.options.length])).toEqual([
      ['a', false, false, 1],
      ['q1', true, false, 0],
    ])
  })

  it('进入待处理列表并携带问题', () => {
    const state = applyServerRequest(emptyState(), { id: 3, method: 'item/tool/requestUserInput', params } as unknown as ServerRequest)
    const approval = state.threads.t1?.pendingApprovals[0]
    expect(approval?.questions).toHaveLength(2)
    expect(approval?.detail).toBe('选哪个？\n名字？')
  })

  it('组装回答并校验完整性', () => {
    const questions = parseUserInputQuestions(params)
    expect(userInputComplete(questions, { a: ['甲'] })).toBe(false)
    expect(userInputComplete(questions, { a: ['甲'], q1: [' 张三 '] })).toBe(true)
    expect(userInputResponse({ a: ['甲'], q1: [' 张三 ', ''], q2: [] })).toEqual({ answers: { a: { answers: ['甲'] }, q1: { answers: ['张三'] } } })
  })
})

describe('问答草稿', () => {
  const [single] = parseUserInputQuestions({ questions: [{ id: 's', question: '单选？', isOther: true, options: [{ label: 'A' }, { label: 'B' }] }] })
  const [multi] = parseUserInputQuestions({ questions: [{ id: 'm', question: '多选？', isOther: true, multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] })

  it('单选：选项与自由输入互斥，重复点击取消', () => {
    let draft = pickUserInputOption(single!, EMPTY_USER_INPUT_DRAFT, 'A')
    draft = pickUserInputOption(single!, draft, 'B')
    expect(draft.picked).toEqual(['B'])
    draft = typeUserInputOther(single!, draft, '自定义')
    expect(draft).toEqual({ picked: [], other: '自定义' })
    draft = pickUserInputOption(single!, draft, 'A')
    expect(draft).toEqual({ picked: ['A'], other: '' })
    expect(pickUserInputOption(single!, draft, 'A').picked).toEqual([])
  })

  it('多选：累加选项并保留自由输入', () => {
    let draft = pickUserInputOption(multi!, EMPTY_USER_INPUT_DRAFT, 'A')
    draft = pickUserInputOption(multi!, draft, 'B')
    draft = typeUserInputOther(multi!, draft, ' C ')
    expect(userInputAnswers([multi!], { m: draft })).toEqual({ m: ['A', 'B', 'C'] })
    expect(pickUserInputOption(multi!, draft, 'A').picked).toEqual(['B'])
  })
})
