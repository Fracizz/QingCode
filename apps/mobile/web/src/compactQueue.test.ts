import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { selectedCompactionBlockedReason, selectedQueuedSends, useApp } from './store'
import { EventStreamController } from './transport'

it('运行中发起压缩：排进队列，当前一轮结束后执行', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'compact-queue', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const controller = new EventStreamController(gateway, () => conn, {
    onEvent: (event) => state().handleGatewayEvent(event),
    onOpen: () => useApp.setState({ eventsConnected: true }),
    onClose: () => useApp.setState({ eventsConnected: false }),
  })
  const rpc = vi.spyOn(gateway, 'rpc')
  const sent = (method: string) => rpc.mock.calls.filter(([, name, params]) =>
    name === 'codex.send' && (params as { msg?: { method?: string } })?.msg?.method === method).length
  const queue = () => selectedQueuedSends(state()) ?? []
  const advance = async <T>(task: Promise<T>, ms = 150): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
  }

  vi.useFakeTimers()
  setGateway(gateway)
  useApp.setState({ connections: [conn] })
  try {
    await advance(state().activate(conn.id))
    controller.start()
    await vi.advanceTimersByTimeAsync(20)
    await advance(state().selectTarget('local'))
    await advance(state().selectProject('p-local'), 300)
    await expect(advance(state().openThread('t-demo', 'codex'))).resolves.toBe(true)

    await expect(advance(state().send('第一轮'), 30)).resolves.toBe(true)
    expect(selectedCompactionBlockedReason(state())).toBeNull()
    await expect(advance(state().compactConversation(), 30)).resolves.toBe(true)
    expect(queue()).toMatchObject([{ compact: true }])
    expect(selectedCompactionBlockedReason(state())).toBe('压缩已在排队')
    expect(sent('thread/compact/start')).toBe(0)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent('thread/compact/start')).toBe(1)
    expect(queue()).toEqual([])
  } finally {
    controller.stop()
    await advance(state().removeConnection(conn.id))
    vi.useRealTimers()
    setGateway(null)
  }
})
