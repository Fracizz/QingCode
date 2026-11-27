import { t } from '../../protocol/src/i18n'
import type { TurnStartParams } from './codex-types'

type AgentKind = 'codex' | 'claude' | 'pi'

// 会话与总控共用三档：请求批准（Agent 自身配置）、替我批准（自动审查）、完全访问。
export type AccessMode = 'default' | 'auto' | 'fullAccess'
export type AccessSelection = AccessMode | 'inherit'
export type GlobalAccessMode = AccessMode

type AccessOption = {
  mode: AccessMode
  label: string
  hint: string
  warning?: string
}

const askMode: AccessOption = { mode: 'default', label: t('请求批准'), hint: t('按 Agent 自身配置，需要时询问你') }

export const accessOptions: Record<AgentKind, readonly AccessOption[]> = {
  codex: [
    askMode,
    // Codex 官方 approvalsReviewer=auto_review：由审查子代理按风险代替用户审批。
    { mode: 'auto', label: t('替我批准'), hint: t('Codex 自动审查并决定是否批准') },
    {
      mode: 'fullAccess', label: t('完全访问'), hint: t('关闭沙箱和审批'),
      warning: t('Agent 将能够访问本会话所在主机上的文件、运行命令并访问网络，无需逐次审批。'),
    },
  ],
  claude: [
    askMode,
    // Claude SDK 原生的 auto 模式：分类器逐次判断，无法判断时仍走 canUseTool 由用户审批。
    { mode: 'auto', label: t('替我批准'), hint: t('分类器自动审批，无法判断时询问') },
    {
      mode: 'fullAccess', label: t('完全访问'), hint: t('跳过审批，工具直接执行'),
      warning: t('Agent 的工具将按 Claude 的跳过审批模式运行，无需逐次确认。'),
    },
  ],
  pi: [],
}

export function isGlobalAccessMode(value: unknown): value is GlobalAccessMode {
  return value === 'default' || value === 'auto' || value === 'fullAccess'
}

export function resolveAccessMode(agent: AgentKind, globalMode: GlobalAccessMode | undefined, selection: AccessSelection = 'inherit'): AccessMode {
  if (selection !== 'inherit') return selection
  if (agent === 'pi' || !globalMode) return 'default'
  return globalMode
}

type CodexAccessOverride = Required<Pick<TurnStartParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandboxPolicy'>> & {
  qingcodeAccessOverride: true
}

type ClaudeAccessOverride = { claudePermissionMode: 'auto' | 'bypassPermissions' }

export function turnAccessOverride(agent: AgentKind, mode: unknown): CodexAccessOverride | ClaudeAccessOverride | null {
  if (agent === 'codex' && mode === 'auto') {
    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      qingcodeAccessOverride: true,
    }
  }
  if (agent === 'codex' && mode === 'fullAccess') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, qingcodeAccessOverride: true }
  }
  if (agent === 'claude' && mode === 'auto') return { claudePermissionMode: 'auto' }
  if (agent === 'claude' && mode === 'fullAccess') return { claudePermissionMode: 'bypassPermissions' }
  return null
}
