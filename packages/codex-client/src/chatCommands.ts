export const chatCommands = [
  { id: 'help', name: 'help', description: '查看可用命令' },
  { id: 'new', name: 'new', description: '开始新会话' },
  { id: 'new', name: 'clear', description: '开始新会话，保留原会话历史' },
  { id: 'resume', name: 'resume', description: '切换已有会话' },
  { id: 'stop', name: 'stop', description: '停止当前运行' },
  { id: 'refresh', name: 'refresh', description: '刷新会话列表' },
  { id: 'compact', name: 'compact', description: '压缩当前会话的上下文' },
  { id: 'status', name: 'status', description: '查看账号额度与重置时间' },
  { id: 'status', name: 'usage', description: '查看账号额度与重置时间' },
  { id: 'status', name: 'quota', description: '查看账号额度与重置时间' },
  { id: 'context', name: 'context', description: '查看上下文或最近一轮用量' },
  { id: 'model', name: 'model', description: '选择模型和推理强度' },
  { id: 'permissions', name: 'permissions', description: '查看会话访问权限' },
  { id: 'copy', name: 'copy', description: '复制最近一条回复' },
  { id: 'diff', name: 'diff', description: '查看项目的 Git 差异' },
  { id: 'rename', name: 'rename', description: '重命名当前会话' },
  { id: 'fork', name: 'fork', description: '从当前会话创建分支' },
  { id: 'archive', name: 'archive', description: '归档当前会话' },
] as const

export type ChatCommand = (typeof chatCommands)[number]
export type ChatCommandId = ChatCommand['id']

export function chatCommandQuery(text: string): string | undefined {
  return /^\s*\/([\p{L}\p{N}-]*)$/u.exec(text)?.[1]?.toLowerCase()
}

export function exactChatCommand(text: string): ChatCommand | undefined {
  const name = chatCommandQuery(text.trim())
  return chatCommands.find((command) => command.name === (name === '' ? 'help' : name))
}

export function matchingChatCommands(query: string): ChatCommand[] {
  const matches = chatCommands.filter(({ name, description }) => name.includes(query) || description.includes(query))
  return query ? matches.sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query))) : matches
}

export function chatCommandUnavailable(id: ChatCommandId, state: {
  agent: 'codex' | 'claude' | 'pi'
  thread: boolean
  running: boolean
  busy: boolean
  compactBlocked: string | null
  hasReply: boolean
}): string | null {
  if (id === 'stop') {
    return state.running ? null : '当前没有运行中的轮次'
  }
  if (id === 'status' && state.agent === 'pi') return 'pi 暂无账号额度数据'
  if (id === 'fork' && state.agent !== 'codex') return '仅 Codex 支持创建会话分支'
  if (id === 'compact') return state.compactBlocked
  if (id === 'copy' && !state.hasReply) return '当前没有可复制的回复'
  if (id === 'archive' || id === 'rename' || id === 'fork') {
    if (!state.thread) return '请先打开会话'
    if (state.busy || state.running) return '请先等待当前操作结束'
  }
  return null
}
