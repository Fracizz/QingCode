import fs from 'node:fs'
import path from 'node:path'
import type { AgentKind } from '@qn/protocol'

/** 未读文件内容：`agent:threadId` → 标记时间（毫秒）。 */
export type UnreadRecord = Record<string, number>

export type UnreadEntry = { agent: AgentKind; threadId: string; at: number }

/** 只保留最近的若干条，避免临时会话（标题生成等）的完成事件让文件无限增长。 */
export const MAX_UNREAD = 500

const AGENTS: readonly AgentKind[] = ['codex', 'claude', 'pi']

export const unreadKey = (agent: AgentKind, threadId: string): string => `${agent}:${threadId}`

export function parseUnreadKey(key: string): { agent: AgentKind; threadId: string } | null {
  const index = key.indexOf(':')
  if (index <= 0) return null
  const agent = key.slice(0, index) as AgentKind
  const threadId = key.slice(index + 1)
  return AGENTS.includes(agent) && threadId ? { agent, threadId } : null
}

/** 只接受合法键 → 有限数字的条目，损坏或旧格式的文件按空表处理。 */
export function parseUnreadRecord(value: unknown): UnreadRecord {
  const result: UnreadRecord = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
  for (const [key, at] of Object.entries(value)) {
    if (parseUnreadKey(key) && typeof at === 'number' && Number.isFinite(at)) result[key] = at
  }
  return result
}

/** 超出上限时按时间丢弃最旧的条目。 */
export function pruneUnread(record: UnreadRecord, max = MAX_UNREAD): UnreadRecord {
  const keys = Object.keys(record)
  if (keys.length <= max) return record
  const kept = keys.sort((a, b) => (record[b] ?? 0) - (record[a] ?? 0)).slice(0, max)
  return Object.fromEntries(kept.map((key) => [key, record[key] as number]))
}

/**
 * 会话未读状态存在目标机 QingCode 的状态目录：电脑和手机经同一个 daemon 读写同一份，
 * 一端看过的会话另一端也视为已读。不改动 Agent 自己的会话文件。
 */
export class UnreadStore {
  private cache: UnreadRecord | undefined

  constructor(
    private readonly stateDir: string | undefined,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  list(): UnreadEntry[] {
    const entries: UnreadEntry[] = []
    for (const [key, at] of Object.entries(this.read())) {
      const parsed = parseUnreadKey(key)
      if (parsed) entries.push({ ...parsed, at })
    }
    return entries
  }

  /** 返回是否有变化，调用方据此决定是否广播通知。 */
  set(agent: AgentKind, threadId: string, unread: boolean): boolean {
    const key = unreadKey(agent, threadId)
    const current = this.read()
    if ((current[key] !== undefined) === unread) return false
    const next = { ...current }
    if (unread) next[key] = this.now()
    else delete next[key]
    this.write(pruneUnread(next))
    return true
  }

  private read(): UnreadRecord {
    if (this.cache) return this.cache
    const file = this.file()
    if (!file) return (this.cache = {})
    try {
      this.cache = parseUnreadRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('未读记录读取失败') // i18n-ignore: 仅进日志
      this.cache = {}
    }
    return this.cache
  }

  private write(next: UnreadRecord): void {
    this.cache = next
    const file = this.file()
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      this.log('未读记录保存失败') // i18n-ignore: 仅进日志
    }
  }

  private file(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, 'unread.json') : undefined
  }
}
