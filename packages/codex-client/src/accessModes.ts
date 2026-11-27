import type { TurnStartParams } from './codex-types'

type AgentKind = 'codex' | 'claude' | 'pi'

export type AccessMode = 'default' | 'readOnly' | 'fullAccess' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'
export type AccessSelection = AccessMode | 'inherit'
export type GlobalAccessMode = 'default' | 'restricted' | 'auto' | 'fullAccess'

type AccessOption<Mode extends AccessSelection = AccessMode> = {
  mode: Mode
  label: string
  hint: string
  warning?: string
}

const defaultMode: AccessOption = { mode: 'default', label: 'Agent 默认权限', hint: '使用 Agent 自身的配置' }

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
    // Claude SDK 原生的 auto 模式：分类器逐次判断，无法判断时仍走 canUseTool 由用户审批。
    { mode: 'auto', label: '自动', hint: '分类器自动审批，无法判断时询问' },
    { mode: 'plan', label: '计划模式', hint: '分析并制定计划' },
    { mode: 'acceptEdits', label: '接受编辑', hint: 'Agent 自动接受文件编辑' },
    {
      mode: 'bypassPermissions', label: '跳过审批', hint: '允许工具直接执行',
      warning: 'Agent 的工具将按 Claude 的跳过审批模式运行，无需逐次确认。',
    },
  ],
  pi: [],
}

export function isGlobalAccessMode(value: unknown): value is GlobalAccessMode {
  return value === 'default' || value === 'restricted' || value === 'auto' || value === 'fullAccess'
}

export function resolveAccessMode(agent: AgentKind, globalMode: GlobalAccessMode | undefined, selection: AccessSelection = 'inherit'): AccessMode {
  if (selection !== 'inherit') return selection
  if (globalMode === 'restricted') {
    if (agent === 'codex') return 'readOnly'
    if (agent === 'claude') return 'plan'
  }
  // Codex 没有对应的分类器审批档位，自动总控下沿用 Codex 自身配置。
  if (globalMode === 'auto' && agent === 'claude') return 'auto'
  if (globalMode === 'fullAccess') {
    if (agent === 'codex') return 'fullAccess'
    if (agent === 'claude') return 'bypassPermissions'
  }
  return 'default'
}

export function inheritedAccessOption(agent: AgentKind, mode: AccessMode): AccessOption<'inherit'> {
  const current = accessOptions[agent].find((option) => option.mode === mode)
  return { mode: 'inherit', label: '继承总控', hint: `当前为${current?.label ?? defaultMode.label}` }
}

type CodexAccessOverride = Required<Pick<TurnStartParams, 'approvalPolicy' | 'sandboxPolicy'>> & {
  qingcodeAccessOverride: true
}

type ClaudeAccessOverride = { claudePermissionMode: 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions' }

export function turnAccessOverride(agent: AgentKind, mode: unknown): CodexAccessOverride | ClaudeAccessOverride | null {
  if (agent === 'codex' && mode === 'readOnly') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, qingcodeAccessOverride: true }
  }
  if (agent === 'codex' && mode === 'fullAccess') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, qingcodeAccessOverride: true }
  }
  if (agent === 'claude' && (mode === 'auto' || mode === 'plan' || mode === 'acceptEdits' || mode === 'bypassPermissions')) {
    return { claudePermissionMode: mode }
  }
  return null
}
