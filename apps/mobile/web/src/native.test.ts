import { describe, expect, it, vi } from 'vitest'
import {
  NativeCallbacks,
  NativeClient,
  NativeRequestError,
  parseNativeAck,
  toCallbackMessage,
} from './native'

describe('toCallbackMessage / parseNativeAck', () => {
  it('区分回包、流事件、流关闭，丢弃畸形消息', () => {
    expect(toCallbackMessage({ id: 1, ok: true, result: { a: 1 } })).toEqual({
      id: 1,
      ok: true,
      result: { a: 1 },
    })
    expect(toCallbackMessage({ id: 2, ok: false, error: '密码错误', code: 'unauthorized' })).toEqual({
      id: 2,
      ok: false,
      error: '密码错误',
      code: 'unauthorized',
    })
    expect(toCallbackMessage({ stream: 's1', event: { name: 'codex.recv', payload: {} } })).toEqual({
      stream: 's1',
      event: { name: 'codex.recv', payload: {} },
    })
    expect(toCallbackMessage({ stream: 's1', closed: true, error: '断线' })).toEqual({
      stream: 's1',
      closed: true,
      error: '断线',
    })
    expect(toCallbackMessage({ stream: 's1', closed: true })).toEqual({
      stream: 's1',
      closed: true,
      error: null,
    })
    expect(toCallbackMessage(null)).toBeNull()
    expect(toCallbackMessage({ id: 'x', ok: true })).toBeNull()
  })

  it('ack 解析容忍空串与附加字段', () => {
    expect(parseNativeAck('{"id":1,"queued":true}')).toEqual({ queued: true })
    expect(parseNativeAck('{"queued":false,"error":"应用已关闭"}')).toEqual({
      queued: false,
      error: '应用已关闭',
    })
    expect(parseNativeAck('')).toBeNull()
  })
})

describe('NativeClient', () => {
  it('request 同步 ack，结果经 hub 异步回包后 resolve', async () => {
    const hub = new NativeCallbacks()
    const port = {
      request: vi.fn((json: string) => {
        const req = JSON.parse(json) as { id: number; method: string; params: unknown }
        expect(req.method).toBe('probe')
        queueMicrotask(() => hub.deliver(JSON.stringify({ id: req.id, ok: true, result: { fingerprint: 'abc' } })))
        return JSON.stringify({ id: req.id, queued: true })
      }),
    }
    const client = new NativeClient(port, hub, 0)
    await expect(client.call('probe', { host: 'h' })).resolves.toEqual({ fingerprint: 'abc' })
    expect(port.request).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('错误回包带上原生层给的 code', async () => {
    const hub = new NativeCallbacks()
    const port = {
      request: (json: string) => {
        const req = JSON.parse(json) as { id: number }
        queueMicrotask(() =>
          hub.deliver(JSON.stringify({ id: req.id, ok: false, error: '密码错误', code: 'unauthorized' })),
        )
        return JSON.stringify({ id: req.id, queued: true })
      },
    }
    const client = new NativeClient(port, hub, 0)
    await expect(client.call('pair', {})).rejects.toMatchObject({
      name: 'NativeRequestError',
      message: '密码错误',
      code: 'unauthorized',
    })
    client.dispose()
  })

  it('ack 明确 queued:false 时立刻失败，不等待回包', async () => {
    const hub = new NativeCallbacks()
    const port = { request: () => '{"queued":false,"error":"应用已关闭"}' }
    const client = new NativeClient(port, hub, 0)
    await expect(client.call('probe', {})).rejects.toBeInstanceOf(NativeRequestError)
    expect(hub.size).toBe(1)
    client.dispose()
    expect(hub.size).toBe(0)
  })

  it('onStream 只收到流消息', () => {
    const hub = new NativeCallbacks()
    const client = new NativeClient({ request: () => '{"queued":true}' }, hub, 0)
    const seen: unknown[] = []
    const off = client.onStream((msg) => seen.push(msg))
    hub.deliver('{"id":1,"ok":true,"result":null}')
    hub.deliver('{"stream":"s1","event":{"name":"ping"}}')
    hub.deliver('{"stream":"s1","closed":true,"error":null}')
    expect(seen).toHaveLength(2)
    off()
    hub.deliver('{"stream":"s1","event":{"name":"ping"}}')
    expect(seen).toHaveLength(2)
    client.dispose()
  })
})
