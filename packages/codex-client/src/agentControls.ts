// qingcode/* 扩展请求：后台任务、原生斜杠命令与文件回滚。入口按 AGENT_CAPABILITIES 决定是否提供。

import { t } from '../../protocol/src/i18n'
import type { AgentKind } from '../../protocol/src/messages'
import type { CodexRpcLike } from './api'
import { chatCommands } from './chatCommands'
import type { ListMcpServerStatusResponse } from './codex-types'

export type BackgroundTaskView = { id: string; type: string; description: string }

export type SlashCommandView = { name: string; description: string; argumentHint?: string }

export type FileRewindResult = {
  canRewind: boolean
  filesChanged: string[]
  insertions: number
  deletions: number
  /** canRewind 为 true 时也可能带有（部分文件被跳过）。 */
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => typeof value === 'string' ? value : ''

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

export type McpServerView = { name: string; status: string; toolCount?: number; environmentId?: string }

export function supportsMcpStatus(openResult: unknown): boolean {
  return isRecord(openResult) && isRecord(openResult.capabilities) && openResult.capabilities.mcpStatus === true
}

/** null 表示没有可查询的会话进程，空列表表示已查到当前会话没有 MCP 服务。 */
export async function listMcpStatus(rpc: CodexRpcLike, agent: AgentKind, threadId: string): Promise<McpServerView[] | null> {
  if (agent === 'claude') {
    const result = await rpc.request('qingcode/mcp/status', { threadId })
    if (!result?.available) return null
    return Array.isArray(result.servers) ? result.servers.flatMap((value): McpServerView[] => {
      if (!isRecord(value) || !text(value.name)) return []
      return [{ name: text(value.name), status: text(value.status),
        ...(typeof value.toolCount === 'number' ? { toolCount: count(value.toolCount) } : {}) }]
    }) : []
  }
  if (agent !== 'codex') return null
  const servers: McpServerView[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const result: ListMcpServerStatusResponse = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', cursor })
    for (const server of result?.data ?? []) {
      if (!server?.name) continue
      servers.push({
        name: server.name,
        status: server.runtimeStatus ?? (server.authStatus === 'notLoggedIn' ? 'authenticationRequired' : ''),
        ...(server.tools && !server.toolsError ? { toolCount: Object.keys(server.tools).length } : {}),
        ...(server.environmentId ? { environmentId: server.environmentId } : {}),
      })
    }
    cursor = result?.nextCursor ?? null
    if (cursor && cursors.has(cursor)) throw new Error(t('无法读取 MCP 服务状态'))
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return servers
}

export function mcpStatusLabel(status: string): string {
  switch (status) {
    case 'connected': return t('已连接')
    case 'failed': return t('失败')
    case 'needs-auth':
    case 'authenticationRequired': return t('需要认证')
    case 'pending':
    case 'starting': return t('连接中')
    case 'notStarted': return t('未启动')
    case 'disabled': return t('已禁用')
    case 'cancelled': return t('已取消')
    default: return t('状态未知')
  }
}

export function parseBackgroundTasks(value: unknown): BackgroundTaskView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isRecord(entry) && text(entry.id)
    ? [{ id: text(entry.id), type: text(entry.type), description: text(entry.description) }] : [])
}

/** type 取自 Agent 的任务类型，未收录的原样显示。 */
export function backgroundTaskTypeLabel(type: string): string {
  if (type === 'local_bash') return t('命令')
  if (type === 'local_agent' || type === 'remote_agent') return t('子代理')
  if (type === 'local_workflow') return t('工作流')
  return type || t('任务')
}

/** 只读目标服务记录的任务，不会启动 Agent。 */
export async function listBackgroundTasks(rpc: CodexRpcLike, threadId: string): Promise<BackgroundTaskView[]> {
  const result = await rpc.request('qingcode/backgroundTasks/list', { threadId })
  return parseBackgroundTasks(result?.tasks)
}

export async function stopBackgroundTask(rpc: CodexRpcLike, threadId: string, taskId: string): Promise<void> {
  await rpc.request('qingcode/backgroundTasks/stop', { threadId, taskId })
}

/** 会话进程未运行时服务端返回空列表。 */
export async function listSlashCommands(rpc: CodexRpcLike, threadId: string): Promise<SlashCommandView[]> {
  const result = await rpc.request('qingcode/commands/list', { threadId })
  const commands: unknown = result?.commands
  if (!Array.isArray(commands)) return []
  return commands.flatMap((entry): SlashCommandView[] => {
    if (!isRecord(entry)) return []
    const name = text(entry.name).replace(/^\//, '')
    if (!name) return []
    const argumentHint = text(entry.argumentHint)
    return [{ name, description: text(entry.description), ...(argumentHint ? { argumentHint } : {}) }]
  })
}

/**
 * 原生命令并入命令菜单：与内置命令重名时内置优先；技能已由 skills/list 列出的不再重复
 * （pi 的技能命令带 `skill:` 前缀）。
 */
export function mergeSlashCommands(
  commands: readonly SlashCommandView[],
  skillNames: Iterable<string> = [],
): SlashCommandView[] {
  const taken = new Set<string>(chatCommands.map((command) => command.name))
  const skills = new Set(skillNames)
  return commands.filter(({ name }) => {
    if (taken.has(name) || skills.has(name) || skills.has(name.replace(/^skill:/, ''))) return false
    taken.add(name)
    return true
  })
}

/** dryRun 为 false 会改写目标机上的文件，只能在用户确认后调用。 */
export async function rewindFiles(
  rpc: CodexRpcLike,
  threadId: string,
  turnId: string,
  dryRun: boolean,
): Promise<FileRewindResult> {
  const result: unknown = await rpc.request('qingcode/files/rewind', { threadId, turnId, dryRun })
  const record = isRecord(result) ? result : {}
  const error = text(record.error)
  return {
    canRewind: record.canRewind === true,
    filesChanged: Array.isArray(record.filesChanged) ? record.filesChanged.map(text).filter(Boolean) : [],
    insertions: count(record.insertions),
    deletions: count(record.deletions),
    ...(error ? { error } : {}),
  }
}
