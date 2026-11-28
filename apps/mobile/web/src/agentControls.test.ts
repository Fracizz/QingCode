import { planApproval, type SessionAccessMode } from '@qn/codex-client'
import { expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { serializeConnections } from './state'
import { selectedAccessMode, selectedPendingSteers, selectedPlanReturn, selectedQueuedSends, useApp } from './store'

type Msg = { id: string; method: string; params: Record<string, unknown> }

it('计划模式随批准切回、后台任务可停止、撤回的引导放回队列且不自动重发', async () => {
  const gateway = createGateway()
  const conn = {
    id: 'agent-controls', name: '测试电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '测试电脑', createdAt: 0,
  }
  const state = useApp.getState
  const actualRpc = gateway.rpc.bind(gateway)
  const sent: Msg[] = []
  const relay: string[] = []
  let relayEnabled = false
  let swallowSteer = false
  let stopFails = false
  let seq = 1_000_000
  const push = (msg: unknown) => state().handleGatewayEvent({
    name: 'codex.recv', payload: { targetId: 'local', agent: 'claude', seq: ++seq, msg },
  })
  const reply = (id: string, result: unknown, error?: unknown) => state().handleGatewayEvent({
    name: 'codex.recv',
    payload: { targetId: 'local', agent: 'claude', seq: null, msg: error ? { id, error } : { id, result } },
  })
  const rpc = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
    const [, method, params] = args
    const request = params as { msg?: Msg; method?: string }
    const msg = request?.msg
    if (method === 'codex.send' && msg?.method) {
      sent.push(msg)
      if (msg.method === 'qingcode/backgroundTasks/list') {
        reply(msg.id, { tasks: [{ id: 'build', type: 'local_bash', description: '构建' }] })
        return null as never
      }
      if (msg.method === 'qingcode/backgroundTasks/stop') {
        if (stopFails) reply(msg.id, undefined, { code: -32602, message: '该会话没有运行中的后台任务' })
        else reply(msg.id, {})
        return null as never
      }
      if (msg.method === 'turn/steer' && swallowSteer) {
        reply(msg.id, { turnId: msg.params.expectedTurnId })
        return null as never
      }
    }
    if (method === 'mobile.queue.put') {
      relay.push((params as { id: string }).id)
      return { ok: true } as never
    }
    if (method === 'mobile.queue.take') return { queues: [] } as never
    const result = await actualRpc(...args)
    if (method === 'mobile.agents' && relayEnabled) return { ...result as object, backgroundQueue: true } as never
    if (method === 'server.req' && request.method === 'codex.open') return { ...result as object, mobileAccessModes: true } as never
    return result
  })
  const turnStarts = () => rpc.mock.calls.filter(([, method, params]) => method === 'mobile.turn.start'
    || (method === 'codex.send' && (params as { msg?: Msg }).msg?.method === 'turn/start'))
  const advance = async <T>(task: Promise<T>, ms = 150): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return task
  }
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const changeVisibility = (visibility: 'visible' | 'hidden') => {
    document.visibilityState = visibility
    document.dispatchEvent(new Event('visibilitychange'))
  }
  const view = () => state().sessions['claude:local']?.state.threads['c-demo']
  const queue = () => selectedQueuedSends(state()) ?? []
  const planItem = (id: string, status: string) => ({
    type: 'dynamicToolCall', id, namespace: null, tool: 'ExitPlanMode', arguments: { plan: '## 计划\n\n1. 修改' }, status,
  })

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
    await expect(advance(state().openThread('c-demo', 'claude'))).resolves.toBe(true)

    // 选计划模式记下原档位，发送走 mobile.turn.start。
    state().setAccessMode('fullAccess')
    state().setAccessMode('plan')
    state().setAccessMode('plan')
    expect(selectedAccessMode(state())).toBe('plan' satisfies SessionAccessMode)
    expect(selectedPlanReturn(state())).toBe('fullAccess')
    await expect(advance(state().send('慢慢规划'), 30)).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith(expect.anything(), 'mobile.turn.start', expect.objectContaining({ agent: 'claude', accessMode: 'plan' }))
    const turnId = view()!.activeTurnId!
    push({ method: 'item/started', params: { threadId: 'c-demo', turnId, item: planItem('exit-1', 'inProgress') } })
    push({ id: 'approval-1', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'c-demo', turnId, itemId: 'exit-1', command: 'ExitPlanMode {}' } })
    const approval = view()!.pendingApprovals[0]!
    expect(planApproval(view(), approval)?.plan).toContain('1. 修改')
    // 客户端不代答；发出批准后等 Agent 确认退出计划模式才切回。
    await advance(state().respondApproval(approval.requestId, 'accept'), 30)
    expect(selectedAccessMode(state())).toBe('plan')
    push({ method: 'item/completed', params: { threadId: 'c-demo', turnId, item: planItem('exit-1', 'completed') } })
    expect(selectedAccessMode(state())).toBe('fullAccess')
    // 重复到达的完成通知不再改用户之后的选择；被拒绝的计划保持计划模式。
    state().setAccessMode('plan')
    push({ method: 'item/completed', params: { threadId: 'c-demo', turnId, item: planItem('exit-1', 'completed') } })
    push({ method: 'item/completed', params: { threadId: 'c-demo', turnId, item: planItem('exit-2', 'failed') } })
    expect(selectedAccessMode(state())).toBe('plan')
    // 电脑端批准：本机没有应答过，同样切回。
    push({ method: 'item/completed', params: { threadId: 'c-demo', turnId, item: planItem('exit-3', 'completed') } })
    expect(selectedAccessMode(state())).toBe('fullAccess')
    state().setAccessMode('inherit')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(view()?.status).toBe('idle')

    // 后台任务：补读列表、停止单个任务，失败时提示。
    await advance(state().refreshBackgroundTasks(), 30)
    expect(view()?.backgroundTasks).toEqual([{ id: 'build', type: 'local_bash', description: '构建' }])
    await expect(advance(state().stopBackgroundTask('build'), 30)).resolves.toBe(true)
    expect(sent.at(-1)).toMatchObject({ method: 'qingcode/backgroundTasks/stop', params: { threadId: 'c-demo', taskId: 'build' } })
    push({ method: 'qingcode/backgroundTasks/updated', params: { threadId: 'c-demo', tasks: [] } })
    expect(view()?.backgroundTasks).toEqual([])
    stopFails = true
    await expect(advance(state().stopBackgroundTask('build'), 30)).resolves.toBe(false)
    expect(state().notice).toContain('该会话没有运行中的后台任务')

    // 停止时被撤回的引导：宽限期后放回队首并暂停，不自动重发。
    await expect(advance(state().send('慢任务'), 30)).resolves.toBe(true)
    swallowSteer = true
    await expect(advance(state().send('补充要求', [], false, 'steer'), 30)).resolves.toBe(true)
    expect(selectedPendingSteers(state())?.map((steer) => steer.text)).toEqual(['补充要求'])
    const steerId = sent.findLast((msg) => msg.method === 'turn/steer')!.params.clientUserMessageId
    const before = turnStarts().length
    await advance(state().interrupt(), 30)
    expect(queue()).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(queue()).toEqual([expect.objectContaining({ text: '补充要求', error: '引导消息未送达，检查后可继续发送' })])
    expect(selectedPendingSteers(state())).toBeUndefined()
    expect(state().notice).toBe('引导消息未送达，已放回发送队列')
    await vi.advanceTimersByTimeAsync(5000)
    expect(turnStarts()).toHaveLength(before)
    // 迟到的回显说明已经送达，撤掉队列里的副本。
    push({ method: 'item/completed', params: { threadId: 'c-demo', turnId: 'late',
      item: { type: 'userMessage', id: steerId, clientId: steerId, content: [{ type: 'text', text: '补充要求' }] } } })
    expect(queue()).toEqual([])

    // 队列交给电脑期间不改手机队列；收回后再判断，暂停原因不会被收回结果清掉。
    relayEnabled = true
    await advance(state().loadAgentSettings(), 30)
    await expect(advance(state().send('又一个慢任务'), 30)).resolves.toBe(true)
    await expect(advance(state().send('排在后面'), 30)).resolves.toBe(true)
    await expect(advance(state().send('后台前的补充', [], false, 'steer'), 30)).resolves.toBe(true)
    changeVisibility('hidden')
    await vi.advanceTimersByTimeAsync(100)
    expect(relay).toHaveLength(1)
    await advance(state().interrupt(), 30)
    await vi.advanceTimersByTimeAsync(3000)
    expect(queue().map((item) => item.text)).toEqual(['排在后面'])
    changeVisibility('visible')
    await vi.advanceTimersByTimeAsync(3000)
    expect(queue().map((item) => item.text)).toEqual(['后台前的补充', '排在后面'])
    expect(queue()[0]?.error).toBe('引导消息未送达，检查后可继续发送')

    // 计划模式的队列不交给电脑，批准后由手机按切回的档位发送。
    for (const item of queue()) state().removeQueuedSend(item.id)
    relay.length = 0
    state().setAccessMode('plan')
    await expect(advance(state().send('慢规划'), 30)).resolves.toBe(true)
    await expect(advance(state().send('规划后的下一条'), 30)).resolves.toBe(true)
    changeVisibility('hidden')
    await vi.advanceTimersByTimeAsync(100)
    expect(relay).toEqual([])
    changeVisibility('visible')
    await vi.advanceTimersByTimeAsync(100)
  } finally {
    await advance(state().removeConnection(conn.id))
    rpc.mockRestore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setGateway(null)
  }
})
