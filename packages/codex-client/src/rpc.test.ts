import { describe, expect, it, vi } from 'vitest'
import type { ServerNotification, ServerRequest } from './codex-types'
import { CodexRpc, CodexRpcError } from './rpc'
import type { CodexTransport } from './rpc'

type Listener = (msg: unknown, seq: number | null) => void

class FakeTransport implements CodexTransport {
  readonly sent: unknown[] = []
  readonly listeners = new Set<Listener>()

  send(msg: unknown): void {
    this.sent.push(msg)
  }

  onMessage(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  emit(msg: unknown, seq: number | null = null): void {
    for (const cb of [...this.listeners]) cb(msg, seq)
  }
}

describe('CodexRpc', () => {
  it('使用 c<递增> id 并解析成功响应', async () => {
    const transport = new FakeTransport()
    const rpc = new CodexRpc(transport)

    const first = rpc.request('thread/list', { cwd: '/work' })
    const second = rpc.request('account/read', {})
    expect(transport.sent[0]).toEqual({ id: 'c1', method: 'thread/list', params: { cwd: '/work' } })
    expect(transport.sent[1]).toEqual({ id: 'c2', method: 'account/read', params: {} })

    const result = { data: [], nextCursor: null, backwardsCursor: null }
    transport.emit({ id: 'c1', result }, 7)
    transport.emit({ id: 'c2', result: { account: null } }, null)
    await expect(first).resolves.toEqual(result)
    await expect(second).resolves.toEqual({ account: null })
    rpc.dispose()
  })

  it('将 JSON-RPC 错误转换为 CodexRpcError', async () => {
    const transport = new FakeTransport()
    const rpc = new CodexRpc(transport)
    const pending = rpc.request('thread/read', { threadId: 't1' })
    transport.emit({ id: 'c1', error: { code: -123, message: '读取失败', data: { retry: false } } })
    await expect(pending).rejects.toMatchObject({
      name: 'CodexRpcError',
      code: -123,
      message: '读取失败',
      data: { retry: false },
    })
    await expect(pending).rejects.toBeInstanceOf(CodexRpcError)
    rpc.dispose()
  })

  it('分发通知与 server request，并生成响应帧', () => {
    const transport = new FakeTransport()
    const rpc = new CodexRpc(transport)
    const notifications: ServerNotification[] = []
    const requests: ServerRequest[] = []
    const offNotification = rpc.onNotification((n) => notifications.push(n))
    const offRequest = rpc.onServerRequest((r) => requests.push(r))

    const notification = { method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1' } } }
    const request = {
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', itemId: 'i1', command: 'echo hi' },
    }
    transport.emit(notification, 11)
    transport.emit(request, 12)
    expect(notifications).toEqual([notification])
    expect(requests).toEqual([request])

    rpc.respond(42, { decision: 'accept' })
    rpc.respondError(43, -1, '拒绝')
    expect(transport.sent[0]).toEqual({ id: 42, result: { decision: 'accept' } })
    expect(transport.sent[1]).toEqual({ id: 43, error: { code: -1, message: '拒绝' } })

    offNotification()
    offRequest()
    transport.emit({ method: 'unknown', params: {} })
    expect(notifications).toHaveLength(1)
    expect(requests).toHaveLength(1)
    rpc.dispose()
  })

  it('dispose 拒绝未决请求并取消传输订阅', async () => {
    const transport = new FakeTransport()
    const rpc = new CodexRpc(transport)
    const pending = rpc.request('model/list', {})
    rpc.dispose()

    await expect(pending).rejects.toThrow(/disposed/)
    await expect(rpc.request('model/list', {})).rejects.toThrow(/disposed/)
    expect(transport.listeners.size).toBe(0)
  })

  it('超时拒绝未决请求', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const rpc = new CodexRpc(transport, { timeoutMs: 10 })
    try {
      const pending = rpc.request('thread/list', {})
      vi.advanceTimersByTime(11)
      await expect(pending).rejects.toMatchObject({ code: -32000 })
    } finally {
      rpc.dispose()
      vi.useRealTimers()
    }
  })
})
