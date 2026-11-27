import fs from 'node:fs'
import path from 'node:path'

/** 归档文件内容：会话 ID → 归档时间（毫秒）。 */
export type ArchiveRecord = Record<string, number>

/** 只接受 ID → 有限数字的条目，损坏或旧格式的文件按空表处理。 */
export function parseArchiveRecord(value: unknown): ArchiveRecord {
  const result: ArchiveRecord = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
  for (const [id, at] of Object.entries(value)) {
    if (id && typeof at === 'number' && Number.isFinite(at)) result[id] = at
  }
  return result
}

/**
 * Claude 与 pi 没有原生的会话归档。归档标记存在目标机 QingCode 的状态目录，
 * 这样电脑和手机经同一个 daemon 读写同一份状态，一端归档另一端同步隐藏。
 * 不改动 Agent 自己的会话文件。
 */
export class ArchiveStore {
  private cache: ArchiveRecord | undefined

  constructor(
    private readonly stateDir: string | undefined,
    private readonly agent: 'claude' | 'pi',
    private readonly log: (message: string) => void,
  ) {}

  has(threadId: string): boolean {
    return this.read()[threadId] !== undefined
  }

  /** 返回是否有变化，调用方据此决定是否广播通知。 */
  set(threadId: string, archived: boolean): boolean {
    const current = this.read()
    if ((current[threadId] !== undefined) === archived) return false
    const next = { ...current }
    if (archived) next[threadId] = Date.now()
    else delete next[threadId]
    this.write(next)
    return true
  }

  private read(): ArchiveRecord {
    if (this.cache) return this.cache
    const file = this.file()
    if (!file) return (this.cache = {})
    try {
      this.cache = parseArchiveRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`${this.agent} 归档记录读取失败`) // i18n-ignore: 仅进日志
      this.cache = {}
    }
    return this.cache
  }

  private write(next: ArchiveRecord): void {
    this.cache = next
    const file = this.file()
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      this.log(`${this.agent} 归档记录保存失败`) // i18n-ignore: 仅进日志
    }
  }

  private file(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, 'archives', `${this.agent}.json`) : undefined
  }
}
