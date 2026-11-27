import { describe, expect, it, vi } from 'vitest'
import { MobileQueueRelay, parseRelayPut, RELAY_TURN_FAILED, RELAY_UNCONFIRMED, type RelayItem, type RelayRequest } from './queue'

const address = { targetId: 'local', agent: 'claude' as const, threadId: 't1' }

function item(id: string): RelayItem {
  return {
    id,
    request: {
      method: 'codex.send',
      params: { targetId: 'local', agent: 'claude', msg: { method: 'turn/start', params: { threadId: 't1', input: [{ type: 'text', text: id }] } } },
    },
  }
}

const reply = (turnId: string, status = 'inProgress') => ({ id: 'x', result: { turn: { id: turnId, status } } })
const completed = (turnId: string, status = 'completed') => ({ method: 'turn/completed', params: { threadId: 't1', turn: { id: turnId, status } } })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(send: (request: RelayRequest) => Promise<unknown>) {
  const notify = vi.fn()
  const relay = new MobileQueueRelay({ send, notify })
  return { relay, notify }
}

describe('锁屏排队代发', () => {
  it('当前一轮结束后才依次发送，收回时返回已发出的消息', async () => {
    const sent: string[] = []
    let turn = 0
    const { relay, notify } = setup(async (request) => {
      sent.push(String((request.params.msg as { params: { input: { text: string }[] } }).params.input[0]!.text))
      return reply(`turn-${++turn}`)
    })
    relay.put('phone', address, item('a'), true)
    relay.put('phone', address, item('b'), true)
    await flush()
    expect(sent).toEqual([])

    relay.onNotification('local', 'claude', completed('earlier'))
    await flush()
    expect(sent).toEqual(['a'])
    // 第一条发出后这一轮在运行，第二条要等它结束。
    await flush()
    expect(sent).toEqual(['a'])
    relay.onNotification('local', 'claude', completed('turn-1'))
    await flush()
    expect(sent).toEqual(['a', 'b'])
    expect(notify).toHaveBeenLastCalledWith('phone', expect.objectContaining({ sentIds: ['a', 'b'], remaining: 0 }))

    await expect(relay.take('phone')).resolves.toEqual([{ ...address, sentIds: ['a', 'b'] }])
    expect(relay.size).toBe(0)
  })

  it('空闲时立即发送；回包前已结束的轮次不会卡住后续消息', async () => {
    const sent: string[] = []
    const { relay } = setup(async (request) => {
      const text = String((request.params.msg as { params: { input: { text: string }[] } }).params.input[0]!.text)
      sent.push(text)
      // 极短的一轮：结束事件先于回包到达。
      relay.onNotification('local', 'claude', completed(`turn-${text}`))
      return reply(`turn-${text}`)
    })
    relay.put('phone', address, item('a'), false)
    relay.put('phone', address, item('b'), false)
    await flush()
    await flush()
    expect(sent).toEqual(['a', 'b'])
  })

  it('上一轮失败或被中断时暂停，发送超时标记为未确认', async () => {
    const { relay } = setup(async () => reply('turn-1'))
    relay.put('phone', address, item('a'), true)
    relay.onNotification('local', 'claude', completed('earlier', 'interrupted'))
    await flush()
    await expect(relay.take('phone')).resolves.toEqual([{ ...address, sentIds: [], error: RELAY_TURN_FAILED }])

    const timeout = setup(async () => { throw { unconfirmed: true, message: '发送结果未确认' } })
    timeout.relay.put('phone', address, item('a'), false)
    await flush()
    await expect(timeout.relay.take('phone')).resolves.toEqual([{ ...address, sentIds: [], error: RELAY_UNCONFIRMED }])
  })

  it('收回时等待正在发送的那条，之后不再续发', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn(() => new Promise((done) => { resolve = done }))
    const { relay } = setup(send)
    relay.put('phone', address, item('a'), false)
    relay.put('phone', address, item('b'), false)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const taking = relay.take('phone')
    resolve(reply('turn-1', 'completed'))
    await expect(taking).resolves.toEqual([{ ...address, sentIds: ['a'] }])
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('不同设备与会话互不影响，重复提交同一条只保留一份', async () => {
    const send = vi.fn(async () => reply('turn-1'))
    const { relay } = setup(send)
    relay.put('phone', address, item('a'), true)
    relay.put('phone', address, item('a'), true)
    relay.put('tablet', address, item('c'), true)
    relay.onNotification('local', 'claude', { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'x', status: 'completed' } } })
    await flush()
    expect(send).not.toHaveBeenCalled()
    await expect(relay.take('phone')).resolves.toEqual([{ ...address, sentIds: [] }])
    expect(relay.size).toBe(1)
  })

  it('只接受发送一轮所需的参数', () => {
    const valid = { ...address, id: 'a', running: true, request: item('a').request }
    expect(parseRelayPut(valid)).toEqual({ address, item: item('a'), running: true })
    expect(parseRelayPut({ ...valid, request: { ...valid.request, method: 'server.req' } })).toBeNull()
    expect(parseRelayPut({ ...valid, threadId: 'other' })).toBeNull()
    expect(parseRelayPut({ ...valid, request: { method: 'codex.send', params: { ...valid.request.params, targetId: 'remote' } } })).toBeNull()
    expect(parseRelayPut({ ...valid, request: { method: 'codex.send', params: { targetId: 'local', agent: 'claude', msg: { method: 'turn/interrupt', params: { threadId: 't1' } } } } })).toBeNull()
  })
})
