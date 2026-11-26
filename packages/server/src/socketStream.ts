import net from 'node:net'
import type { FramedStream } from '@qn/protocol'

/** net.Socket 满足 FramedStream 的形状，显式适配以免依赖 overload 的结构推断。 */
export class SocketStream implements FramedStream {
  constructor(private readonly socket: net.Socket) {}

  write(bytes: Uint8Array): boolean {
    return this.socket.write(Buffer.from(bytes))
  }

  on(ev: 'data', cb: (b: Uint8Array) => void): unknown
  on(ev: 'close' | 'end', cb: () => void): unknown
  on(ev: 'error', cb: (e: Error) => void): unknown
  on(ev: string, cb: (...args: any[]) => void): unknown {
    return this.socket.on(ev, cb)
  }

  destroy(): void {
    this.socket.destroy()
  }
}
