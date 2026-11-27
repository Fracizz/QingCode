import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { UNCONFIRMED_QUEUED_SEND } from './queuedSends'
import { serializeConnections } from './state'
import { selectedQueuedSends, useApp } from './store'

it('重连补齐会话后续发待发消息，保留中断或提交结果未确认的消息', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'desktop', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const view = () => state().sessions['codex:local']?.state.threads['t-demo']
  const queue = () => selectedQueuedSends(state()) ?? []
  const openEvents = gateway.openEvents.bind(gateway)
  const opened = vi.spyOn(gateway, 'openEvents')
  const actualRpc = gateway.rpc.bind(gateway)
  let readHeld = false
  let releaseRead: (() => void) | undefined
  let lostReply: string | undefined
  const actualOnStream = gateway.onStream.bind(gateway)
  vi.spyOn(gateway, 'onStream').mockImplementation((listener) => actualOnStream((message) => {
    if ('event' in message && message.event.name === 'codex.recv') {
      const payload = message.event.payload as { msg?: { id?: string } }
      if (lostReply && payload.msg?.id === lostReply) return
    }
    listener(message)
  }))
  const rpc = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
    const [, method, params] = args
    const msg = (params as { msg?: { id: string; method: string; params?: { input?: { text: string }[] } } })?.msg
    if (method === 'codex.send' && msg?.method === 'thread/read' && readHeld) {
      await new Promise<void>((resolve) => { releaseRead = resolve })
    }
    if (method === 'codex.send' && msg?.method === 'turn/start' && msg.params?.input?.[0]?.text === '结果丢失') {
      lostReply = msg.id
    }
    const result = await actualRpc(...args)
    if (method === 'server.req' && typeof params === 'object' && params !== null && 'method' in params) {
      if (params.method === 'codex.attach') return { ...result as object, mobileAccessModes: undefined }
      if (params.method === 'codex.open') return { ...result as object, mobileAccessModes: true }
    }
    return result
  })
  const sent = (text: string) => rpc.mock.calls.filter(([, method, params]) => {
    const msg = (params as { msg?: { method: string; params?: { input?: { text: string }[] } } })?.msg
    return method === 'codex.send' && msg?.method === 'turn/start' && msg.params?.input?.[0]?.text === text
  })
  const advance = async <T>(task: Promise<T>, ms = 150): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
  }
  const disconnect = async () => {
    const stream = await opened.mock.results.at(-1)?.value
    await advance(gateway.closeEvents(stream), 30)
    expect(state().eventsConnected).toBe(false)
    expect(state().eventsError).toBeNull()
  }

  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const changeVisibility = (visibility: 'visible' | 'hidden') => {
    document.visibilityState = visibility
    document.dispatchEvent(new Event('visibilitychange'))
  }

  vi.useFakeTimers()
  vi.stubGlobal('document', document)
  setGateway(gateway)
  try {
    await advance(Promise.all([
      gateway.storageSet('connections', serializeConnections([conn])),
      gateway.storageSet('active', conn.id),
    ]))
    state().init()
    await vi.advanceTimersByTimeAsync(300)
    await advance(state().selectTarget('local'))
    await advance(state().selectProject('p-local'), 300)
    await expect(advance(state().openThread('t-demo', 'codex'))).resolves.toBe(true)
    expect(state().sessions['codex:local']?.accessSupported).toBe(true)

    await expect(advance(state().send('第一轮'), 30)).resolves.toBe(true)
    await expect(advance(state().send('锁屏前排队'), 30)).resolves.toBe(true)
    await disconnect()
    await expect(advance(state().send('离线时排队'), 30)).resolves.toBe(true)
    expect(queue().map((item) => [item.text, item.error])).toEqual([
      ['锁屏前排队', undefined], ['离线时排队', undefined],
    ])
    readHeld = true
    await vi.advanceTimersByTimeAsync(1400)
    expect(state().eventsConnected).toBe(true)
    expect(releaseRead).toBeTypeOf('function')
    expect(sent('锁屏前排队')).toHaveLength(0)
    readHeld = false
    releaseRead?.()
    await vi.advanceTimersByTimeAsync(2200)
    expect(sent('锁屏前排队')).toHaveLength(1)
    expect(sent('离线时排队')).toHaveLength(1)
    expect(queue()).toEqual([])
    expect(state().sessions['codex:local']?.accessSupported).toBe(true)
    expect(state().backgroundConnectionEnabled).toBe(true)

    await expect(advance(state().send('目标掉线前的一轮'), 30)).resolves.toBe(true)
    await expect(advance(state().send('等待目标自动重连'), 30)).resolves.toBe(true)
    const targetState = (stateName: 'error' | 'connecting' | 'ready') => state().handleGatewayEvent({
      name: 'target.state', payload: { id: 'local', state: stateName },
    })
    targetState('error')
    await vi.advanceTimersByTimeAsync(1000)
    expect(queue().map(({ error }) => error)).toEqual([undefined])
    expect(sent('等待目标自动重连')).toHaveLength(0)
    targetState('connecting')
    targetState('ready')
    await vi.advanceTimersByTimeAsync(1900)
    expect(sent('等待目标自动重连')).toHaveLength(1)
    expect(queue()).toEqual([])

    useApp.setState({ backgroundConnectionEnabled: false })
    await expect(advance(state().send('切到后台前的一轮'), 30)).resolves.toBe(true)
    await expect(advance(state().send('等回到前台再发送'), 30)).resolves.toBe(true)
    changeVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1200)
    expect(sent('等回到前台再发送')).toHaveLength(0)
    expect(queue().map(({ error }) => error)).toEqual([undefined])
    changeVisibility('visible')
    await vi.advanceTimersByTimeAsync(1200)
    expect(sent('等回到前台再发送')).toHaveLength(1)
    expect(queue()).toEqual([])

    await expect(advance(state().send('后来被中断的一轮'), 30)).resolves.toBe(true)
    const interruptedTurnId = view()?.activeTurnId
    expect(interruptedTurnId).toBeTruthy()
    await expect(advance(state().send('等待手动确认'), 30)).resolves.toBe(true)
    await disconnect()
    await advance(gateway.rpc(conn, 'codex.send', {
      targetId: 'local', agent: 'codex', msg: {
        id: 'desktop-interrupt', method: 'turn/interrupt', params: { threadId: 't-demo', turnId: interruptedTurnId },
      },
    }), 30)
    await vi.advanceTimersByTimeAsync(2000)
    expect(view()?.activity).toBe('interrupted')
    expect(sent('等待手动确认')).toHaveLength(0)
    expect(queue()[0]?.error).toContain('上一轮未完成')
    state().removeQueuedSend(queue()[0]!.id)

    await expect(advance(state().send('发送结果前的一轮'), 30)).resolves.toBe(true)
    await expect(advance(state().send('结果丢失'), 30)).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(900)
    expect(sent('结果丢失')).toHaveLength(1)
    expect(queue()[0]?.sending).toBe(true)
    await disconnect()
    await vi.advanceTimersByTimeAsync(32_000)
    expect(view()?.items.filter((item) => item.kind === 'user' && item.text === '结果丢失')).toHaveLength(1)
    expect(queue()[0]).toMatchObject({ text: '结果丢失', sending: false, error: UNCONFIRMED_QUEUED_SEND })
    expect(sent('结果丢失')).toHaveLength(1)

    opened.mockRejectedValue(new Error('电脑当前不可达'))
    await disconnect()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(state().eventsError).toBeNull()
    await vi.advanceTimersByTimeAsync(17_000)
    expect(state().eventsError).toBe('暂时无法连接电脑，正在自动重试。')
    opened.mockImplementation(openEvents)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state().eventsConnected).toBe(true)
    expect(state().eventsError).toBeNull()
  } finally {
    releaseRead?.()
    await advance(state().removeConnection(conn.id))
    useApp.setState({ backgroundConnectionEnabled: true })
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setGateway(null)
  }
})
