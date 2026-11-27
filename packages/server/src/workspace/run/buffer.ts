import type { RunOutputChunk } from './types'

export const RUN_BUFFER_BYTES = 1024 * 1024

/**
 * 每个 run 一份输出环形缓冲：按字节计量，超出上限丢最旧的块。
 * seq 从 1 递增，客户端用 sinceSeq 补齐断线期间的输出。
 */
export class RunOutputBuffer {
  private chunks: Array<RunOutputChunk & { bytes: number }> = []
  private bytes = 0
  private seq = 0
  /** 已被丢弃的最大 seq；0 表示从未丢弃 */
  private droppedThrough = 0

  constructor(private readonly limit = RUN_BUFFER_BYTES) {}

  get lastSeq(): number {
    return this.seq
  }

  push(stream: RunOutputChunk['stream'], data: string): RunOutputChunk {
    let text = data
    let bytes = Buffer.byteLength(text)
    if (bytes > this.limit) {
      // 单块就超过上限时只留尾部，按字符截取后再量一次字节，避免切坏多字节字符。
      text = tailWithinBytes(text, this.limit)
      bytes = Buffer.byteLength(text)
    }
    const chunk = { seq: ++this.seq, stream, data: text }
    this.chunks.push({ ...chunk, bytes })
    this.bytes += bytes
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.bytes -= dropped.bytes
      this.droppedThrough = dropped.seq
    }
    // 该块头部已丢：只拿到它的客户端也要知道输出不完整。
    if (text !== data) this.droppedThrough = Math.max(this.droppedThrough, chunk.seq)
    return chunk
  }

  since(sinceSeq: number): { chunks: RunOutputChunk[]; truncated: boolean } {
    const chunks = this.chunks
      .filter((chunk) => chunk.seq > sinceSeq)
      .map(({ seq, stream, data }) => ({ seq, stream, data }))
    return { chunks, truncated: this.droppedThrough > sinceSeq }
  }
}

function tailWithinBytes(text: string, limit: number): string {
  let start = Math.max(0, text.length - limit)
  while (start < text.length && Buffer.byteLength(text.slice(start)) > limit) {
    start += Math.max(1, Math.ceil((Buffer.byteLength(text.slice(start)) - limit) / 4))
  }
  // 不从代理对的后半开始切。
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start++
  return text.slice(start)
}
