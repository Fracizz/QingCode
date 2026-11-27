import { t } from '../../protocol/src/i18n'

export const chatCommands = [
  { id: 'help', name: 'help', description: t('查看可用命令') },
  { id: 'new', name: 'new', description: t('开始新会话') },
  { id: 'new', name: 'clear', description: t('开始新会话，保留原会话历史') },
  { id: 'resume', name: 'resume', description: t('切换已有会话') },
  { id: 'stop', name: 'stop', description: t('停止当前运行') },
  { id: 'refresh', name: 'refresh', description: t('刷新会话列表') },
  { id: 'compact', name: 'compact', description: t('压缩当前会话的上下文') },
  { id: 'status', name: 'status', description: t('查看账号额度与重置时间') },
  { id: 'status', name: 'usage', description: t('查看账号额度与重置时间') },
  { id: 'status', name: 'quota', description: t('查看账号额度与重置时间') },
  { id: 'context', name: 'context', description: t('查看上下文或最近一轮用量') },
  { id: 'model', name: 'model', description: t('选择模型和推理强度') },
  { id: 'permissions', name: 'permissions', description: t('查看会话访问权限') },
  { id: 'copy', name: 'copy', description: t('复制最近一条回复') },
  { id: 'diff', name: 'diff', description: t('查看项目的 Git 差异') },
  { id: 'rename', name: 'rename', description: t('重命名当前会话') },
  { id: 'fork', name: 'fork', description: t('从当前会话创建分支') },
  { id: 'archive', name: 'archive', description: t('归档当前会话') },
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
  const matches = chatCommands.filter(({ name, description }) => name.includes(query) || description.toLowerCase().includes(query))
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
    return state.running ? null : t('当前没有运行中的轮次')
  }
  if (id === 'status' && state.agent === 'pi') return t('pi 暂无账号额度数据')
  if (id === 'fork' && state.agent !== 'codex') return t('仅 Codex 支持创建会话分支')
  if (id === 'compact') return state.compactBlocked
  if (id === 'copy' && !state.hasReply) return t('当前没有可复制的回复')
  if (id === 'archive' || id === 'rename' || id === 'fork') {
    if (!state.thread) return t('请先打开会话')
    if (state.busy || state.running) return t('请先等待当前操作结束')
  }
  return null
}
