/**
 * Claude 的计划 / TODO 工具（TodoWrite、TaskCreate、TaskUpdate、TaskList）→ v2 TurnPlanStep（纯函数）。
 * 实时消息带结构化的 tool_use_result；SDK 历史接口不返回它，历史回放只能读 tool_result 正文。
 */
import { asRecord, scalarText } from './v2'

export type PlanStepStatus = 'pending' | 'inProgress' | 'completed'

export interface PlanStep {
  step: string
  status: PlanStepStatus
}

/** 任务清单按会话累积：TaskUpdate 只带 ID，须跨轮保留。更新时返回新对象。 */
export interface PlanTracker {
  tasks: ReadonlyMap<string, PlanStep>
  /** 等待结果的计划工具调用；结果成功才应用。 */
  calls: ReadonlyMap<string, { name: string; input: unknown }>
}

export interface PlanToolResult {
  failed: boolean
  text: string
  structured?: unknown
}

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])

export function emptyPlan(): PlanTracker {
  return { tasks: new Map(), calls: new Map() }
}

export function planSteps(tracker: PlanTracker): PlanStep[] {
  return [...tracker.tasks.values()]
}

export function trackPlanCall(tracker: PlanTracker, toolId: string, name: string, input: unknown): PlanTracker {
  if (!PLAN_TOOLS.has(name)) return tracker
  return { tasks: tracker.tasks, calls: new Map(tracker.calls).set(toolId, { name, input }) }
}

/** plan 为 null 表示清单没有变化，否则是变化后的完整清单。 */
export function applyPlanResult(
  tracker: PlanTracker,
  toolId: string,
  result: PlanToolResult,
): { tracker: PlanTracker; plan: PlanStep[] | null } {
  const call = tracker.calls.get(toolId)
  if (!call) return { tracker, plan: null }
  const calls = new Map(tracker.calls)
  calls.delete(toolId)
  const output = asRecord(result.structured)
  const tasks = result.failed || output?.success === false
    ? null
    : nextTasks(tracker.tasks, call.name, asRecord(call.input) ?? {}, output, result.text.trim())
  if (!tasks) return { tracker: { tasks: tracker.tasks, calls }, plan: null }
  const next = { tasks, calls }
  return { tracker: next, plan: planSteps(next) }
}

function stepStatus(value: unknown): PlanStepStatus {
  if (value === 'completed') return 'completed'
  return value === 'in_progress' ? 'inProgress' : 'pending'
}

function nextTasks(
  tasks: ReadonlyMap<string, PlanStep>,
  name: string,
  input: Record<string, unknown>,
  output: Record<string, unknown> | null,
  text: string,
): Map<string, PlanStep> | null {
  if (name === 'TodoWrite') {
    if (!Array.isArray(input.todos)) return null
    const next = new Map<string, PlanStep>()
    input.todos.forEach((raw, index) => {
      const todo = asRecord(raw)
      const step = scalarText(todo?.content)
      if (step) next.set(`todo:${index}`, { step, status: stepStatus(todo?.status) })
    })
    return next
  }
  if (name === 'TaskCreate') {
    const created = asRecord(output?.task)
    const id = scalarText(created?.id) || /^Task #(\S+) created/i.exec(text)?.[1]
    const step = scalarText(created?.subject) || scalarText(input.subject)
    return id && step ? new Map(tasks).set(id, { step, status: 'pending' }) : null
  }
  if (name === 'TaskUpdate') return updatedTasks(tasks, input, output, text)
  return listedTasks(tasks, output, text)
}

function updatedTasks(
  tasks: ReadonlyMap<string, PlanStep>,
  input: Record<string, unknown>,
  output: Record<string, unknown> | null,
  text: string,
): Map<string, PlanStep> | null {
  // 部分失败以普通正文返回，没有结构化结果时按开头识别。
  if (!output && /^(?:error|failed|task (?:#\S+ )?not found)/i.test(text)) return null
  const id = scalarText(input.taskId) || scalarText(output?.taskId)
  const current = tasks.get(id)
  if (!id) return null
  if (input.status === 'deleted') {
    if (!current) return null
    const next = new Map(tasks)
    next.delete(id)
    return next
  }
  const step = scalarText(input.subject) || current?.step
  // 清单里没有且没带标题的任务无法展示。
  if (!step) return null
  const status = input.status === undefined ? current?.status ?? 'pending' : stepStatus(input.status)
  if (current && current.step === step && current.status === status) return null
  return new Map(tasks).set(id, { step, status })
}

function listedTasks(
  tasks: ReadonlyMap<string, PlanStep>,
  output: Record<string, unknown> | null,
  text: string,
): Map<string, PlanStep> | null {
  const rows: { id: string; step: string; status: PlanStepStatus }[] = []
  if (Array.isArray(output?.tasks)) {
    for (const raw of output.tasks) {
      const task = asRecord(raw)
      const id = scalarText(task?.id)
      const step = scalarText(task?.subject)
      if (id && step) rows.push({ id, step, status: stepStatus(task?.status) })
    }
  } else {
    for (const line of text.split('\n')) {
      const match = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/.exec(line.trim())
      if (!match) continue
      const [, id = '', status, rest = ''] = match
      // 正文行尾可能附带负责人和依赖说明，已知任务沿用原标题。
      const step = tasks.get(id)?.step ?? rest.replace(/ \[blocked by [^\]]*\]$/, '')
      rows.push({ id, step, status: stepStatus(status) })
    }
    if (rows.length === 0 && !/^no tasks/i.test(text)) return null
  }
  const next = new Map(rows.map(({ id, step, status }) => [id, { step, status }]))
  const same = next.size === tasks.size && [...next].every(([id, value]) => {
    const previous = tasks.get(id)
    return previous?.step === value.step && previous.status === value.status
  })
  return same ? null : next
}
