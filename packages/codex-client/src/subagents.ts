import { t } from '../../protocol/src/i18n'
import type { UserInput } from './codex-types'
import type { ItemView, ThreadView } from './conversation'
import { sessionStatus, sessionStatusLabels } from './threadStatus'

// i18n-ignore: 发给模型的委派请求
const REQUEST = '请将适合独立处理的部分委派给子代理，等待所需结果，再汇总完成本次请求。'

export function supportsSubagentRequests(agent: string): boolean {
  return agent === 'codex' || agent === 'claude'
}

export function requestSubagents(input: UserInput[]): UserInput[] {
  const index = input.findIndex((item) => item.type === 'text')
  const firstText = input[index]
  if (firstText?.type !== 'text') {
    return [...input, { type: 'text', text: REQUEST, text_elements: [] }]
  }
  // 在正文末尾追加，保留文件引用等文本元素的原始偏移。
  const result = [...input]
  result[index] = { ...firstText, text: firstText.text ? firstText.text + '\n\n' + REQUEST : REQUEST }
  return result
}

export type SubagentItemView = {
  kind: 'subagent'
  id: string
  title: string
  status: string
  detail: string
  name?: string
  role?: string
  model?: string
  result?: string
  agents?: { threadId: string; label: string; status: string; result: string }[]
}

export type SubagentThreadMetadata = {
  parentThreadId: string
  name: string
  role: string
  model: string
  task: string
}

export type SubagentEntry = {
  key: string
  threadId?: string
  name: string
  role: string
  model: string
  status: string
  task: string
  result: string
  activity: { id: string; title: string; status: string; detail?: string }[]
}

export function subagentStatusTone(status: string): 'active' | 'ok' | 'warn' | 'danger' | 'muted' {
  switch (status) {
    case t('运行中'): case t('已启动'): case t('等待启动'): case t('调用中'): return 'active'
    case t('待审批'): case t('待输入'): return 'warn'
    case t('已完成'): case t('调用已返回'): return 'ok'
    case t('失败'): case t('调用失败'): return 'danger'
    default: return 'muted'
  }
}

export function subagentRecordStatus(status: string, view?: ThreadView): string {
  const recorded = sessionStatus(view)
  if (recorded === 'idle' || (status && status !== t('已启动') && status !== t('等待启动'))) return status
  return sessionStatusLabels[recorded]
}

export function subagentThreadMetadata(thread: Record<string, unknown>): SubagentThreadMetadata | undefined {
  const parentThreadId = string(thread.parentThreadId)
  if (!parentThreadId || parentThreadId === thread.id) return undefined
  return {
    parentThreadId,
    name: string(thread.agentNickname) || string(thread.name),
    role: string(thread.agentRole),
    model: string(thread.model),
    task: string(thread.preview),
  }
}

function updateAgentStatus(entry: SubagentEntry, status: string) {
  // 启动和交互事件可能在更具体的运行状态之后出现。
  if (!status || status === activityStatuses.interacted) return
  if (status === activityStatuses.started && entry.status && entry.status !== agentStatuses.pendingInit) return
  entry.status = status
}

export function collectSubagents(
  items: readonly ItemView[],
  parentThreadId?: string,
  threads?: Readonly<Record<string, ThreadView>>,
): SubagentEntry[] {
  const entries = new Map<string, SubagentEntry>()
  const findThread = (threadId: string) => threads && Object.hasOwn(threads, threadId) ? threads[threadId] : undefined
  const getEntry = (key: string, threadId?: string) => {
    const existing = entries.get(key)
    if (existing) return existing
    const entry: SubagentEntry = { key, threadId, name: '', role: '', model: '', status: '', task: '', result: '', activity: [] }
    entries.set(key, entry)
    return entry
  }

  for (const item of items) {
    if (item.kind !== 'subagent') continue
    const title = item.title === t('子代理') ? activityTitles[item.status] ?? item.title : item.title
    const event = { id: item.id, title, status: item.status, detail: item.detail || undefined }
    if (item.agents?.length) {
      for (const agent of item.agents) {
        if (agent.threadId === parentThreadId) continue
        const knownParent = findThread(agent.threadId)?.subagent?.parentThreadId
        if (parentThreadId && knownParent && parentThreadId !== knownParent) continue
        const entry = getEntry(`thread:${agent.threadId}`, agent.threadId)
        entry.name ||= agent.label.split('/').filter(Boolean).at(-1) || ''
        entry.model ||= item.model || ''
        updateAgentStatus(entry, agent.status)
        if (item.title === toolLabels.spawnAgent) entry.task = item.detail || entry.task
        entry.result = agent.result || entry.result
        entry.activity.push(event)
      }
    } else if (item.title === t('子代理') && item.detail) {
      const entry = getEntry(`path:${item.detail}`)
      entry.name = item.detail.split('/').filter(Boolean).at(-1) || item.detail
      entry.model ||= item.model || ''
      updateAgentStatus(entry, item.status)
      entry.activity.push(event)
    } else if (item.role || item.result || item.title === t('委派给子代理') || item.title === toolLabels.spawnAgent || item.title === t('子代理')) {
      const entry = getEntry(`item:${item.id}`)
      entry.name = item.name || ''
      entry.role = item.role || ''
      entry.model = item.model || ''
      entry.task = item.detail
      entry.status = item.status
      entry.result = item.result || ''
      entry.activity.push(event)
    }
  }

  if (parentThreadId && threads) {
    for (const thread of Object.values(threads)) {
      if (thread.subagent?.parentThreadId === parentThreadId) getEntry(`thread:${thread.id}`, thread.id)
    }
  }

  return [...entries.values()].map((entry, index) => {
    const live = entry.threadId ? findThread(entry.threadId) : undefined
    const identity = live?.subagent
    const status = sessionStatus(live)
    return {
      ...entry,
      name: identity?.name || entry.name || identity?.role || entry.role || t('子代理 {index}', { index: index + 1 }),
      role: identity?.role || entry.role,
      model: identity?.model || entry.model,
      task: entry.task || identity?.task || '',
      status: status === 'idle' ? entry.status : sessionStatusLabels[status],
    }
  })
}

const toolLabels = {
  spawnAgent: t('启动子代理'),
  sendInput: t('向子代理发送消息'),
  sendMessage: t('向子代理发送消息'),
  resumeAgent: t('恢复子代理'),
  followupTask: t('继续子代理任务'),
  wait: t('等待子代理'),
  closeAgent: t('关闭子代理'),
  interruptAgent: t('中断子代理'),
  listAgents: t('列出子代理'),
}

const callStatuses: Readonly<Record<string, string>> = {
  inProgress: t('调用中'),
  completed: t('调用已返回'),
  failed: t('调用失败'),
  interrupted: t('调用已中断'),
}

const activityStatuses = {
  started: t('已启动'),
  interacted: t('已交互'),
  interrupted: t('已中断'),
  completed: t('已完成'),
}

const activityTitles: Readonly<Record<string, string>> = {
  [activityStatuses.started]: t('启动子代理'),
  [activityStatuses.interacted]: t('与子代理交互'),
  [activityStatuses.interrupted]: t('子代理中断'),
  [activityStatuses.completed]: t('子代理完成'),
}

const agentStatuses: Readonly<Record<string, string>> = {
  pendingInit: t('等待启动'),
  running: t('运行中'),
  interrupted: t('已中断'),
  completed: t('已完成'),
  errored: t('失败'),
  shutdown: t('已关闭'),
  notFound: t('未找到'),
}

function label(labels: Readonly<Record<string, string>>, key: unknown): string {
  return typeof key === 'string' && Object.hasOwn(labels, key) ? labels[key] ?? '' : ''
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function describeSubagentItem(
  item: Record<string, unknown>,
  id: string,
): SubagentItemView | undefined {
  if (item.type === 'collabAgentToolCall') {
    const states = record(item.agentsStates)
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(string).filter(Boolean) : []
    const agents = [...new Set([...receivers, ...Object.keys(states)])]
      .filter((threadId) => threadId && threadId !== item.senderThreadId)
      .map((threadId) => {
        const state = record(Object.hasOwn(states, threadId) ? states[threadId] : undefined)
        return { threadId, label: '', status: label(agentStatuses, state.status), result: string(state.message) }
      })
    return {
      kind: 'subagent', id, title: label(toolLabels, item.tool) || t('子代理协作'),
      status: label(callStatuses, item.status), detail: string(item.prompt),
      ...(string(item.model) ? { model: string(item.model) } : {}),
      ...(agents.length ? { agents } : {}),
    }
  }
  if (item.type === 'subAgentActivity') {
    const threadId = string(item.agentThreadId)
    const path = string(item.agentPath)
    const status = label(activityStatuses, item.kind)
    return {
      kind: 'subagent', id, title: t('子代理'), status, detail: threadId ? '' : path,
      ...(string(item.model) ? { model: string(item.model) } : {}),
      ...(threadId ? { agents: [{ threadId, label: path, status, result: '' }] } : {}),
    }
  }
  if (item.type === 'dynamicToolCall' && item.namespace === 'claude' && (item.tool === 'Agent' || item.tool === 'Task')) {
    const args = record(item.arguments)
    const description = [string(args.subagent_type), string(args.description)].filter(Boolean).join(' · ')
    const detail = [description, string(args.prompt)].filter(Boolean).join('\n\n')
    const result = Array.isArray(item.contentItems) ? item.contentItems.map((part: unknown) => {
      const block = record(part)
      return block.type === 'text' || block.type === 'inputText' ? string(block.text) : ''
    }).filter(Boolean).join('\n\n') : ''
    return {
      kind: 'subagent', id, title: t('委派给子代理'), status: label(callStatuses, item.status), detail,
      ...(string(args.description) ? { name: string(args.description) } : {}),
      ...(string(args.subagent_type) ? { role: string(args.subagent_type) } : {}),
      ...(result ? { result } : {}),
    }
  }
}
