// item/tool/requestUserInput（Agent 向用户提问）的纯逻辑：解析问题、组装回答。
// Codex 计划模式、Claude 的 AskUserQuestion 与 pi 扩展对话框（后两者由 server 映射）共用这一请求；
// MCP elicitation 的表单也转成同一套问题。
import type { ToolRequestUserInputResponse } from './codex-types'

export const USER_INPUT_METHOD = 'item/tool/requestUserInput'

export type UserInputOption = { label: string; description: string }

export type UserInputQuestion = {
  id: string
  header: string
  question: string
  /** 允许自由输入（"其他"） */
  isOther: boolean
  isSecret: boolean
  /** 扩展字段：Claude AskUserQuestion 的多选；Codex 官方请求不带，按单选处理。 */
  multiSelect: boolean
  options: UserInputOption[]
  /** 以下为扩展字段，Codex 官方请求不带。 */
  optional?: boolean
  inputType?: 'number' | 'integer'
  multiline?: boolean
  prefill?: string
  /** 选项是固定文案，界面按当前语言显示，回传值不变。 */
  localizedOptions?: boolean
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 从请求参数里取出问题列表；格式不对的条目跳过，没有有效问题时返回空数组。 */
export function parseUserInputQuestions(params: unknown): UserInputQuestion[] {
  const list = asRecord(params)?.questions
  if (!Array.isArray(list)) return []
  const result: UserInputQuestion[] = []
  list.forEach((entry, index) => {
    const record = asRecord(entry)
    if (!record) return
    const question = text(record.question)
    if (!question) return
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => asRecord(option))
          .filter((option): option is JsonRecord => option !== null && text(option.label) !== '')
          .map((option) => ({ label: text(option.label), description: text(option.description) }))
      : []
    result.push({
      id: text(record.id) || `q${index}`,
      header: text(record.header),
      question,
      // 没有选项时只能自由输入。
      isOther: record.isOther === true || options.length === 0,
      isSecret: record.isSecret === true,
      multiSelect: record.multiSelect === true,
      options,
      ...(record.multiline === true ? { multiline: true } : {}),
      ...(text(record.prefill) ? { prefill: text(record.prefill) } : {}),
      ...(record.localizedOptions === true ? { localizedOptions: true } : {}),
    })
  })
  return result
}

/** 问题 id → 所选答案（选项 label 或自由输入文本）；空答案不发送。 */
export function userInputResponse(answers: Readonly<Record<string, readonly string[]>>): ToolRequestUserInputResponse {
  const result: ToolRequestUserInputResponse['answers'] = {}
  for (const [id, values] of Object.entries(answers)) {
    const cleaned = values.map((value) => value.trim()).filter(Boolean)
    if (cleaned.length > 0) result[id] = { answers: cleaned }
  }
  return { answers: result }
}

/** 必答题都有非空答案、数字题填的是数字时才允许提交。 */
export function userInputComplete(
  questions: readonly UserInputQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): boolean {
  return questions.length > 0 && questions.every((question) => {
    const values = (answers[question.id] ?? []).filter((value) => value.trim() !== '')
    if (!values.length) return question.optional === true
    if (!question.inputType) return true
    return values.every((value) => question.inputType === 'integer'
      ? Number.isSafeInteger(Number(value)) : Number.isFinite(Number(value)))
  })
}

/** 界面上单个问题的选择状态：选中的选项 + 自由输入；桌面与手机共用。 */
export type UserInputDraft = { picked: string[]; other: string }

export const EMPTY_USER_INPUT_DRAFT: UserInputDraft = { picked: [], other: '' }

/** 尚未改动时的草稿；带预填内容的问题以预填内容起步。 */
export function initialUserInputDraft(question: UserInputQuestion): UserInputDraft {
  return question.prefill ? { picked: [], other: question.prefill } : EMPTY_USER_INPUT_DRAFT
}

/** 点选项：多选切换；单选与自由输入互斥，再点一次取消。 */
export function pickUserInputOption(question: UserInputQuestion, draft: UserInputDraft, label: string): UserInputDraft {
  if (question.multiSelect) {
    const picked = draft.picked.includes(label) ? draft.picked.filter((item) => item !== label) : [...draft.picked, label]
    return { ...draft, picked }
  }
  return { picked: draft.picked[0] === label ? [] : [label], other: '' }
}

/** 填自由输入：单选时有内容就清掉已选选项。 */
export function typeUserInputOther(question: UserInputQuestion, draft: UserInputDraft, other: string): UserInputDraft {
  return { picked: question.multiSelect || !other.trim() ? draft.picked : [], other }
}

/** 各问题草稿 → 答案表（选项在前，自由输入在后）。 */
export function userInputAnswers(
  questions: readonly UserInputQuestion[],
  drafts: Readonly<Record<string, UserInputDraft>>,
): Record<string, string[]> {
  return Object.fromEntries(questions.map((question) => {
    const draft = drafts[question.id] ?? initialUserInputDraft(question)
    return [question.id, [...draft.picked, ...(draft.other.trim() ? [draft.other.trim()] : [])]]
  }))
}
