import type { TurnStartParams } from './codex-types'

type AgentKind = 'codex' | 'claude' | 'pi'

export type AccessMode = 'default' | 'readOnly' | 'fullAccess' | 'plan' | 'acceptEdits' | 'bypassPermissions'

type AccessOption = {
  mode: AccessMode
  label: string
  hint: string
  warning?: string
}

const defaultMode: AccessOption = { mode: 'default', label: '默认权限', hint: '沿用 Agent 默认权限' }

export const accessOptions: Record<AgentKind, readonly AccessOption[]> = {
  codex: [
    defaultMode,
    { mode: 'readOnly', label: '只读', hint: '禁止写入和网络访问' },
    {
      mode: 'fullAccess', label: '完全访问', hint: '关闭沙箱和审批',
      warning: 'Agent 将能够访问本会话所在主机上的文件、运行命令并访问网络，无需逐次审批。',
    },
  ],
  claude: [
    defaultMode,
    { mode: 'plan', label: '计划模式', hint: '分析并制定计划' },
    { mode: 'acceptEdits', label: '接受编辑', hint: 'Agent 自动接受文件编辑' },
    {
      mode: 'bypassPermissions', label: '跳过审批', hint: '允许工具直接执行',
      warning: 'Agent 的工具将按 Claude 的跳过审批模式运行，无需逐次确认。',
    },
  ],
  pi: [],
}

type CodexAccessOverride = Required<Pick<TurnStartParams, 'approvalPolicy' | 'sandboxPolicy'>> & {
  qingcodeAccessOverride: true
}

type ClaudeAccessOverride = { claudePermissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions' }

export function turnAccessOverride(agent: AgentKind, mode: unknown): CodexAccessOverride | ClaudeAccessOverride | null {
  if (agent === 'codex' && mode === 'readOnly') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, qingcodeAccessOverride: true }
  }
  if (agent === 'codex' && mode === 'fullAccess') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, qingcodeAccessOverride: true }
  }
  if (agent === 'claude' && (mode === 'plan' || mode === 'acceptEdits' || mode === 'bypassPermissions')) {
    return { claudePermissionMode: mode }
  }
  return null
}
