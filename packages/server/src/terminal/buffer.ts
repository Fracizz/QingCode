// 纯逻辑：终端输出的 seq 环形缓冲、接回计划、输出合并。不碰任何 IO。
//
// PTY 是任意字节流（可能是非法 UTF-8、半个转义序列），只能按原始字节存，
// 下发时再转 base64；seq 每终端独立，语义与 replayBuffer.ts 的 sinceSeq/truncated 一致。

export const DEFAULT_MAX_RAW_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_CHUNKS = 4096
/** 单块原始字节上限：大输出拆块，避免一帧过大堵住 resize/输入（spike §6.4）。 */
export const CHUNK_MAX_BYTES = 32 * 1024

export interface TermChunk {
  seq: number
  /** base64 */
  data: string
}

export interface TermReplay {
  chunks: TermChunk[]
  lastSeq: number
  /** 断点之后有分块已被淘汰，单靠回放补不全 */
  truncated: boolean
  /** 回放分块的原始字节总数 */
  bytes: number
}

interface StoredChunk {
  seq: number
  raw: Buffer
}

export class TermOutputBuffer {
  private readonly chunks: Array<StoredChunk | undefined> = []
  private head = 0
  private seq = 0
  private size = 0
  private readonly maxRawBytes: number
  private readonly maxChunks: number

  constructor(options: { maxRawBytes?: number; maxChunks?: number } = {}) {
    this.maxRawBytes = Math.max(1, options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES)
    this.maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS)
  }

  get lastSeq(): number {
    return this.seq
  }

  get bytes(): number {
    return this.size
  }

  get length(): number {
    return this.chunks.length - this.head
  }

  /** 当前保留的最早 seq；为空时等于 lastSeq + 1。 */
  get firstSeq(): number {
    return this.seq - this.length + 1
  }

  append(bytes: Uint8Array): TermChunk {
    const raw = Buffer.from(bytes)
    const seq = ++this.seq
    this.chunks.push({ seq, raw })
    this.size += raw.byteLength
    this.trim()
    return { seq, data: raw.toString('base64') }
  }

  since(sinceSeq: number): TermReplay {
    const from = Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : 0
    const first = this.firstSeq
    // seq 连续，所以断点之后缺的就是 [from+1, first-1] 这一段。
    const truncated = from < this.seq && from + 1 < first
    const startIndex = this.head + Math.max(0, from + 1 - first)
    const chunks: TermChunk[] = []
    let bytes = 0
    for (let i = startIndex; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]
      if (!chunk) continue
      chunks.push({ seq: chunk.seq, data: chunk.raw.toString('base64') })
      bytes += chunk.raw.byteLength
    }
    return { chunks, lastSeq: this.seq, truncated, bytes }
  }

  clear(): void {
    this.chunks.length = 0
    this.head = 0
    this.size = 0
  }

  private trim(): void {
    while (this.length > 1 && (this.size > this.maxRawBytes || this.length > this.maxChunks)) {
      const first = this.chunks[this.head]
      if (!first) break
      this.size -= first.raw.byteLength
      this.chunks[this.head] = undefined
      this.head++
    }
    // 定期压缩，避免数组头部空洞无限增长。
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head)
      this.head = 0
    }
  }
}

/** 渲染端上传的屏幕快照（xterm serialize），代表 seq ≤ snapshot.seq 的全部输出。 */
export interface TermSnapshot {
  seq: number
  /** base64 */
  data: string
  cols: number
  rows: number
}

export type AttachMode = 'replay' | 'snapshot' | 'resync'

export interface AttachPlan {
  mode: AttachMode
  chunks: TermChunk[]
  lastSeq: number
  truncated: boolean
  snapshot?: TermSnapshot
}

/**
 * 回放只能补"断点之后的输出"，不能重建屏幕状态；缺口无法用回放补齐时优先用快照，
 * 快照也接不上就 resync：客户端清屏后写入仍保留的分块，并提示历史输出已丢失。
 */
export function planAttach(
  buffer: TermOutputBuffer,
  sinceSeq: number,
  snapshot: TermSnapshot | null,
): AttachPlan {
  const from = Number.isFinite(sinceSeq) ? Math.floor(sinceSeq) : 0
  if (from >= 0 && from <= buffer.lastSeq) {
    const replay = buffer.since(from)
    if (!replay.truncated) {
      return { mode: 'replay', chunks: replay.chunks, lastSeq: replay.lastSeq, truncated: false }
    }
  }
  // 快照之后的分块必须完整保留，快照才接得上。
  if (snapshot && snapshot.seq <= buffer.lastSeq && snapshot.seq + 1 >= buffer.firstSeq) {
    const replay = buffer.since(snapshot.seq)
    return { mode: 'snapshot', chunks: replay.chunks, lastSeq: replay.lastSeq, truncated: true, snapshot }
  }
  const replay = buffer.since(0)
  return {
    mode: 'resync',
    chunks: replay.chunks,
    lastSeq: replay.lastSeq,
    // sinceSeq 超前（客户端拿着别的 daemon 实例的进度）也算截断：客户端必须重画。
    truncated: true,
  }
}

/**
 * 输出合并：PTY 读出的小块累积到 CHUNK_MAX_BYTES 立即切出，不足的由调用方定时 drain，
 * 这样既不会每个字节一帧，也不会让大输出拼成超大帧。
 */
export class OutputCoalescer {
  private parts: Buffer[] = []
  private size = 0

  constructor(private readonly maxChunk = CHUNK_MAX_BYTES) {}

  get pendingBytes(): number {
    return this.size
  }

  /** 返回已攒满、应立即发送的块（每块恰为 maxChunk 字节）。 */
  push(data: Uint8Array): Buffer[] {
    if (data.byteLength === 0) return []
    this.parts.push(Buffer.from(data))
    this.size += data.byteLength
    const ready: Buffer[] = []
    if (this.size < this.maxChunk) return ready
    let all = Buffer.concat(this.parts, this.size)
    while (all.byteLength >= this.maxChunk) {
      ready.push(all.subarray(0, this.maxChunk))
      all = all.subarray(this.maxChunk)
    }
    this.parts = all.byteLength > 0 ? [Buffer.from(all)] : []
    this.size = all.byteLength
    return ready
  }

  /** 取出剩余不足一块的数据；无数据返回 null。 */
  drain(): Buffer | null {
    if (this.size === 0) return null
    const out = Buffer.concat(this.parts, this.size)
    this.parts = []
    this.size = 0
    return out
  }
}
