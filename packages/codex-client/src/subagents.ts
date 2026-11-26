import type { UserInput } from './codex-types'

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
}

const toolLabels: Readonly<Record<string, string>> = {
  spawnAgent: '启动子代理',
  sendInput: '向子代理发送消息',
  sendMessage: '向子代理发送消息',
  resumeAgent: '恢复子代理',
  followupTask: '继续子代理任务',
  wait: '等待子代理',
  closeAgent: '关闭子代理',
  interruptAgent: '中断子代理',
  listAgents: '列出子代理',
}

const callStatuses: Readonly<Record<string, string>> = {
  inProgress: '调用中',
  completed: '调用已返回',
  failed: '调用失败',
  interrupted: '调用已中断',
}

const activityStatuses: Readonly<Record<string, string>> = {
  started: '已启动',
  interacted: '已交互',
  interrupted: '已中断',
  completed: '已完成',
}

const agentStatuses: Readonly<Record<string, string>> = {
  pendingInit: '等待启动',
  running: '运行中',
  interrupted: '已中断',
  completed: '已完成',
  errored: '失败',
  shutdown: '已关闭',
  notFound: '未找到',
}

function label(labels: Readonly<Record<string, string>>, key: unknown): string {
  return typeof key === 'string' && Object.hasOwn(labels, key) ? labels[key] ?? '' : ''
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function describeSubagentItem(
  item: Record<string, unknown>,
  id: string,
): SubagentItemView | undefined {
  if (item.type === 'collabAgentToolCall') {
    const agents = record(item.agentsStates)
    const states = Object.entries(agents).map(([agentId, value]) => {
      const state = record(value)
      return [agentId, label(agentStatuses, state.status), state.message]
        .filter((part) => typeof part === 'string' && part)
        .join(' · ')
    })
    const detail = [item.prompt, ...states].filter((part) => typeof part === 'string' && part).join('\n')
    return {
      kind: 'subagent', id, title: label(toolLabels, item.tool) || '子代理协作',
      status: label(callStatuses, item.status), detail,
    }
  }
  if (item.type === 'subAgentActivity') {
    return {
      kind: 'subagent', id, title: '子代理',
      status: label(activityStatuses, item.kind),
      detail: typeof item.agentPath === 'string' ? item.agentPath : '',
    }
  }
  if (item.type === 'dynamicToolCall' && item.namespace === 'claude' && (item.tool === 'Agent' || item.tool === 'Task')) {
    const args = record(item.arguments)
    const detail = [args.subagent_type, args.description]
      .filter((part) => typeof part === 'string' && part)
      .join(' · ')
    return { kind: 'subagent', id, title: '委派给子代理', status: label(callStatuses, item.status), detail }
  }
}
