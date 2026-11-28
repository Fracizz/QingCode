import { asRecord, type Json } from './v2'

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function taskStatus(value: unknown) {
  if (value === 'killed') return 'stopped'
  return value === 'completed' || value === 'failed' || value === 'stopped' ? value : undefined
}

export function sdkTaskNotification(message: Json) {
  const taskId = text(message.task_id)
  const status = taskStatus(message.status)
  if (!taskId || !status || message.ambient === true || message.skip_transcript === true) return undefined
  return { taskId, status, summary: text(message.summary), result: '', runId: text(message.run_id) }
}

/** 旧版历史只提供用户形状的文本，必须匹配整条通知，避免改写混有正常输入的消息。 */
export function userTaskNotification(message: Json) {
  const origin = asRecord(message.origin)
  if (origin && (origin.kind !== 'task-notification' || origin.subkind)) return undefined
  const content = asRecord(message.message)?.content ?? message.content
  const block = Array.isArray(content) && content.length === 1 ? asRecord(content[0]) : null
  let body = text(block?.type === 'text' ? block.text : content)
  const open = '<task-notification>'
  const close = '</task-notification>'
  // 带来源的新版投递可能在通知前附带一段给模型看的说明。
  if (!body.startsWith(open) && origin?.kind === 'task-notification') {
    const start = body.indexOf(open)
    if (start >= 0) body = body.slice(start)
  }
  if (!body.startsWith(open) || !body.endsWith(close)) return undefined
  const fields = new Map<string, string>()
  let remaining = body.slice(open.length, -close.length).trim()
  // 子代理通知末尾附带用量统计，界面不展示。
  const usage = remaining.endsWith('</usage>') ? remaining.lastIndexOf('<usage>') : -1
  if (usage >= 0) remaining = remaining.slice(0, usage).trimEnd()
  while (remaining) {
    const tag = /^<(task-id|tool-use-id|output-file|status|summary|note|result|event)>/.exec(remaining)?.[1]
    if (!tag || fields.has(tag)) return undefined
    const endTag = `</${tag}>`
    // 正文是任意 Markdown，可以引用标签。结束位置取最外层的闭合标签。
    const freeform = tag === 'result' || tag === 'event'
    const end = freeform ? remaining.lastIndexOf(endTag) : remaining.indexOf(endTag)
    if (end < 0) return undefined
    const raw = remaining.slice(tag.length + 2, end)
    const value = freeform && raw.trim() ? raw : raw.trim()
    if (!freeform && (value.includes(open) || value.includes(close))) return undefined
    fields.set(tag, value)
    remaining = remaining.slice(end + endTag.length).trimStart()
    if (freeform && remaining) return undefined
  }
  const taskId = fields.get('task-id')
  const event = fields.get('event')
  // 监视任务推送的事件没有结束状态。
  const status = fields.has('status') ? taskStatus(fields.get('status')) : event === undefined ? undefined : 'event' as const
  const summary = fields.get('summary')
  if (!taskId || !status || !summary) return undefined
  return { taskId, status, summary, result: fields.get('result') ?? event ?? '', runId: text(origin?.runId) }
}

export type TaskNotification = NonNullable<ReturnType<typeof userTaskNotification>>
