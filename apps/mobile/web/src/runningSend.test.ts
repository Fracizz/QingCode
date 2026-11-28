import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { selectedQueuedSends, useApp } from './store'
import { EventStreamController } from './transport'

it('引导不可用时消息转入排队，打断失败时留在队首，结果未确认时保留草稿', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'running-send', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const controller = new EventStreamController(gateway, () => conn, {
    onEvent: (event) => state().handleGatewayEvent(event),
    onOpen: () => useApp.setState({ eventsConnected: true }),
    onClose: () => useApp.setState({ eventsConnected: false }),
  })
  const advance = async <T>(task: Promise<T>, ms = 30): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
  }
  const view = () => state().sessions['codex:local']?.state.threads['t-demo']
  const queue = () => selectedQueuedSends(state()) ?? []
  const actualRpc = gateway.rpc.bind(gateway)
  // 让模拟网关按过期的轮次编号拒绝请求，或让引导请求发不出去。
  let failure: 'steer' | 'interrupt' | 'network' | null = null
  const methods: string[] = []
  const rpc = vi.spyOn(gateway, 'rpc').mockImplementation(async (connection, method, params, agent, timeout) => {
    const msg = (params as { msg?: { method?: string; params?: Record<string, unknown> } } | undefined)?.msg
    if (method === 'codex.send' && msg?.method?.startsWith('turn/')) {
      methods.push(msg.method)
      if (failure === 'network' && msg.method === 'turn/steer') throw new Error('测试：网络中断')
      if (failure && msg.method === `turn/${failure}`) {
        const stale = { ...msg, params: { ...msg.params, expectedTurnId: 'stale', turnId: 'stale' } }
        return actualRpc(connection, method, { ...(params as object), msg: stale }, agent, timeout)
      }
    }
    return actualRpc(connection, method, params, agent, timeout)
  })

  vi.useFakeTimers()
  setGateway(gateway)
  useApp.setState({ connections: [conn] })
  try {
    await advance(state().activate(conn.id), 90)
    controller.start()
    await vi.advanceTimersByTimeAsync(20)
    await advance(state().selectTarget('local'), 90)
    await advance(state().selectProject('p-local'), 250)
    await expect(advance(state().openThread('t-demo', 'codex'), 90)).resolves.toBe(true)
    await expect(advance(state().send('开始一轮'), 25)).resolves.toBe(true)
    expect(view()?.status).toBe('running')
    methods.length = 0

    await expect(advance(state().send('/review 看一下', [], false, 'steer'), 60)).resolves.toBe(true)
    expect(methods).toEqual([])
    expect(queue().map((item) => item.text)).toEqual(['/review 看一下'])
    await expect(state().steerQueuedSend(queue()[0]!.id)).resolves.toBe(false)
    expect(methods).toEqual([])
    state().removeQueuedSend(queue()[0]!.id)

    failure = 'steer'
    await expect(advance(state().send('被拒绝的补充', [], false, 'steer'), 60)).resolves.toBe(true)
    expect(methods).toEqual(['turn/steer'])
    expect(queue().map((item) => item.text)).toEqual(['被拒绝的补充'])
    expect(state().notice).toBe('当前无法引导，消息已排队')
    await expect(advance(state().steerQueuedSend(queue()[0]!.id), 30)).resolves.toBe(false)
    expect(queue()[0]).toMatchObject({ text: '被拒绝的补充', sending: false })
    expect(queue()[0]?.error).toBeUndefined()

    failure = 'network'
    state().setDraftText('结果未确认')
    await expect(advance(state().send('结果未确认', [], false, 'steer'), 60)).resolves.toBe(false)
    expect(state().draftText).toBe('结果未确认')
    expect(queue().map((item) => item.text)).toEqual(['被拒绝的补充'])
    expect(queue()[0]?.error).toBeUndefined()

    failure = 'interrupt'
    methods.length = 0
    await expect(advance(state().send('打断修正', [], false, 'immediate'), 60)).resolves.toBe(true)
    expect(methods).toEqual(['turn/interrupt'])
    expect(queue().map((item) => item.text)).toEqual(['打断修正', '被拒绝的补充'])
    expect(queue()[0]?.error).toBe('打断未成功，消息已保留在队列')
    expect(view()?.status).toBe('running')
  } finally {
    controller.stop()
    await advance(state().removeConnection(conn.id), 90)
    rpc.mockRestore()
    vi.useRealTimers()
  }
})
