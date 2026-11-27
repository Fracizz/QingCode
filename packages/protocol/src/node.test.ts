import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { attachFramedStream, encodeFrame, FrameError } from './index'

/** 两个互相把写端接到对方读端的 Duplex，模拟 socket/管道而不是回环。 */
class Socket extends Duplex {
  peer: Socket | null = null

  override _read(): void {}

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array)
    if (this.peer && !this.peer.destroyed) this.peer.push(bytes)
    callback()
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(null)
    callback()
  }
}

function makePair(): [Socket, Socket] {
  const a = new Socket()
  const b = new Socket()
  a.peer = b
  b.peer = a
  return [a, b]
}

function makeBadFrame(): Uint8Array {
  const payload = new TextEncoder().encode('{bad json')
  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
  frame.set(payload, 4)
  return frame
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('attachFramedStream', () => {
  it('Duplex 双工收发', async () => {
    const [a, b] = makePair()
    const gotByA: unknown[] = []
    const gotByB: unknown[] = []
    const connA = attachFramedStream(a, { onMessage: (m) => gotByA.push(m), onClose: () => {} })
    const connB = attachFramedStream(b, { onMessage: (m) => gotByB.push(m), onClose: () => {} })

    connA.send({ t: 'hello', text: '你好' })
    connB.send({ t: 'res', id: 1, ok: true, result: null })
    await tick()

    expect(gotByB).toEqual([{ t: 'hello', text: '你好' }])
    expect(gotByA).toEqual([{ t: 'res', id: 1, ok: true, result: null }])
    connA.close()
    connB.close()
  })

  it('逐字节到达只触发一次 onMessage', async () => {
    const [a, b] = makePair()
    const received: unknown[] = []
    attachFramedStream(b, { onMessage: (m) => received.push(m), onClose: () => {} })
    const frame = encodeFrame({ text: '世界', list: [1, 2, 3] })
    for (const byte of frame) a.write(Uint8Array.of(byte))
    await tick()
    expect(received).toEqual([{ text: '世界', list: [1, 2, 3] }])
  })

  it('任意切分下的粘包', async () => {
    const [a, b] = makePair()
    const received: unknown[] = []
    attachFramedStream(b, { onMessage: (m) => received.push(m), onClose: () => {} })
    const all = concat([encodeFrame({ n: 1 }), encodeFrame('中文'), encodeFrame(null)])
    const sizes = [1, 4, 2, 7, 3]
    let offset = 0
    let i = 0
    while (offset < all.byteLength) {
      const size = Math.min(sizes[i % sizes.length] as number, all.byteLength - offset)
      a.write(all.subarray(offset, offset + size))
      offset += size
      i++
    }
    await tick()
    expect(received).toEqual([{ n: 1 }, '中文', null])
  })

  it('PassThrough 回环也能收发', () => {
    const stream = new PassThrough()
    const received: unknown[] = []
    const conn = attachFramedStream(stream, {
      onMessage: (m) => received.push(m),
      onClose: () => {},
    })
    conn.send({ a: 1 })
    conn.send('中文')
    expect(received).toEqual([{ a: 1 }, '中文'])
    conn.close()
  })

  it('解码错误时 destroy 并以 FrameError 回调 onClose 一次', async () => {
    const [a, b] = makePair()
    let closes = 0
    let lastError: Error | undefined
    const conn = attachFramedStream(b, {
      onMessage: () => {},
      onClose: (err) => {
        closes++
        lastError = err
      },
    })
    a.write(makeBadFrame())
    await tick()
    expect(closes).toBe(1)
    expect(lastError).toBeInstanceOf(FrameError)
    expect((lastError as FrameError).code).toBe('json')
    expect(b.destroyed).toBe(true)
    conn.close()
    await tick()
    expect(closes).toBe(1)
  })

  it('流 error 事件传出错因且只回调一次', async () => {
    const [a, b] = makePair()
    let closes = 0
    let lastError: Error | undefined
    attachFramedStream(b, {
      onMessage: () => {},
      onClose: (err) => {
        closes++
        lastError = err
      },
    })
    const failure = new Error('socket reset')
    b.emit('error', failure)
    await tick()
    expect(closes).toBe(1)
    expect(lastError).toBe(failure)
    expect(b.destroyed).toBe(true)
  })

  it('对端 EOF 触发 onClose 一次', async () => {
    const [a, b] = makePair()
    let closes = 0
    attachFramedStream(b, { onMessage: () => {}, onClose: () => closes++ })
    a.write(encodeFrame({ ping: true }))
    a.end()
    await tick()
    expect(closes).toBe(1)
    expect(b.destroyed).toBe(true)
  })

  it('主动 close 后 send 被忽略且 onClose 不重复', async () => {
    const [a] = makePair()
    let closes = 0
    const conn = attachFramedStream(a, { onMessage: () => {}, onClose: () => closes++ })
    conn.close()
    await tick()
    expect(closes).toBe(1)
    expect(a.destroyed).toBe(true)
    expect(() => conn.send({ ignored: true })).not.toThrow()
    conn.close()
    await tick()
    expect(closes).toBe(1)
  })

  it('send 超限时抛出 FrameError（oversize）', () => {
    const [a] = makePair()
    const conn = attachFramedStream(a, { onMessage: () => {}, onClose: () => {} })
    expect(() => conn.send({ big: 'x'.repeat(16 * 1024 * 1024) })).toThrowError(FrameError)
    conn.close()
  })
})
