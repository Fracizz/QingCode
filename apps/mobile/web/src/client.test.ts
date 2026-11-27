import { describe, expect, it, vi } from 'vitest'
import { GatewayClient, unwrapRpcResult } from './client'
import { NativeRequestError } from './native'
import type { Connection } from './types'

type FakeNative = ConstructorParameters<typeof GatewayClient>[0]
const asNative = (fake: { call: unknown; onStream: unknown }): FakeNative => fake as FakeNative

const CONN: Connection = {
  id: 'c1',
  name: '电脑',
  host: 'frp.example.com',
  port: 7001,
  fp: 'ef'.repeat(32),
  token: 'tok',
  desktopName: 'PC',
  createdAt: 0,
}

describe('unwrapRpcResult', () => {
  it('裸结果原样返回，{ok,result} 信封再解一层，错误信封抛错', () => {
    expect(unwrapRpcResult({ path: '/root', entries: [] })).toEqual({ path: '/root', entries: [] })
    expect(unwrapRpcResult({ ok: true, result: [1, 2] })).toEqual([1, 2])
    expect(unwrapRpcResult(null)).toBeNull()
    expect(unwrapRpcResult({ t: 'res', ok: true, result: 1 })).toEqual({ t: 'res', ok: true, result: 1 })
    expect(() => unwrapRpcResult({ ok: false, error: { code: 'not_connected', message: '未连接' } })).toThrow(
      NativeRequestError,
    )
    try {
      unwrapRpcResult({ ok: false, error: { code: 'not_connected', message: '未连接' } })
    } catch (err) {
      expect(err).toMatchObject({ code: 'not_connected', message: '未连接' })
    }
  })
})

describe('GatewayClient', () => {
  it('rpc 带上 host/port/fp/token 与 method/params，并兼容 agent', async () => {
    const call = vi.fn(async (_method: string, _params?: unknown) => ({ ok: true, result: { done: true } }))
    const onStream = vi.fn(() => () => undefined)
    const gateway = new GatewayClient(asNative({ call, onStream }))

    await expect(gateway.rpc(CONN, 'server.req', { targetId: 'local', method: 'ping' })).resolves.toEqual({
      done: true,
    })
    expect(call).toHaveBeenCalledWith('rpc', {
      host: 'frp.example.com',
      port: 7001,
      fp: CONN.fp,
      token: 'tok',
      method: 'server.req',
      params: { targetId: 'local', method: 'ping' },
    })

    await gateway.rpc(CONN, 'codex.send', { msg: { id: 1 } }, 'claude')
    expect(call).toHaveBeenLastCalledWith('rpc', expect.objectContaining({ agent: 'claude' }))
  })

  it('probe / pair / events / storage / clipboard 参数形状符合原生桥约定', async () => {
    const call = vi.fn(async (method: string) => (method === 'events.open' ? 's7' : { ok: true }))
    const gateway = new GatewayClient(asNative({ call, onStream: () => () => undefined }))

    await gateway.probe('192.168.1.2', 38500)
    expect(call).toHaveBeenCalledWith('probe', { host: '192.168.1.2', port: 38500 })

    await gateway.pair(
      { host: 'h', port: 38500, fp: CONN.fp, name: 'PC', code: 'secret' },
      '我的手机',
    )
    expect(call).toHaveBeenCalledWith('pair', {
      host: 'h',
      port: 38500,
      fp: CONN.fp,
      code: 'secret',
      deviceName: '我的手机',
    })

    await expect(gateway.openEvents(CONN)).resolves.toBe('s7')
    expect(call).toHaveBeenCalledWith('events.open', {
      host: CONN.host,
      port: CONN.port,
      fp: CONN.fp,
      token: CONN.token,
    })
    await gateway.closeEvents('s7')
    expect(call).toHaveBeenCalledWith('events.close', { stream: 's7' })
    await gateway.storageSet('connections', null)
    expect(call).toHaveBeenCalledWith('storage.set', { key: 'connections', value: null })
    await gateway.readClipboard()
    expect(call).toHaveBeenCalledWith('clipboard.read', {})
  })

  it('events.open 返回非字符串时报错', async () => {
    const call = vi.fn(async () => ({ stream: 1 }))
    const gateway = new GatewayClient(asNative({ call, onStream: () => () => undefined }))
    await expect(gateway.openEvents(CONN)).rejects.toBeInstanceOf(NativeRequestError)
  })
})
