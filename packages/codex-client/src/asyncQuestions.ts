import { parseUserInputQuestions, type UserInputQuestion } from './userInput'

const REPLY_START = '<send_user_message_question_reply>'
const REPLY_END = '</send_user_message_question_reply>'
const FIELD_BYTES = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

type AnsweredQuestion = {
  questionItemId: string
  question: string
  answer: string
}

export function parseAsyncQuestions(itemId: string, value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return []
  return parseUserInputQuestions({
    questions: value.map((entry: unknown, index) => {
      if (!entry || typeof entry !== 'object' || !('title' in entry) || typeof entry.title !== 'string') return null
      const options = 'options' in entry && Array.isArray(entry.options) ? entry.options : []
      return {
        id: JSON.stringify(['request_user_input_async', itemId, index]),
        question: entry.title,
        isOther: true,
        options: [...new Set(options)].map((label) => ({ label })),
      }
    }),
  })
}

/**
 * Codex CLI 的异步答案随普通用户输入发送，问题标识由消息 ID 与题目位置组成。
 * https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/context-fragments/src/answered_question.rs
 */
export function asyncQuestionReply(questions: readonly UserInputQuestion[], answers: Record<string, string[]>): string {
  const replies: AnsweredQuestion[] = []
  for (const { id, question } of questions) {
    const answer = answers[id]?.join('\n').trim()
    if (!answer) continue
    const title = decoder.decode(encoder.encode(question).subarray(0, FIELD_BYTES), { stream: true }).replace(/[\r\n]/g, ' ')
    decoder.decode()
    replies.push({ questionItemId: id, question: title, answer })
  }
  if (!replies.length) return ''
  if (replies.some(({ questionItemId }) => encoder.encode(questionItemId).length > FIELD_BYTES)) return formatAsyncQuestionReplies(replies)
  return `${REPLY_START}\n${JSON.stringify(replies)}\n${REPLY_END}`
}

export function parseAsyncQuestionReply(text: string): AnsweredQuestion[] | null {
  const value = text.trim()
  if (!value.startsWith(REPLY_START) || !value.endsWith(REPLY_END)) return null
  try {
    const decoded: unknown = JSON.parse(value.slice(REPLY_START.length, -REPLY_END.length))
    const entries = Array.isArray(decoded) ? decoded : [decoded]
    const replies = entries.filter((entry: unknown): entry is AnsweredQuestion =>
      entry !== null && typeof entry === 'object' &&
      'questionItemId' in entry && typeof entry.questionItemId === 'string' && entry.questionItemId !== '' &&
      'question' in entry && typeof entry.question === 'string' &&
      'answer' in entry && typeof entry.answer === 'string' && entry.answer.trim() !== '',
    )
    return replies.length === entries.length && replies.length > 0 ? replies : null
  } catch {
    return null
  }
}

export function formatAsyncQuestionReplies(replies: readonly AnsweredQuestion[]): string {
  return replies.map(({ question, answer }) => `> ${question}\n\n${answer}`).join('\n\n')
}

export function displayAsyncQuestionReply(text: string): string {
  const replies = parseAsyncQuestionReply(text)
  return replies ? formatAsyncQuestionReplies(replies) : text
}
