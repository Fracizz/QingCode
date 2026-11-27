import type { TurnStartParams } from '@qn/codex-client'
import type { AgentKind } from '../../../../shared/backendApi'

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

export type AccessAddress = { targetId: string; agent: AgentKind; threadId: string | null }

export type AccessMemory = {
  draftRevision: number
  draft: { key: string; mode: AccessMode } | null
  modes: Record<string, AccessMode>
}

export const emptyAccessMemory: AccessMemory = { draftRevision: 0, draft: null, modes: {} }

export const accessKey = ({ targetId, agent, threadId }: AccessAddress) =>
  JSON.stringify([targetId, agent, threadId])

export function getAccessMode(memory: AccessMemory, address: AccessAddress): AccessMode {
  const key = accessKey(address)
  if (address.threadId === null) return memory.draft?.key === key ? memory.draft.mode : 'default'
  return memory.modes[key] ?? 'default'
}

export function rememberAccessMode(memory: AccessMemory, address: AccessAddress, mode: AccessMode): AccessMemory {
  if (mode !== 'default' && !accessOptions[address.agent].some((option) => option.mode === mode)) return memory
  const key = accessKey(address)
  if (address.threadId === null) return { ...memory, draft: mode === 'default' ? null : { key, mode } }
  const modes = { ...memory.modes }
  if (mode === 'default') delete modes[key]
  else modes[key] = mode
  return { ...memory, modes }
}

export function resetDraftAccess(memory: AccessMemory): AccessMemory {
  return { ...memory, draft: null, draftRevision: memory.draftRevision + 1 }
}

export function targetAgentKeyPrefix(targetId: string, agent: AgentKind): string {
  return `${JSON.stringify([targetId, agent]).slice(0, -1)},`
}

export function resetTargetAccess(memory: AccessMemory, targetId: string, agent: AgentKind): AccessMemory {
  const prefix = targetAgentKeyPrefix(targetId, agent)
  return { ...memory, modes: Object.fromEntries(Object.entries(memory.modes).filter(([key]) => !key.startsWith(prefix))) }
}

type CodexAccessOverride = Required<Pick<TurnStartParams, 'approvalPolicy' | 'sandboxPolicy'>> & {
  qingcodeAccessOverride: true
}

type ClaudeAccessOverride = { claudePermissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions' }

export function turnAccessOverride(agent: AgentKind, mode: AccessMode): CodexAccessOverride | ClaudeAccessOverride | null {
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
