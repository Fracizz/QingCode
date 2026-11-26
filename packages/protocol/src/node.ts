import { encodeFrame, FrameDecoder } from './frame'

/** 结构化的双工流；只依赖方法形状，浏览器/Node 的 socket 都能接入。 */
export interface FramedStream {
  write(b: Uint8Array): boolean
  on(ev: 'data', cb: (b: Uint8Array) => void): unknown
  on(ev: 'close' | 'end', cb: () => void): unknown
  on(ev: 'error', cb: (e: Error) => void): unknown
  destroy(): void
}

export interface FramedHandlers {
  onMessage(msg: unknown): void
  onClose(err?: Error): void
}

export interface FramedConnection {
  send(msg: unknown): void
  close(): void
}

export function attachFramedStream(stream: FramedStream, handlers: FramedHandlers): FramedConnection {
  const decoder = new FrameDecoder()
  let closed = false

  // 解码错误、流结束、主动关闭都走同一出口，保证 onClose 只触发一次。
  const close = (err?: Error): void => {
    if (closed) return
    closed = true
    // 底层 destroy 失败不能吞掉关闭通知，否则调用方会一直等 Promise。
    try {
      stream.destroy()
    } catch {
      // 连接已经判定关闭，底层异常无需再上报。
    }
    handlers.onClose(err)
  }

  stream.on('data', (b: Uint8Array) => {
    if (closed) return
    let messages: unknown[]
    try {
      messages = decoder.push(toBytes(b))
    } catch (cause) {
      close(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    for (const msg of messages) {
      if (closed) return
      handlers.onMessage(msg)
    }
  })
  stream.on('error', (e: Error) => close(e))
  stream.on('close', () => close())
  stream.on('end', () => close())

  return {
    send(msg: unknown): void {
      if (closed) return
      // write 的背压信号不处理：接口没有 drain 事件，且协议帧很小。
      stream.write(encodeFrame(msg))
    },
    close(): void {
      close()
    },
  }
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  // 少数流在 setEncoding 后会给字符串，仍按 UTF-8 字节处理。
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  throw new TypeError('framed stream data must be bytes')
}
