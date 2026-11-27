import { PassThrough } from 'node:stream'
import { FrameDecoder, encodeFrame, type FramedStream } from '@qn/protocol'
import { describe, expect, it } from 'vitest'
import { ServerClient, ServerClientError, toFramedStream } from './serverClient'

interface FakeServer {
  stream: FramedStream
  received: Record<string, unknown>[]
  send(msg: unknown): void
  close(): void
}

function fakeServer(): FakeServer {
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const decoder = new FrameDecoder()
  const received: Record<string, unknown>[] = []
  toServer.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      if (typeof msg === 'object' && msg !== null) received.push(msg as Record<string, unknown>)
    }
  })
  return {
    stream: toFramedStream({
      write: (bytes: Uint8Array) => toServer.write(bytes),
      on: (ev: string, cb: (...args: any[]) => void) => toClient.on(ev, cb),
      destroy: () => {
        toServer.destroy()
        toClient.destroy()
      },
    }),
    received,
    send: (msg) => {
      toClient.write(encodeFrame(msg))
    },
    close: () => toClient.end(),
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('ServerClient', () => {
  it('握手、req/res、evt、codex.recv 与 codex.send', async () => {
    const server = fakeServer()
    const events: unknown[] = []
    const recvs: unknown[] = []
    const closes: unknown[] = []
    const promise = ServerClient.connect({
      stream: server.stream,
      token: 'a'.repeat(64),
      clientName: 'test',
      clientVersion: '9.9.9',
      handlers: {
        onEvent: (name, payload) => events.push([name, payload]),
        onCodexRecv: (seq, msg) => recvs.push([seq, msg]),
        onClose: (err) => closes.push(err?.message ?? null),
      },
    })
    await tick()
    expect(server.received).toEqual([{
      t: 'hello',
      protocol: 1,
      token: 'a'.repeat(64),
      client: { name: 'test', version: '9.9.9' },
    }])
    server.send({ t: 'welcome', protocol: 1, serverVersion: '0.0.1', pid: 42 })
    const client = await promise
    expect(client.serverVersion).toBe('0.0.1')
    expect(client.pid).toBe(42)

    const ping = client.request('ping')
    await tick()
    expect(server.received[1]).toEqual({ t: 'req', id: 1, method: 'ping' })
    server.send({ t: 'res', id: 1, ok: true, result: { serverVersion: '0.0.1', protocol: 1 } })
    await expect(ping).resolves.toEqual({ serverVersion: '0.0.1', protocol: 1 })

    server.send({ t: 'evt', name: 'codex.exited', payload: { code: 1 } })
    server.send({ t: 'codex.recv', seq: 7, msg: { method: 'turn/completed' } })
    server.send({ t: 'codex.recv', seq: null, msg: { id: 3, result: {} } })
    expect(events).toEqual([['codex.exited', { code: 1 }]])
    expect(recvs).toEqual([
      [7, { method: 'turn/completed' }],
      [null, { id: 3, result: {} }],
    ])

    client.codexSend({ id: 9, method: 'thread/list' })
    await tick()
    expect(server.received[2]).toEqual({ t: 'codex.send', msg: { id: 9, method: 'thread/list' } })
    expect(() => client.codexSend(null)).toThrow(ServerClientError)

    client.close()
    await tick()
    expect(closes).toEqual([null])
    await expect(client.request('ping')).rejects.toThrow('server 连接已关闭')
  })

  it('res 错误帧按原 id 拒绝对应的 Promise', async () => {
    const server = fakeServer()
    const promise = ServerClient.connect({
      stream: server.stream,
      token: 'b'.repeat(64),
      handlers: { onEvent() {}, onCodexRecv() {}, onClose() {} },
    })
    await tick()
    server.send({ t: 'welcome', protocol: 1, serverVersion: '0.0.1', pid: 1 })
    const client = await promise
    const first = client.request('fs.home')
    const second = client.request('fs.list', { path: '/' })
    await tick()
    server.send({ t: 'res', id: 1, ok: false, error: { code: 'params', message: '缺少 path' } })
    server.send({ t: 'res', id: 2, ok: true, result: { path: '/', entries: [] } })
    await expect(first).rejects.toMatchObject({ code: 'params', message: '缺少 path' })
    await expect(second).resolves.toEqual({ path: '/', entries: [] })
    client.close()
  })

  it('welcome 超时与 error 帧都会拒绝握手并释放连接', async () => {
    const timeoutServer = fakeServer()
    let closed = false
    await expect(ServerClient.connect({
      stream: timeoutServer.stream,
      token: 'c'.repeat(64),
      handshakeTimeoutMs: 15,
      handlers: { onEvent() {}, onCodexRecv() {}, onClose: () => { closed = true } },
    })).rejects.toMatchObject({ code: 'timeout' })
    expect(closed).toBe(true)

    const errorServer = fakeServer()
    const promise = ServerClient.connect({
      stream: errorServer.stream,
      token: 'd'.repeat(64),
      handlers: { onEvent() {}, onCodexRecv() {}, onClose() {} },
    })
    await tick()
    errorServer.send({ t: 'error', code: 'auth', message: 'token 校验失败' })
    await expect(promise).rejects.toMatchObject({ code: 'auth', message: 'token 校验失败' })
  })

  it('底层流断开时拒绝所有未决请求', async () => {
    const server = fakeServer()
    const promise = ServerClient.connect({
      stream: server.stream,
      token: 'e'.repeat(64),
      requestTimeoutMs: 5_000,
      handlers: { onEvent() {}, onCodexRecv() {}, onClose() {} },
    })
    await tick()
    server.send({ t: 'welcome', protocol: 1, serverVersion: '0.0.1', pid: 1 })
    const client = await promise
    const waiting = client.request('ping')
    await tick()
    server.close()
    await expect(waiting).rejects.toThrow()
    client.close()
  })
})
