import { describe, expect, it, vi } from 'vitest'
import type { AgentKind, BackendEvents } from '../../../shared/backendApi'
import { BackendCallError } from './backend'
import {
  BackendCodexTransport,
  advanceSeq,
  attachResult,
  filterRecv,
  maxSeq,
  openSeq,
  type TransportIo,
} from './codexTransport'

type RecvCallback = (payload: BackendEvents['codex.recv']) => void

function fakeIo() {
  let recv: RecvCallback | null = null
  const unsubscribe = vi.fn()
  const send = vi.fn<
    (targetId: string, agent: AgentKind, msg: unknown) => Promise<unknown>
  >(() => Promise.resolve(undefined))
  const io: TransportIo = {
    send,
    onRecv: (cb) => {
      recv = cb
      return unsubscribe
    },
  }
  return {
    io,
    send,
    unsubscribe,
    emit: (payload: BackendEvents['codex.recv']) => recv?.(payload),
  }
}

describe('codex.recv 过滤与序号', () => {
  it('只接受本目标、本 agent 且带 msg 的事件', () => {
    expect(filterRecv('local', 'codex', { targetId: 'local', seq: 3, msg: { method: 'x' } })).toEqual({
      targetId: 'local',
      seq: 3,
      msg: { method: 'x' },
    })
    expect(
      filterRecv('local', 'claude', { targetId: 'local', agent: 'claude', seq: 4, msg: {} }),
    ).toEqual({ targetId: 'local', seq: 4, msg: {} })
    expect(filterRecv('local', 'claude', { targetId: 'local', seq: 3, msg: {} })).toBeNull()
    expect(
      filterRecv('local', 'codex', { targetId: 'local', agent: 'claude', seq: 3, msg: {} }),
    ).toBeNull()
    expect(filterRecv('local', 'codex', { targetId: 'ssh-1', seq: 3, msg: {} })).toBeNull()
    expect(filterRecv('local', 'codex', { targetId: 'local', seq: 3 })).toBeNull()
    expect(filterRecv('local', 'codex', { targetId: 'local', seq: 'bad', msg: {} })).toEqual({
      targetId: 'local',
      seq: null,
      msg: {},
    })
    expect(
      filterRecv('local', 'codex', { targetId: 'local', agent: 'other', seq: 3, msg: {} }),
    ).toBeNull()
  })

  it('seq 单调递增且忽略 null', () => {
    expect(advanceSeq(null, 7)).toBe(7)
    expect(advanceSeq(7, 3)).toBe(7)
    expect(advanceSeq(7, 9)).toBe(9)
    expect(advanceSeq(7, null)).toBe(7)
    expect(maxSeq(2, 11)).toBe(11)
    expect(maxSeq(null, null)).toBeNull()
  })

  it('解析 codex.open / codex.attach 结果', () => {
    expect(openSeq({ lastSeq: 42 })).toBe(42)
    expect(openSeq({})).toBeNull()
    expect(attachResult({ lastSeq: 8, truncated: true })).toEqual({ lastSeq: 8, truncated: true })
    expect(attachResult(null)).toEqual({ lastSeq: null, truncated: false })
  })
})

describe('BackendCodexTransport', () => {
  it('按目标与 agent 过滤事件、传递 seq 并记住 lastSeq', () => {
    const fake = fakeIo()
    const transport = new BackendCodexTransport('local', 'codex', fake.io)
    const seen: Array<{ msg: unknown; seq: number | null }> = []
    transport.onMessage((msg, seq) => seen.push({ msg, seq }))

    fake.emit({ targetId: 'ssh-1', seq: 9, msg: { method: 'ignored' } })
    fake.emit({ targetId: 'local', agent: 'claude', seq: 9, msg: { method: 'ignored' } })
    fake.emit({ targetId: 'local', seq: 2, msg: { method: 'turn/started' } })
    fake.emit({ targetId: 'local', seq: null, msg: { id: 'c1', result: {} } })
    fake.emit({ targetId: 'local', seq: 1, msg: { method: 'old' } })

    expect(seen.map((entry) => entry.seq)).toEqual([2, null, 1])
    expect(seen[0]?.msg).toEqual({ method: 'turn/started' })
    expect(transport.getLastSeq()).toBe(2)
    transport.dispose()
    expect(fake.unsubscribe).toHaveBeenCalledOnce()
  })

  it('Claude 传输只接收带 claude 标签的帧', () => {
    const fake = fakeIo()
    const transport = new BackendCodexTransport('local', 'claude', fake.io)
    const seen: unknown[] = []
    transport.onMessage((msg) => seen.push(msg))
    fake.emit({ targetId: 'local', seq: 1, msg: { method: 'codex-only' } })
    fake.emit({ targetId: 'local', agent: 'claude', seq: 2, msg: { method: 'claude' } })
    expect(seen).toEqual([{ method: 'claude' }])
    expect(transport.getLastSeq()).toBe(2)
    transport.dispose()
  })

  it('发送带 targetId 与 agent，backend 拒绝时补本地错误响应避免请求挂起', async () => {
    const fake = fakeIo()
    fake.send.mockRejectedValue(new BackendCallError('not_implemented', 'codex.send 尚未实现'))
    const transport = new BackendCodexTransport('local', 'codex', fake.io)
    const seen: unknown[] = []
    transport.onMessage((msg) => seen.push(msg))

    transport.send({ id: 'c7', method: 'thread/list' })
    await Promise.resolve()
    await Promise.resolve()

    expect(fake.send).toHaveBeenCalledWith('local', 'codex', { id: 'c7', method: 'thread/list' })
    expect(seen).toEqual([
      {
        id: 'c7',
        error: {
          code: -32000,
          message: expect.stringContaining('后端功能尚未接入'),
        },
      },
    ])
    transport.dispose()
  })

  it('通知发送失败不产生伪造响应', async () => {
    const fake = fakeIo()
    fake.send.mockRejectedValue(new Error('boom'))
    const transport = new BackendCodexTransport('local', 'codex', fake.io)
    const seen: unknown[] = []
    transport.onMessage((msg) => seen.push(msg))
    transport.send({ method: 'initialized' })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([])
    transport.dispose()
  })

  it('dispose 后不再发送也不再分发', () => {
    const fake = fakeIo()
    const transport = new BackendCodexTransport('local', 'codex', fake.io)
    const seen: unknown[] = []
    transport.onMessage((msg) => seen.push(msg))
    transport.dispose()
    transport.send({ method: 'x' })
    fake.emit({ targetId: 'local', seq: null, msg: { method: 'x' } })
    expect(fake.send).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })
})
