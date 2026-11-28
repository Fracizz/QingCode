/** qingcode/* 请求与通知用到的 SDK 数据转换（纯函数）。 */
import { asRecord, finite, scalarText, type Json } from './v2'

export interface BackgroundTask {
  id: string
  type: string
  description: string
}

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint?: string
}

export interface RewindResponse {
  canRewind: boolean
  filesChanged: string[]
  insertions: number
  deletions: number
  error?: string
}

/** background_tasks_changed 是全量快照（替换语义），不含 ambient 监听任务；其他消息返回 null。 */
export function backgroundTaskList(message: Json): BackgroundTask[] | null {
  if (message.type !== 'system' || message.subtype !== 'background_tasks_changed' || !Array.isArray(message.tasks)) {
    return null
  }
  return message.tasks.flatMap((raw) => {
    const task = asRecord(raw)
    const id = scalarText(task?.task_id)
    if (!id || task?.ambient === true) return []
    return [{ id, type: scalarText(task?.task_type), description: scalarText(task?.description) }]
  })
}

export function slashCommandList(raw: unknown[]): SlashCommandInfo[] {
  return raw.flatMap((entry) => {
    const command = asRecord(entry)
    const name = scalarText(command?.name).replace(/^\//, '')
    if (!name) return []
    const argumentHint = scalarText(command?.argumentHint)
    return [{ name, description: scalarText(command?.description), ...(argumentHint ? { argumentHint } : {}) }]
  })
}

export function rewindResponse(raw: unknown): RewindResponse {
  const result = asRecord(raw)
  const skipped = finite(result?.skippedLinks) ?? 0
  // 链接类文件被跳过时回滚不完整，接口没有单独字段，写进 error 让用户看到。
  const error = scalarText(result?.error) || (skipped > 0 ? `有 ${skipped} 个链接类文件未恢复` : '')
  return {
    canRewind: result?.canRewind === true,
    filesChanged: Array.isArray(result?.filesChanged) ? result.filesChanged.map(scalarText).filter(Boolean) : [],
    insertions: finite(result?.insertions) ?? 0,
    deletions: finite(result?.deletions) ?? 0,
    ...(error ? { error } : {}),
  }
}
