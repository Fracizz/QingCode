/** canUseTool ↔ v2 审批 server request 的纯函数转换。 */
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { isBashTool, isFileEditTool } from './items'
import { asRecord, summarizeInput, type Json } from './v2'

export interface ApprovalRequestInput {
  requestId: string | number
  threadId: string
  turnId: string
  itemId: string
  toolName: string
  input: unknown
  reason?: string
  startedAtMs?: number
}

export interface ApprovalRequest {
  id: string | number
  method: string
  params: Json
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export function approvalMethod(toolName: string): string {
  return isFileEditTool(toolName) ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval'
}

export function buildApprovalRequest(input: ApprovalRequestInput): ApprovalRequest {
  const method = approvalMethod(input.toolName)
  const record = asRecord(input.input) ?? {}
  const common: Json = {
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    startedAtMs: input.startedAtMs ?? Date.now(),
    ...(input.reason ? { reason: input.reason } : {}),
  }
  if (method === 'item/fileChange/requestApproval') {
    const path =
      typeof record.file_path === 'string'
        ? record.file_path
        : typeof record.notebook_path === 'string'
          ? record.notebook_path
          : '(unknown)'
    return {
      id: input.requestId,
      method,
      params: { ...common, fileChanges: { [path]: { type: 'update' } }, grantRoot: input.reason ?? null },
    }
  }
  // 非 Bash 工具也走命令审批卡片，把工具名与参数摘要写成 command。
  const command = isBashTool(input.toolName)
    ? typeof record.command === 'string'
      ? record.command
      : `${input.toolName} ${summarizeInput(input.input)}`
    : `${input.toolName} ${summarizeInput(input.input)}`
  return {
    id: input.requestId,
    method,
    params: {
      ...common,
      kind: 'command',
      command,
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    },
  }
}

export function decisionFromResponse(response: unknown): ApprovalDecision {
  const envelope = asRecord(response)
  if (!envelope || 'error' in envelope) return 'decline'
  const decision = asRecord(envelope.result)?.decision ?? envelope.decision
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'cancel') {
    return decision
  }
  return 'decline'
}

/** SDK 的 suggestions 默认写入用户/项目设置；本会话允许统一改成 session。 */
export function sessionSuggestions(suggestions: unknown): PermissionUpdate[] {
  if (!Array.isArray(suggestions)) return []
  return suggestions
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Json => entry !== null)
    .map((entry) => ({ ...entry, destination: 'session' }) as unknown as PermissionUpdate)
}

export function permissionResult(response: unknown, suggestions?: unknown): PermissionResult {
  switch (decisionFromResponse(response)) {
    case 'accept':
      return { behavior: 'allow' }
    case 'acceptForSession':
      return { behavior: 'allow', updatedPermissions: sessionSuggestions(suggestions) }
    case 'cancel':
      return { behavior: 'deny', message: '用户拒绝', interrupt: true }
    default:
      return { behavior: 'deny', message: '用户拒绝' }
  }
}
