import { describe, expect, it } from 'vitest'
import {
  classifyJsonRpc,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcMessage,
} from './index'

describe('classifyJsonRpc', () => {
  it('识别请求（带/不带 jsonrpc 字段）', () => {
    expect(classifyJsonRpc({ id: 1, method: 'thread/start', params: { cwd: '/tmp' } })).toBe('request')
    expect(
      classifyJsonRpc({ jsonrpc: '2.0', id: 'c1', method: 'turn/start', params: {} }),
    ).toBe('request')
    expect(classifyJsonRpc({ id: 0, method: '' })).toBe('request')
  })

  it('识别通知（server→client 与 client→server 都一样）', () => {
    expect(classifyJsonRpc({ method: 'initialized' })).toBe('notification')
    expect(
      classifyJsonRpc({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { text: '你好' } }),
    ).toBe('notification')
  })

  it('识别响应与错误响应', () => {
    expect(classifyJsonRpc({ id: 1, result: { thread: { id: 't1' } } })).toBe('response')
    expect(classifyJsonRpc({ jsonrpc: '2.0', id: 'c2', result: null })).toBe('response')
    expect(classifyJsonRpc({ id: 1, error: { code: -32601, message: 'Method not found' } })).toBe(
      'response',
    )
    expect(
      classifyJsonRpc({
        id: 'c3',
        error: { code: -32000, message: 'boom', data: { retry: true } },
      }),
    ).toBe('response')
  })

  it('拒绝非法结构', () => {
    const invalid: unknown[] = [
      null,
      undefined,
      1,
      'x',
      [],
      [{ id: 1, result: 1 }],
      {},
      { jsonrpc: '1.0', method: 'ping' },
      { jsonrpc: '2.0' },
      { id: null, result: 1 },
      { id: true, result: 1 },
      { id: Number.NaN, method: 'ping' },
      { method: 123 },
      { id: 1 },
      { result: 1 },
      { id: 1, result: 1, error: { code: 1, message: 'x' } },
      { id: 1, method: 'ping', result: 1 },
      { id: 1, method: 'ping', error: { code: 1, message: 'x' } },
      { id: 1, error: { message: 'missing code' } },
      { id: 1, error: { code: 'oops', message: 'x' } },
      { id: 1, error: null },
    ]
    for (const value of invalid) expect(classifyJsonRpc(value)).toBe('invalid')
  })

  it('忽略未知扩展字段', () => {
    expect(classifyJsonRpc({ id: 1, method: 'ping', extra: { a: 1 } })).toBe('request')
    expect(classifyJsonRpc({ id: 1, result: 1, extra: true })).toBe('response')
  })

  it('类型守卫与分类结果一致', () => {
    const request = { id: 1, method: 'ping' }
    const notification = { method: 'tick', params: { n: 1 } }
    const response = { id: 1, result: 'pong' }
    expect(isJsonRpcRequest(request)).toBe(true)
    expect(isJsonRpcNotification(request)).toBe(false)
    expect(isJsonRpcResponse(request)).toBe(false)
    expect(isJsonRpcNotification(notification)).toBe(true)
    expect(isJsonRpcResponse(response)).toBe(true)
    const messages: JsonRpcMessage[] = [request, notification, response]
    expect(messages).toHaveLength(3)
  })
})
