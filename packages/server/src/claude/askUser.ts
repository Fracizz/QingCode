/**
 * Claude AskUserQuestion ↔ v2 item/tool/requestUserInput 的纯函数转换。
 * AskUserQuestion 不是权限审批：它要用户给出答案，SDK 约定在 canUseTool 里用 updatedInput.answers 回填
 * （键为问题原文，多选答案用 ", " 连接）。若按普通审批"允许"，CLI 拿不到答案。
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { asRecord, type Json } from './v2'

export const ASK_USER_TOOL = 'AskUserQuestion'
export const USER_INPUT_METHOD = 'item/tool/requestUserInput'

export interface AskUserRequestInput {
  requestId: string | number
  threadId: string
  turnId: string
  itemId: string
  input: unknown
}

interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

function questionsOf(input: unknown): AskQuestion[] {
  const list = asRecord(input)?.questions
  if (!Array.isArray(list)) return []
  const result: AskQuestion[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    if (!record || typeof record.question !== 'string' || !record.question) continue
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => asRecord(option))
          .filter((option): option is Json => option !== null && typeof option.label === 'string')
          .map((option) => ({
            label: option.label as string,
            description: typeof option.description === 'string' ? option.description : '',
          }))
      : []
    result.push({
      question: record.question,
      header: typeof record.header === 'string' ? record.header : '',
      multiSelect: record.multiSelect === true,
      options,
    })
  }
  return result
}

const questionId = (index: number) => `q${index}`

export function buildUserInputRequest(input: AskUserRequestInput): { id: string | number; method: string; params: Json } {
  return {
    id: input.requestId,
    method: USER_INPUT_METHOD,
    params: {
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
      // Claude 会自动提供"其他"选项，这里对应 isOther；multiSelect 是官方结构之外的扩展字段，旧客户端按单选处理。
      questions: questionsOf(input.input).map((question, index) => ({
        id: questionId(index),
        header: question.header,
        question: question.question,
        isOther: true,
        isSecret: false,
        multiSelect: question.multiSelect,
        options: question.options,
      })),
      isBlocking: true,
      autoResolutionMs: null,
    },
  }
}

/** 客户端回答 → canUseTool 结果；出错或一个都没答时拒绝，让模型知道用户没有回答。 */
export function askUserResult(response: unknown, input: Record<string, unknown>): PermissionResult {
  const envelope = asRecord(response)
  const result = envelope && !('error' in envelope) ? (asRecord(envelope.result) ?? envelope) : null
  const supplied = asRecord(result?.answers)
  const answers: Record<string, string> = {}
  questionsOf(input).forEach((question, index) => {
    const values = asRecord(supplied?.[questionId(index)])?.answers
    if (!Array.isArray(values)) return
    const text = values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    if (text.length > 0) answers[question.question] = text.join(', ')
  })
  if (Object.keys(answers).length === 0) {
    return { behavior: 'deny', message: '用户跳过了这些问题，未作回答' } // i18n-ignore: 回给模型的说明
  }
  return { behavior: 'allow', updatedInput: { ...input, answers } }
}
