import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { useApp } from './store'
import { EventStreamController } from './transport'

it('使用重置卡后重新读取额度', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'reset-desktop', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const controller = new EventStreamController(gateway, () => conn, {
    onEvent: (event) => state().handleGatewayEvent(event),
    onOpen: () => useApp.setState({ eventsConnected: true }),
    onClose: () => useApp.setState({ eventsConnected: false }),
  })
  const entry = () => state().rateLimits.local

  vi.useFakeTimers()
  setGateway(gateway)
  useApp.setState({ connections: [conn] })
  try {
    const activated = state().activate(conn.id)
    await vi.advanceTimersByTimeAsync(90)
    await activated
    controller.start()
    await vi.advanceTimersByTimeAsync(20)
    const opened = state().ensureOpen('local', 'codex')
    await vi.advanceTimersByTimeAsync(500)
    await expect(opened).resolves.toBe(true)
    expect(entry()?.resetCredits?.availableCount).toBe(2)

    const used = state().consumeResetCredit('local', 'reset-credit-1')
    expect(entry()?.resetting).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    await used
    expect(entry()?.resetting).toBe(false)
    expect(entry()?.resetNotice?.tone).toBe('ok')
    expect(entry()?.resetCredits?.credits.map((credit) => credit.id)).toEqual(['reset-credit-2'])
  } finally {
    controller.stop()
    const removed = state().removeConnection(conn.id)
    await vi.advanceTimersByTimeAsync(90)
    await removed
    vi.useRealTimers()
    setGateway(null)
  }
})
