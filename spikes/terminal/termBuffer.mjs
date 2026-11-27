/**
 * 纯逻辑：终端输出的按 seq 环形缓冲 + 接回决策。
 *
 * PTY 是字节流，不能按 UTF-8 文本存；每块以 base64 保存，接回时按 seq 回放，
 * 与 packages/server/src/replayBuffer.ts 的 sinceSeq / truncated 语义保持一致。
 */

export const DEFAULT_MAX_RAW_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_CHUNKS = 4096

/** @typedef {{ seq: number, data: string, bytes: number }} TermChunk */
/** @typedef {{ chunks: Array<{ seq: number, data: string }>, lastSeq: number, truncated: boolean, bytes: number, oldestSeq: number | null }} Replay */

export class TermOutputBuffer {
  /** @type {TermChunk[]} */
  #chunks = []
  #lastSeq = 0
  #dropped = 0
  #bytes = 0
  #maxRawBytes = DEFAULT_MAX_RAW_BYTES
  #maxChunks = DEFAULT_MAX_CHUNKS

  /** @param {{ maxRawBytes?: number, maxChunks?: number }} [options] */
  constructor(options = {}) {
    this.#maxRawBytes = Math.max(0, options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES)
    this.#maxChunks = Math.max(0, options.maxChunks ?? DEFAULT_MAX_CHUNKS)
  }

  get lastSeq() {
    return this.#lastSeq
  }

  get bytes() {
    return this.#bytes
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {{ seq: number, data: string }}
   */
  append(bytes) {
    const raw = Buffer.from(bytes)
    const seq = ++this.#lastSeq
    const chunk = { seq, data: raw.toString('base64'), bytes: raw.byteLength }
    this.#chunks.push(chunk)
    this.#bytes += chunk.bytes
    this.#trim()
    return { seq, data: chunk.data }
  }

  /**
   * @param {number} sinceSeq
   * @returns {Replay}
   */
  since(sinceSeq) {
    const from = Number.isFinite(sinceSeq) ? Math.floor(sinceSeq) : 0
    const alive = this.#chunks.filter((c) => c.seq > from)
    const oldestSeq = this.#chunks[0]?.seq ?? null
    return {
      chunks: alive.map(({ seq, data }) => ({ seq, data })),
      lastSeq: this.#lastSeq,
      truncated: this.#dropped > 0 && (oldestSeq === null || oldestSeq > from + 1),
      bytes: alive.reduce((sum, c) => sum + c.bytes, 0),
      oldestSeq,
    }
  }

  clear() {
    this.#chunks.length = 0
    this.#bytes = 0
  }

  #trim() {
    while (
      this.#chunks.length > 0 &&
      (this.#bytes > this.#maxRawBytes || this.#chunks.length > this.#maxChunks)
    ) {
      const first = this.#chunks.shift()
      if (!first) break
      this.#bytes -= first.bytes
      this.#dropped += 1
    }
  }
}

/**
 * 环形缓冲只能补"断开之后的输出"，不能重建屏幕状态（ANSI 光标/交替屏/滚动区）。
 * 因此接回优先用渲染端快照；无快照且缓冲已截断时只能标记 resync 让用户重画。
 *
 * @param {Replay} replay
 * @param {{ hasSnapshot: boolean, sinceSeq: number }} client
 * @returns {{ mode: 'replay' | 'snapshot' | 'resync', reason: string }}
 */
export function planAttach(replay, client) {
  if (!replay.truncated && client.sinceSeq <= replay.lastSeq) {
    return { mode: 'replay', reason: '缓冲完整，直接补发缺失的分块' }
  }
  if (client.hasSnapshot) {
    return { mode: 'snapshot', reason: '屏幕快照 + 断点之后的增量，避免重放整段历史' }
  }
  return { mode: 'resync', reason: '缓冲已截断且无快照，只能清屏后从最新输出继续' }
}
