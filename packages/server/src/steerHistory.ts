import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type SteerPlacement = 'currentTurn' | 'nextTurn'

export function isSteerPlacement(value: unknown): value is SteerPlacement {
  return value === 'currentTurn' || value === 'nextTurn'
}

/** Agent 的公开历史不带引导的轮次归属。只在 QingCode 的状态目录存消息标识和归属。 */
export class SteerHistoryStore<T> {
  constructor(
    private readonly stateDir: string | undefined,
    private readonly agent: 'claude' | 'pi',
    private readonly parse: (value: unknown) => T | undefined,
    private readonly log: (message: string) => void,
  ) {}

  read(threadId: string, scope?: string): Map<string, T> {
    const result = new Map<string, T>()
    const file = this.file(threadId, scope)
    if (!file) return result
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
          const value = this.parse(entry[1])
          if (value !== undefined) result.set(entry[0], value)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`${this.agent} 引导历史读取失败`)
    }
    return result
  }

  write(threadId: string, entries: Iterable<readonly [string, T]>, scope?: string): void {
    const file = this.file(threadId, scope)
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, `${JSON.stringify([...entries])}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      this.log(`${this.agent} 引导历史保存失败`)
    }
  }

  private file(threadId: string, scope?: string): string | undefined {
    if (!this.stateDir) return undefined
    const key = createHash('sha256').update(JSON.stringify([this.agent, scope, threadId])).digest('hex')
    return path.join(this.stateDir, 'steering', `${key}.json`)
  }
}
