import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { serializeConnections } from './state'
import { selectedQueuedSends, useApp } from './store'

type Msg = { id: string; method: string; params: Record<string, unknown> }

it('锁屏期间电脑代发的消息，即使事件丢失，回到前台也显示消息和运行状态', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'relay-resume', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const view = () => state().sessions['codex:local']?.state.threads['t-demo']
  const queue = () => selectedQueuedSends(state()) ?? []
  const shown = () => view()?.items.filter((item) => item.kind === 'user' && item.text === '锁屏后排队') ?? []
  const relayed: { id: string; request: { method: Parameters<typeof gateway.rpc>[1]; params: { msg: Msg } } }[] = []
  let locked = false
  const actualOnStream = gateway.onStream.bind(gateway)
  // 锁屏时 WebView 收不到事件，事件流本身还没报告断开。
  vi.spyOn(gateway, 'onStream').mockImplementation((listener) => actualOnStream((message) => {
    if (locked && 'event' in message && message.event.name === 'codex.recv') return
    listener(message)
  }))
  const actualRpc = gateway.rpc.bind(gateway)
  vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
    const [, method, params] = args
    if (method === 'mobile.queue.put') {
      relayed.push(params as typeof relayed[number])
      return { ok: true } as never
    }
    if (method === 'mobile.queue.take') {
      return { queues: [{ targetId: 'local', agent: 'codex', threadId: 't-demo', sentIds: relayed.map((item) => item.id) }] } as never
    }
    const result = await actualRpc(...args)
    if (method === 'mobile.agents') return { ...result as object, backgroundQueue: true } as never
    return result
  })
  const advance = async <T>(task: Promise<T>, ms = 150): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
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

    await expect(advance(state().send('第一轮'), 30)).resolves.toBe(true)
    await expect(advance(state().send('锁屏后排队'), 30)).resolves.toBe(true)
    changeVisibility('hidden')
    await vi.advanceTimersByTimeAsync(100)
    expect(relayed).toHaveLength(1)

    // 刚进后台时手机还收得到第一轮结束，之后事件开始丢失。
    await vi.advanceTimersByTimeAsync(30_000)
    expect(view()?.status).toBe('idle')
    locked = true
    // 电脑在第一轮结束后代发。
    const { request } = relayed[0]!
    await advance(actualRpc(conn, request.method, { ...request.params, msg: { ...request.params.msg, id: 'relay-1' } }), 30)
    await vi.advanceTimersByTimeAsync(30)
    locked = false
    expect(shown()).toHaveLength(0)

    changeVisibility('visible')
    await vi.advanceTimersByTimeAsync(300)
    expect(queue()).toEqual([])
    expect(shown()).toHaveLength(1)
    expect(view()?.status).toBe('running')
  } finally {
    await advance(state().removeConnection(conn.id))
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setGateway(null)
  }
})
