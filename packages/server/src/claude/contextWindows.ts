import fs from 'node:fs'
import path from 'node:path'

const MAX_SESSIONS = 1_000

/** 文件内容：会话 ID → 窗口，模型 → 最近一次见到的窗口。 */
export type ContextWindowRecord = { sessions: Record<string, number>; models: Record<string, number> }

function windows(value: unknown): Record<string, number> {
  const result: Record<string, number> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
  for (const [key, window] of Object.entries(value)) {
    if (key && typeof window === 'number' && Number.isFinite(window) && window > 0) result[key] = window
  }
  return result
}

/** 损坏或旧格式的文件按空表处理。 */
export function parseContextWindowRecord(value: unknown): ContextWindowRecord {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return { sessions: windows(record.sessions), models: windows(record.models) }
}

/** 历史里的模型名不带 [1m] 之类的后缀，按去掉后缀的规范名记录和查找。 */
export function modelKey(model: string | null | undefined): string | null {
  const key = model?.replace(/\[[^\]]*\]$/, '').trim().toLowerCase()
  return key && key !== '<synthetic>' ? key : null
}

/** result.modelUsage 里窗口最大的模型即主会话模型（与 items.ts 取窗口的口径一致）。 */
export function resultModelWindow(result: unknown): { model: string | null; window: number } | null {
  const usage = typeof result === 'object' && result !== null ? (result as Record<string, unknown>).modelUsage : null
  if (typeof usage !== 'object' || usage === null) return null
  let best: { model: string | null; window: number } | null = null
  for (const [key, value] of Object.entries(usage)) {
    const entry = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const window = entry.contextWindow
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0 || (best && best.window >= window)) continue
    best = { model: typeof entry.canonicalModel === 'string' && entry.canonicalModel ? entry.canonicalModel : key, window }
  }
  return best
}

/**
 * Claude 的会话历史只存每次回复的 token 用量，不存上下文窗口；窗口只在一轮结束的 result 里给出。
 * 把跑过的轮次学到的窗口记在目标机状态目录，打开历史会话时先按会话、再按模型查，
 * 占用环不必等下一轮才有百分比，也不必为读窗口启动 Claude 进程（会触发 hooks 与 MCP）。
 */
export class ContextWindowStore {
  private cache: ContextWindowRecord | undefined

  constructor(
    private readonly stateDir: string | undefined,
    private readonly log: (message: string) => void,
  ) {}

  lookup(threadId: string, model: string | null | undefined): number | null {
    const record = this.read()
    const key = modelKey(model)
    return record.sessions[threadId] ?? (key ? record.models[key] : undefined) ?? null
  }

  record(threadId: string, model: string | null | undefined, window: number): void {
    if (!Number.isFinite(window) || window <= 0) return
    const current = this.read()
    const key = modelKey(model)
    if (current.sessions[threadId] === window && (!key || current.models[key] === window)) return
    const sessions = { ...current.sessions }
    // 重新插入让最近用过的会话排在末尾，超量时淘汰最久未更新的。
    delete sessions[threadId]
    sessions[threadId] = window
    const ids = Object.keys(sessions)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete sessions[id]
    this.write({ sessions, models: key ? { ...current.models, [key]: window } : current.models })
  }

  private read(): ContextWindowRecord {
    if (this.cache) return this.cache
    const file = this.file()
    if (!file) return (this.cache = { sessions: {}, models: {} })
    try {
      this.cache = parseContextWindowRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('claude 上下文窗口记录读取失败') // i18n-ignore: 仅进日志
      this.cache = { sessions: {}, models: {} }
    }
    return this.cache
  }

  private write(next: ContextWindowRecord): void {
    this.cache = next
    const file = this.file()
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      this.log('claude 上下文窗口记录保存失败') // i18n-ignore: 仅进日志
    }
  }

  private file(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, 'context-windows', 'claude.json') : undefined
  }
}
