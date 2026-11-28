import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { useApp } from './store'
import { EventStreamController } from './transport'

/** 模拟 Codex 首轮落盘前 thread/list 查不到新会话。 */
function hideThreads(value: unknown, hidden: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !hidden.has((item as { id?: string })?.id ?? '')).map((item) => hideThreads(item, hidden))
  }
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, key === 'data' ? hideThreads(item, hidden) : key === 'msg' || key === 'result' || key === 'payload' ? hideThreads(item, hidden) : item]))
}

it('新会话发出首条消息后立即进列表，服务端列出前刷新也保留', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'local-thread-desktop', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const hidden = new Set<string>()
  const controller = new EventStreamController(gateway, () => conn, {
    onEvent: (event) => state().handleGatewayEvent(hideThreads(event, hidden) as typeof event),
    onOpen: () => useApp.setState({ eventsConnected: true }),
    onClose: () => useApp.setState({ eventsConnected: false }),
  })
  const advance = async <T>(task: Promise<T>, ms = 300): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
  }
  const listed = (id: string) => state().threads.filter((thread) => thread.id === id)

  vi.useFakeTimers()
  setGateway(gateway)
  useApp.setState({ connections: [conn] })
  try {
    await advance(state().activate(conn.id))
    controller.start()
    await vi.advanceTimersByTimeAsync(20)
    await advance(state().selectTarget('local'))
    await advance(state().selectProject('p-local'))

    // 点“新建”后尚未发消息，不占列表位置。
    await expect(advance(state().newThread('codex'))).resolves.toBe(true)
    const created = state().selectedThreadId!
    hidden.add(created)
    await advance(state().refreshThreads())
    expect(listed(created)).toHaveLength(0)

    const task = state().send('第一条消息')
    await advance(task)
    expect(listed(created)).toMatchObject([{ title: '第一条消息', agent: 'codex' }])
    await advance(state().refreshThreads())
    expect(listed(created)).toHaveLength(1)

    // 服务端列出后以服务端为准，不重复。
    hidden.clear()
    await advance(state().refreshThreads())
    expect(listed(created)).toHaveLength(1)
  } finally {
    controller.stop()
    await advance(state().removeConnection(conn.id))
    vi.useRealTimers()
  }
})
