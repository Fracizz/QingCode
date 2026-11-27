// mcpServer/elicitation/request（MCP 服务向用户索取信息）的纯逻辑。
// Codex 原生发出，Claude 由桥映射。表单转成问答卡片，无字段的请求按允许/拒绝处理。
import { t } from '../../protocol/src/i18n'
import type { UserInputOption, UserInputQuestion } from './userInput'

export const ELICITATION_METHOD = 'mcpServer/elicitation/request'

type JsonRecord = Record<string, unknown>
type Answers = Readonly<Record<string, readonly string[]>>
type Field = { question: UserInputQuestion; toValue(values: string[]): unknown }

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

// i18n-ignore: 回传匹配用常量，界面经 localizedOptions 翻译显示
const YES = '是'
// i18n-ignore: 同上
const NO = '否'

/** 枚举的几种官方写法：enum（可带 enumNames）、oneOf / anyOf 的 const + title。 */
function choices(schema: JsonRecord): { label: string; value: string }[] | null {
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
  const list = titled
    ? titled.map((entry) => ({ value: text(asRecord(entry)?.const), label: text(asRecord(entry)?.title) }))
    : Array.isArray(schema.enum)
      ? schema.enum.map((value, index) => ({ value: text(value), label: text(names[index]) }))
      : null
  if (!list?.length || list.some((entry) => !entry.value)) return null
  const labels = list.map((entry) => entry.label || entry.value)
  // 标题重复时无法按标题反查取值，改为直接显示取值。
  const unique = new Set(labels).size === labels.length
  return list.map((entry, index) => ({ value: entry.value, label: unique ? labels[index]! : entry.value }))
}

function field(key: string, schema: JsonRecord, required: boolean): Field | null {
  const title = text(schema.title)
  const build = (extra: Partial<UserInputQuestion>, options: UserInputOption[] = []): UserInputQuestion => ({
    id: key,
    header: title || key,
    question: text(schema.description) || title || key,
    isOther: options.length === 0,
    isSecret: false,
    multiSelect: false,
    options,
    ...(required ? {} : { optional: true }),
    ...extra,
  })
  const options = (list: { label: string }[]) => list.map(({ label }) => ({ label, description: '' }))
  if (schema.type === 'boolean') {
    return {
      question: build({ localizedOptions: true }, options([{ label: YES }, { label: NO }])),
      toValue: (values) => values[0] === YES,
    }
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return { question: build({ inputType: schema.type }), toValue: (values) => Number(values[0]) }
  }
  if (schema.type === 'array') {
    const list = choices(asRecord(schema.items) ?? {})
    if (!list) return null
    return {
      question: build({ multiSelect: true }, options(list)),
      toValue: (values) => values.flatMap((label) => list.find((entry) => entry.label === label)?.value ?? []),
    }
  }
  if (schema.type !== 'string') return null
  const list = choices(schema)
  if (list) {
    return {
      question: build({}, options(list)),
      toValue: (values) => list.find((entry) => entry.label === values[0])?.value,
    }
  }
  const prefill = text(schema.default)
  return { question: build(prefill ? { prefill } : {}), toValue: (values) => values[0] }
}

/** 可呈现的表单字段；必填字段里有认不出的类型时返回 null。 */
function formFields(params: unknown): Field[] | null {
  const data = asRecord(params)
  if (!data || data.mode === 'url') return []
  const schema = asRecord(data.requestedSchema)
  const properties = asRecord(schema?.properties)
  if (!schema || !properties) return null
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const fields: Field[] = []
  for (const [key, value] of Object.entries(properties)) {
    const parsed = field(key, asRecord(value) ?? {}, required.has(key))
    if (parsed) fields.push(parsed)
    else if (required.has(key)) return null
  }
  return fields
}

export function elicitationDetail(params: unknown): string {
  const data = asRecord(params)
  return [text(data?.serverName), text(data?.message), data?.mode === 'url' ? text(data.url) : '']
    .filter(Boolean)
    .join('\n') || t('需要用户处理')
}

export function elicitationView(params: unknown, detail: string):
  | { questions: UserInputQuestion[]; intro: string; skipLabel: string }
  | { decisions: ('accept' | 'decline')[] } {
  const fields = formFields(params)
  if (fields?.length) return { questions: fields.map((entry) => entry.question), intro: detail, skipLabel: t('拒绝') }
  return { decisions: fields ? ['accept', 'decline'] : ['decline'] }
}

export function elicitationDecision(accept: boolean) {
  return accept
    ? { action: 'accept' as const, content: {}, _meta: null }
    : { action: 'decline' as const, content: null, _meta: null }
}

/** 空对象表示用户拒绝；否则按表单字段类型组装 content，未填的可选字段不发送。 */
export function elicitationAnswer(params: unknown, answers: Answers) {
  const fields = formFields(params)
  if (!fields || !Object.keys(answers).length) return elicitationDecision(false)
  const content: JsonRecord = {}
  for (const { question, toValue } of fields) {
    const values = (answers[question.id] ?? []).map((value) => value.trim()).filter(Boolean)
    if (!values.length) continue
    const value = toValue(values)
    if (value !== undefined) content[question.id] = value
  }
  return { action: 'accept' as const, content, _meta: null }
}
