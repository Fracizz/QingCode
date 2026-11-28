import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { modelPrefsOf, selectedQueuedSends, useApp } from './store'
import { EventStreamController } from './transport'

it('在空白会话或历史分支发送指定排队消息，原会话继续运行', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'queue-desktop', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const controller = new EventStreamController(gateway, () => conn, {
    onEvent: (event) => state().handleGatewayEvent(event),
    onOpen: () => useApp.setState({ eventsConnected: true }),
    onClose: () => useApp.setState({ eventsConnected: false }),
  })
  const advance = async <T>(task: Promise<T>, ms = 90): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
  }
  const texts = (threadId: string, agent = 'codex') => state().sessions[`${agent}:local`]?.state.threads[threadId]?.items
    .flatMap((item) => item.kind === 'user' ? [item.text] : [])
  const queue = () => selectedQueuedSends(state()) ?? []
  const actualRpc = gateway.rpc.bind(gateway)
  let rejectStart = false
  const rpc = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
    const [, method, params] = args
    const request = (params as { msg?: { method?: string } })?.msg
    if (rejectStart && method === 'codex.send' && request?.method === 'thread/start') throw new Error('测试：会话创建失败')
    return actualRpc(...args)
  })

  vi.useFakeTimers()
  setGateway(gateway)
  useApp.setState({ connections: [conn] })
  try {
    await advance(state().activate(conn.id))
    controller.start()
    await vi.advanceTimersByTimeAsync(20)
    await advance(state().selectTarget('local'))
    await advance(state().selectProject('p-local'), 250)
    await expect(advance(state().openThread('t-demo', 'codex'))).resolves.toBe(true)
    await expect(advance(state().send('原会话正在运行'), 25)).resolves.toBe(true)
    const chosen = { model: 'gpt-5.5-mini', effort: 'high', fast: false }
    state().rememberThreadPrefs('local', 'codex', 't-demo', chosen)

    state().setDraftText('空白会话消息')
    state().addAnnotation('引用内容')
    const png = 'data:image/png;base64,AA=='
    await expect(advance(state().send('空白会话消息', [{ type: 'image', url: png }]), 30)).resolves.toBe(true)
    await expect(advance(state().send('分支消息'), 30)).resolves.toBe(true)
    const [blank, branch] = queue()
    const sourceKey = JSON.stringify([conn.id, 'local', 'codex', 't-demo'])
    expect(blank?.attachments).toHaveLength(1)
    const release = state().beginQueuedEdit(blank!.id)!
    await expect(state().sendQueuedInNewThread(blank!.id, 'start')).resolves.toBe(false)
    release(false)
    await expect(advance(state().sendQueuedInNewThread(blank!.id, 'start'), 55)).resolves.toBe(true)
    const startedId = state().selectedThreadId!
    expect(startedId).not.toBe('t-demo')
    // 新会话沿用原会话的模型与推理强度。
    expect(modelPrefsOf(state(), 'local', 'codex', startedId)).toMatchObject({ model: chosen.model })
    expect(texts(startedId)).toEqual(['> 引用内容\n\n空白会话消息'])
    expect(rpc.mock.calls).toContainEqual([
      conn, 'codex.send', expect.objectContaining({ msg: expect.objectContaining({
        method: 'turn/start', params: expect.objectContaining({
          threadId: startedId, input: expect.arrayContaining([{ type: 'image', url: png }]),
        }),
      }) }),
    ])
    expect(state().queuedSends[sourceKey]?.map((item) => item.id)).toEqual([branch!.id])

    await expect(advance(state().openThread('t-demo', 'codex'), 35)).resolves.toBe(true)
    expect(state().sessions['codex:local']?.state.threads['t-demo']?.status).toBe('running')
    await expect(advance(state().sendQueuedInNewThread(branch!.id, 'continue'), 85)).resolves.toBe(true)
    const continuedId = state().selectedThreadId!
    expect(continuedId).not.toBe(startedId)
    expect(texts(continuedId)).toEqual(['你好', '分支消息'])
    expect(texts('t-demo')).toEqual(['你好', '原会话正在运行'])
    expect(state().queuedSends[sourceKey]).toBeUndefined()
    expect(rpc.mock.calls).toContainEqual([
      conn, 'codex.send', expect.objectContaining({ msg: expect.objectContaining({
        method: 'thread/fork', params: { threadId: 't-demo', lastTurnId: 'turn-history-t-demo', excludeTurns: true },
      }) }),
    ])
    expect(rpc.mock.calls.some(([, method, params]) =>
      method === 'codex.send' && (params as { msg?: { method?: string } })?.msg?.method === 'turn/interrupt')).toBe(false)

    // 从某条回复分叉：只保留到该轮，并切到新会话。
    await expect(advance(state().openThread('t-demo', 'codex'), 35)).resolves.toBe(true)
    await expect(advance(state().forkConversation('turn-history-t-demo'), 85)).resolves.toBe(true)
    expect([startedId, continuedId, 't-demo']).not.toContain(state().selectedThreadId)
    expect(texts(state().selectedThreadId!)).toEqual(['你好'])
    expect(rpc.mock.calls.filter(([, method, params]) =>
      method === 'codex.send' && (params as { msg?: { method?: string } })?.msg?.method === 'thread/fork')).toHaveLength(2)

    await expect(advance(state().openThread('c-demo', 'claude'))).resolves.toBe(true)
    await expect(advance(state().send('Claude 原会话'), 25)).resolves.toBe(true)
    await expect(advance(state().send('Claude 排队消息'), 30)).resolves.toBe(true)
    const queued = queue()[0]!
    rejectStart = true
    await expect(advance(state().sendQueuedInNewThread(queued.id, 'start'), 35)).resolves.toBe(false)
    expect(state().selectedThreadId).toBe('c-demo')
    expect(queue()[0]).toMatchObject({ id: queued.id, sending: false, error: '测试：会话创建失败' })
    rejectStart = false
    await expect(advance(state().sendQueuedInNewThread(queued.id, 'start'), 65)).resolves.toBe(true)
    expect(texts(state().selectedThreadId!, 'claude')).toEqual(['Claude 排队消息'])
  } finally {
    controller.stop()
    await advance(state().removeConnection(conn.id))
    vi.useRealTimers()
    setGateway(null)
  }
})
