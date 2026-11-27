export interface BufferedMessage {
  seq: number
  msg: Record<string, unknown>
}

export interface ReplayOptions {
  maxEntries?: number
  maxBytes?: number
}

export interface ReplayResult {
  messages: BufferedMessage[]
  truncated: boolean
}

export const DEFAULT_MAX_ENTRIES = 20000
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

interface StoredMessage extends BufferedMessage {
  bytes: number
}

/** codex → client 的广播消息按 seq 递增保存，条数与字节数双上限。 */
export class ReplayBuffer {
  private readonly entries: StoredMessage[] = []
  private readonly maxEntries: number
  private readonly maxBytes: number
  private last = 0
  private dropped = 0
  private bytes = 0

  constructor(options: ReplayOptions = {}) {
    this.maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_MAX_BYTES)
  }

  get lastSeq(): number {
    return this.last
  }

  get size(): number {
    return this.entries.length
  }

  push(msg: Record<string, unknown>): BufferedMessage {
    const seq = ++this.last
    const entry: StoredMessage = { seq, msg, bytes: byteSize(msg) }
    this.entries.push(entry)
    this.bytes += entry.bytes
    this.trim()
    return { seq, msg }
  }

  /** 返回 seq > sinceSeq 的存活消息；被丢弃且落在请求区间内时 truncated 为 true。 */
  since(sinceSeq: number): ReplayResult {
    const from = Number.isFinite(sinceSeq) ? Math.floor(sinceSeq) : 0
    const messages = this.entries.filter((e) => e.seq > from).map(({ seq, msg }) => ({ seq, msg }))
    const oldest = this.entries[0]?.seq ?? this.last + 1
    return { messages, truncated: this.dropped > 0 && oldest > from + 1 }
  }

  clear(): void {
    this.entries.length = 0
    this.bytes = 0
  }

  private trim(): void {
    while (
      this.entries.length > 0 &&
      (this.entries.length > this.maxEntries || this.bytes > this.maxBytes)
    ) {
      const first = this.entries.shift()
      if (!first) break
      this.bytes -= first.bytes
      this.dropped += 1
    }
  }
}

function byteSize(msg: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(msg), 'utf8')
  } catch {
    return 0
  }
}
