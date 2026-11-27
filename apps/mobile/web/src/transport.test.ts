import { describe, expect, it, vi } from 'vitest'
import type { Connection, GatewayEvent } from './types'
import {
  advanceSeq,
  attachResult,
  EventStreamController,
  filterRecv,
  isHeartbeat,
  maxSeq,
  MobileCodexTransport,
  openSeq,
  reconnectDelay,
  seqOf,
} from './transport'

const CONN: Connection = {
  id: 'c1',
  name: '电脑',
  host: '192.168.1.2',
  port: 38500,
  fp: 'ab'.repeat(32),
  token: 'tok',
  desktopName: 'PC',
  createdAt: 0,
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('seq 与回放解析', () => {
  it('seqOf 过滤非数字', () => {
    expect(seqOf(7)).toBe(7)
    expect(seqOf(null)).toBeNull()
    expect(seqOf('7')).toBeNull()
    expect(seqOf(Number.NaN)).toBeNull()
  })

  it('filterRecv 按 targetId / agent 过滤，响应帧 seq 为 null', () => {
    expect(filterRecv({ targetId: 'local', seq: 3, msg: { method: 'x' } }, 'local')).toEqual({
      targetId: 'local',
      seq: 3,
      msg: { method: 'x' },
    })
    expect(filterRecv({ targetId: 'local', seq: null, msg: { id: 1 }, agent: 'codex' }, 'local', 'codex')).toMatchObject({
      seq: null,
      agent: 'codex',
    })
    expect(filterRecv({ targetId: 'local', seq: 1, msg: {}, agent: 'claude' }, 'local', 'codex')).toBeNull()
    expect(filterRecv({ targetId: 'other', seq: 1, msg: {} }, 'local')).toBeNull()
    expect(filterRecv({ targetId: 'local', seq: 1 }, 'local')).toBeNull()
    expect(filterRecv(null, 'local')).toBeNull()
  })

  it('advanceSeq / maxSeq / openSeq / attachResult', () => {
    expect(advanceSeq(3, null)).toBe(3)
    expect(advanceSeq(3, 2)).toBe(3)
    expect(advanceSeq(3, 9)).toBe(9)
    expect(advanceSeq(null, 4)).toBe(4)
    expect(maxSeq(2, 8)).toBe(8)
    expect(openSeq({ lastSeq: 12 })).toBe(12)
    expect(openSeq({})).toBeNull()
    expect(attachResult({ lastSeq: 5, truncated: true })).toEqual({ lastSeq: 5, truncated: true })
    expect(attachResult(null)).toEqual({ lastSeq: null, truncated: false })
    expect(isHeartbeat({ name: 'ping' })).toBe(true)
    expect(isHeartbeat({ name: 'target.state' })).toBe(false)
  })

  it('退避 1s→30s 封顶', () => {
    expect(reconnectDelay(0)).toBe(1000)
    expect(reconnectDelay(1)).toBe(2000)
    expect(reconnectDelay(5)).toBe(30_000)
    expect(reconnectDelay(99)).toBe(30_000)
  })
})

describe('MobileCodexTransport', () => {
  it('send 转发消息、handleRecv 只投递本目标并推进 lastSeq', () => {
    const send = vi.fn(async (_msg: unknown) => null)
    const transport = new MobileCodexTransport('local', send)
    const seen: Array<{ msg: unknown; seq: number | null }> = []
    transport.onMessage((msg, seq) => seen.push({ msg, seq }))

    transport.send({ id: 'c1', method: 'thread/list' })
    const sent = send.mock.calls[0]?.[0] as { id: string }
    expect(sent).toMatchObject({ id: expect.stringMatching(/^mobile-.+:c1$/), method: 'thread/list' })

    transport.handleRecv({ targetId: 'local', seq: 7, msg: { method: 'turn/started' } })
    transport.handleRecv({ targetId: 'other', seq: 8, msg: { method: 'ignored' } })
    transport.handleRecv({ targetId: 'local', seq: null, msg: { id: 'c1', result: { unrelated: true } } })
    transport.handleRecv({ targetId: 'local', seq: null, msg: { id: sent.id, result: {} } })
    expect(seen).toEqual([
      { msg: { method: 'turn/started' }, seq: 7 },
      { msg: { id: 'c1', result: {} }, seq: null },
    ])
    expect(transport.getLastSeq()).toBe(7)
    transport.setLastSeq(3)
    expect(transport.getLastSeq()).toBe(7)
    transport.setLastSeq(10)
    expect(transport.getLastSeq()).toBe(10)
    transport.dispose()
    transport.send({ id: 'c2' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('同一电脑的两台手机分别接收自己的回包，审批编号保持原样', async () => {
    const send = vi.fn(async (_msg: unknown) => null)
    const first = new MobileCodexTransport('local', send)
    const second = new MobileCodexTransport('local', send)
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    first.onMessage(firstListener)
    second.onMessage(secondListener)
    first.send({ id: 'c1', method: 'thread/list' })
    second.send({ id: 'c1', method: 'thread/resume' })
    const firstId = (send.mock.calls[0]?.[0] as { id: string }).id
    const secondId = (send.mock.calls[1]?.[0] as { id: string }).id
    expect(firstId).not.toBe(secondId)
    for (const transport of [first, second]) {
      transport.handleRecv({ targetId: 'local', seq: null, msg: { id: secondId, result: 'second' } })
      transport.handleRecv({ targetId: 'local', seq: null, msg: { id: firstId, result: 'first' } })
    }
    expect(firstListener).toHaveBeenCalledExactlyOnceWith({ id: 'c1', result: 'first' }, null)
    expect(secondListener).toHaveBeenCalledExactlyOnceWith({ id: 'c1', result: 'second' }, null)
    await first.respond('approval-id', { decision: 'decline' })
    expect(send).toHaveBeenLastCalledWith({ id: 'approval-id', result: { decision: 'decline' } })
  })

  it('发送被网关拒绝时补本地错误响应，避免 RPC 挂起', async () => {
    const send = vi.fn(async () => Promise.reject(new Error('网关拒绝')))
    const transport = new MobileCodexTransport('local', send)
    const seen: unknown[] = []
    transport.onMessage((msg) => seen.push(msg))
    transport.send({ id: 'c9', method: 'thread/list' })
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'c9', error: { code: -32000, message: '网关拒绝' } })
  })

  it('重复回放只投递一次，旧序号未决审批仍可补收，daemon 换代可从零开始', () => {
    const transport = new MobileCodexTransport('local', async () => null)
    const received = vi.fn()
    transport.onMessage(received)
    const recv = (seq: number) => transport.handleRecv({ targetId: 'local', seq, msg: { id: seq } })
    recv(4)
    recv(4)
    recv(2)
    expect(received.mock.calls.map((call) => call[1])).toEqual([4, 2])
    expect(transport.getLastSeq()).toBe(4)
    transport.resetSequence()
    recv(2)
    expect(received).toHaveBeenCalledTimes(3)
    expect(transport.getLastSeq()).toBe(2)
  })
})

type StreamCb = (msg: { stream: string; event: GatewayEvent } | { stream: string; closed: true; error: string | null }) => void

function fakeStreamGateway() {
  const listeners = new Set<StreamCb>()
  const gateway = {
    openEvents: vi.fn(async (_conn: Connection) => 's1'),
    closeEvents: vi.fn(async (_stream: string) => undefined),
    onStream: vi.fn((cb: StreamCb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
  }
  const emit = (msg: Parameters<StreamCb>[0]): void => {
    for (const cb of [...listeners]) cb(msg)
  }
  return { gateway, emit }
}

describe('EventStreamController', () => {
  it('打开流后分发事件；断开按退避重连并对已打开目标重新 attach', async () => {
    const { gateway, emit } = fakeStreamGateway()
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const handlers = {
      onEvent: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
    }
    const controller = new EventStreamController(
      gateway,
      () => CONN,
      handlers,
      (fn, ms) => {
        scheduled.push({ fn, ms })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      vi.fn(),
    )

    controller.start()
    await flush()
    expect(gateway.openEvents).toHaveBeenCalledWith(CONN)
    expect(handlers.onOpen).toHaveBeenCalledWith(false)

    emit({ stream: 's1', event: { name: 'target.state', payload: { id: 'local', state: 'ready' } } })
    emit({ stream: 'other', event: { name: 'ping' } })
    expect(handlers.onEvent).toHaveBeenCalledTimes(1)

    emit({ stream: 's1', closed: true, error: '事件流已断开' })
    expect(handlers.onClose).toHaveBeenCalledWith('事件流已断开')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.ms).toBe(1000)

    scheduled[0]?.fn()
    await flush()
    expect(gateway.openEvents).toHaveBeenCalledTimes(2)
    expect(handlers.onOpen).toHaveBeenLastCalledWith(true)

    controller.stop()
    expect(gateway.closeEvents).toHaveBeenCalledWith('s1')
    emit({ stream: 's1', closed: true, error: null })
    expect(scheduled).toHaveLength(1)
  })

  it('没有活动连接时不发起请求；打开失败会安排重试', async () => {
    const { gateway } = fakeStreamGateway()
    gateway.openEvents.mockRejectedValueOnce(new Error('电脑离线'))
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const handlers = { onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() }
    const schedule = (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms })
      return scheduled.length as unknown as ReturnType<typeof setTimeout>
    }
    const controller = new EventStreamController(gateway, () => null, handlers, schedule, vi.fn())
    controller.start()
    await flush()
    expect(gateway.openEvents).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)

    const withConn = new EventStreamController(gateway, () => CONN, handlers, schedule, vi.fn())
    withConn.start()
    await flush()
    expect(handlers.onClose).toHaveBeenCalledWith('电脑离线')
    expect(scheduled).toHaveLength(1)
  })

  it('恢复前台可立即检查流，收到设备撤销就停止重试', async () => {
    const { gateway, emit } = fakeStreamGateway()
    const schedule = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
    const handlers = { onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onRepair: vi.fn() }
    const controller = new EventStreamController(gateway, () => CONN, handlers, schedule, vi.fn())
    controller.start()
    await flush()
    controller.wake(true)
    await flush()
    expect(gateway.openEvents).toHaveBeenCalledTimes(2)
    emit({ stream: 's1', event: { name: 'unauthorized' } })
    expect(handlers.onRepair).toHaveBeenCalledExactlyOnceWith('unauthorized', '设备已被撤销，请重新配对')
    controller.wake(true)
    expect(gateway.openEvents).toHaveBeenCalledTimes(2)
    expect(schedule).not.toHaveBeenCalled()
  })
})
