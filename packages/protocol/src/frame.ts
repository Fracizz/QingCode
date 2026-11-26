import { MAX_FRAME_BYTES } from './constants'

export class FrameError extends Error {
  readonly code: 'oversize' | 'json'

  constructor(code: 'oversize' | 'json', message: string) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

const utf8Encoder = new TextEncoder()
// fatal 让非法 UTF-8 与非法 JSON 一样走协议错误分支，避免把乱码当成消息。
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeFrame(msg: unknown): Uint8Array {
  let json: string
  try {
    const serialized = JSON.stringify(msg)
    // JSON.stringify 对 undefined、函数、Symbol 返回 undefined，序列化后不是合法 JSON 文本。
    if (typeof serialized !== 'string') {
      throw new TypeError('value is not JSON-serializable')
    }
    json = serialized
  } catch (cause) {
    throw new FrameError('json', `encodeFrame: ${describe(cause)}`)
  }

  const payload = utf8Encoder.encode(json)
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError('oversize', `frame is ${payload.byteLength} bytes, limit is ${MAX_FRAME_BYTES}`)
  }

  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
  frame.set(payload, 4)
  return frame
}

export class FrameDecoder {
  private chunks: Uint8Array[] = []
  private buffered = 0

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      // 流实现可能复用缓冲区（Node Buffer 的 slice 还是视图），必须复制后再持有。
      this.chunks.push(new Uint8Array(chunk))
      this.buffered += chunk.byteLength
    }

    const messages: unknown[] = []
    while (this.buffered >= 4) {
      const length = this.peekLength()
      // 先看头部长度再等负载，避免为超限帧缓存最多 4GiB 数据。
      if (length > MAX_FRAME_BYTES) {
        this.reset()
        throw new FrameError('oversize', `frame is ${length} bytes, limit is ${MAX_FRAME_BYTES}`)
      }
      if (this.buffered < 4 + length) break

      const frame = this.consume(4 + length)
      let msg: unknown
      try {
        msg = JSON.parse(utf8Decoder.decode(frame.subarray(4)))
      } catch (cause) {
        this.reset()
        throw new FrameError('json', `invalid frame payload: ${describe(cause)}`)
      }
      messages.push(msg)
    }
    return messages
  }

  private peekLength(): number {
    const header = new Uint8Array(4)
    let offset = 0
    for (const chunk of this.chunks) {
      const take = Math.min(4 - offset, chunk.byteLength)
      header.set(chunk.subarray(0, take), offset)
      offset += take
      if (offset === 4) break
    }
    return new DataView(header.buffer).getUint32(0, false)
  }

  private consume(size: number): Uint8Array {
    const out = new Uint8Array(size)
    let offset = 0
    while (offset < size) {
      const first = this.chunks[0]
      if (!first) break
      const take = Math.min(size - offset, first.byteLength)
      out.set(first.subarray(0, take), offset)
      offset += take
      if (take === first.byteLength) this.chunks.shift()
      else this.chunks[0] = first.subarray(take)
    }
    this.buffered -= size
    return out
  }

  private reset(): void {
    this.chunks = []
    this.buffered = 0
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
