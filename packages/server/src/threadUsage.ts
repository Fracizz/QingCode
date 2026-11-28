import fs from 'node:fs'
import path from 'node:path'

const MAX_THREADS = 1_024
/** 一轮里每次模型调用都会上报用量，合并成一次写盘。 */
const FLUSH_DELAY_MS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 文件内容：按最近更新排序的 [会话 ID, tokenUsage]，越靠后越新。损坏或旧格式按空表处理。 */
export function parseThreadUsageRecord(value: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>()
  const threads = isRecord(value) ? value.threads : undefined
  if (!Array.isArray(threads)) return result
  for (const entry of threads.slice(-MAX_THREADS)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0] || !isRecord(entry[1])) continue
    result.delete(entry[0])
    result.set(entry[0], entry[1])
  }
  return result
}

export interface ThreadUsageOptions {
  /** 给出时把读数存进 `<stateDir>/thread-usage/<agent>.json`，daemon 重启后仍能补上。 */
  stateDir?: string
  agent?: string
  log?: (message: string) => void
}

/**
 * 记住每个会话最近一次上报的用量，并附到打开会话的响应里。
 * 用量只在轮次进行中推送，Codex 的 thread/resume、thread/read 既不回报也不补推用量（0.172 实测），
 * 打开历史会话时客户端没有读数，占用环和「会话用量」会一直是空的，直到下一轮开始。
 * 只在内存里记的话 daemon 一重启就丢，所以和 paseo 一样把读数落在目标机状态目录。
 * 没在 QingCode 里跑过的会话（只在官方客户端跑过）仍然没有读数：官方接口拿不到，也不解析其私有会话文件。
 */
export class ThreadUsage {
  private usage: Map<string, Record<string, unknown>> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly file: string | undefined
  private readonly log: (message: string) => void

  constructor(options: ThreadUsageOptions = {}) {
    this.file = options.stateDir ? path.join(options.stateDir, 'thread-usage', `${options.agent ?? 'codex'}.json`) : undefined
    this.log = options.log ?? (() => {})
  }

  notification(message: Record<string, unknown>): void {
    if (message.method !== 'thread/tokenUsage/updated') return
    const params = message.params
    if (!isRecord(params) || typeof params.threadId !== 'string' || !params.threadId || !isRecord(params.tokenUsage)) return
    const usage = this.read()
    // 重新插入让最近活跃的会话排到末尾，超量时淘汰最久未更新的。
    usage.delete(params.threadId)
    usage.set(params.threadId, params.tokenUsage)
    if (usage.size > MAX_THREADS) usage.delete(usage.keys().next().value!)
    this.scheduleFlush()
  }

  /** thread/start、resume、read、fork 的响应都带 result.thread；已自带用量的不覆盖。 */
  history(result: unknown): unknown {
    if (!isRecord(result) || !isRecord(result.thread)) return result
    const thread = result.thread
    if (typeof thread.id !== 'string' || thread.tokenUsage !== undefined) return result
    const tokenUsage = this.read().get(thread.id)
    return tokenUsage === undefined ? result : { ...result, thread: { ...thread, tokenUsage } }
  }

  /** 退出前把未落盘的读数写掉，再释放内存；磁盘记录保留。 */
  clear(): void {
    this.flush()
    this.usage = undefined
  }

  flush(): void {
    if (this.flushTimer === undefined) return
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.write()
  }

  private scheduleFlush(): void {
    if (!this.file || this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.write()
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  private read(): Map<string, Record<string, unknown>> {
    if (this.usage) return this.usage
    if (!this.file) return (this.usage = new Map())
    try {
      this.usage = parseThreadUsageRecord(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('会话用量记录读取失败') // i18n-ignore: 仅进日志
      this.usage = new Map()
    }
    return this.usage
  }

  private write(): void {
    if (!this.file || !this.usage) return
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, `${JSON.stringify({ threads: [...this.usage] })}\n`, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      this.log('会话用量记录保存失败') // i18n-ignore: 仅进日志
    }
  }
}
