// 浏览器开发模式的端到端冒烟：粘贴导入 → 配对 → 目标/项目/多 Agent 会话 → 流式对话 → 模型覆盖 → 只读查看文件/差异。
import { describe, expect, it, vi } from 'vitest'
import { archivedThreadKey } from './agents'
import { createGateway, setGateway } from './client'
import { buildConnectionInfo } from './link'
import { MOCK_FP, type MockNativePort } from './mock'
import { draftKey, parseConnections, serializeConnections } from './state'
import { selectedQueuedSends, useApp } from './store'
import { EventStreamController } from './transport'
import type { ProbeResult, Project } from './types'
import { openWorkspaceThread, showWorkspaceProject, useWorkspace } from './workspace'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('模拟网关全链路', () => {
  it('合并同一电脑的并发探测，并清除失效的延迟', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const conn = {
      id: 'latency-test', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0,
    }
    const state = useApp.getState
    const before = state()
    useApp.setState({ connections: [conn], connectionStatus: {}, connectionLatencyMs: {}, needsRepair: {} })
    let release!: (value: ProbeResult) => void
    const pending = new Promise<ProbeResult>((resolve) => { release = resolve })
    const probe = vi.spyOn(gateway, 'probe').mockReturnValueOnce(pending)
    let now = 100
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const first = state().refreshStatuses()
      const second = state().refreshStatuses()
      expect(probe).toHaveBeenCalledTimes(1)
      expect(state().connectionStatus[conn.id]).toBe('checking')
      now = 146.5
      release({ fingerprint: MOCK_FP, name: '电脑', version: '1' })
      await Promise.all([first, second])
      expect(state().connectionStatus[conn.id]).toBe('online')
      expect(state().connectionLatencyMs[conn.id]).toBe(47)

      probe.mockRejectedValueOnce(new Error('离线'))
      await state().refreshStatuses()
      expect(state().connectionStatus[conn.id]).toBe('offline')
      expect(state().connectionLatencyMs[conn.id]).toBeNull()

      probe.mockResolvedValueOnce({ fingerprint: 'ef'.repeat(32), name: '电脑', version: '1' })
      await state().refreshStatuses()
      expect(state().connectionStatus[conn.id]).toBe('mismatch')
      expect(state().connectionLatencyMs[conn.id]).toBeNull()
    } finally {
      clock.mockRestore()
      probe.mockRestore()
      const { connections, connectionStatus, connectionLatencyMs, needsRepair } = before
      useApp.setState({ connections, connectionStatus, connectionLatencyMs, needsRepair })
    }
  })

  it('从剪贴板导入到流式回复都能走通', async () => {
    const gateway = createGateway()
    const writeStorage = gateway.storageSet.bind(gateway)
    const pair = vi.spyOn(gateway, 'pair')
    setGateway(gateway)

    const state = () => useApp.getState()
    state().openAddForm()
    await state().pasteFromClipboard()
    expect(state().form?.draft.fp).toBe(MOCK_FP)
    expect(state().form?.error).toBeNull()
    expect(state().form?.paste).toBe('')
    state().updateDraft('name', '我的电脑')

    await state().testConnection()
    expect(state().form?.probe?.fingerprint).toBe(MOCK_FP)
    expect(state().form?.fpMismatch).toBeNull()

    await state().pairAndSave()
    expect(state().connections).toHaveLength(1)
    expect(state().activeId).toBe(state().connections[0]?.id)
    expect(state().targets.map((item) => item.id)).toEqual(['local', 'ssh-93'])

    const original = state().connections[0]!
    state().openEditForm(original.id)
    const forwarded = { name: original.name, host: 'frp.example.com', port: 7001, code: 'mock1234' }
    state().setFormPaste(buildConnectionInfo({ ...forwarded, fp: 'ef'.repeat(32) }).text)
    state().parsePaste()
    expect(state().form?.error).toContain('证书指纹不同')
    expect(state().form?.draft.host).toBe(original.host)
    state().setFormPaste(buildConnectionInfo({ ...forwarded, fp: MOCK_FP }).text)
    state().parsePaste()
    expect(state().form?.draft).toMatchObject({ host: 'frp.example.com', port: '7001', code: '' })
    state().updateDraft('name', '转发后的电脑')
    state().updateDraft('port', '')
    expect(state().form?.draft.port).toBe('')
    await state().saveEdit()
    expect(state().form?.error).toContain('端口')
    state().updateDraft('port', '7002')
    await state().testConnection()
    expect(state().form?.probe?.fingerprint).toBe(MOCK_FP)
    vi.spyOn(gateway, 'storageSet').mockRejectedValueOnce(new Error('本地存储暂不可用'))
    await state().saveEdit()
    expect(state().form?.error).toBe('本地存储暂不可用')
    expect(state().connections[0]).toEqual(original)
    await state().saveEdit()
    expect(state().page).toBe('workspace')
    const edited = { ...original, name: '转发后的电脑', host: 'frp.example.com', port: 7002 }
    expect(state().connections[0]).toEqual(edited)
    expect(parseConnections(await gateway.storageGet('connections'))).toEqual([edited])
    expect(pair).toHaveBeenCalledTimes(1)

    // 事件流由页面 init 建立，这里手动建立等价的订阅。
    const controller = new EventStreamController(
      gateway,
      () => {
        const current = state()
        return current.connections.find((item) => item.id === current.activeId) ?? null
      },
      {
        onEvent: (event) => state().handleGatewayEvent(event),
        onOpen: () => { useApp.setState({ eventsConnected: true }) },
        onClose: () => undefined,
      },
    )
    controller.start()
    await wait(30)
    const discovery = vi.spyOn(gateway, 'rpc')
    const workspaceThreads = await state().discoverWorkspaceSessions([
      { id: 'p-local', targetId: 'local', name: 'qin', path: 'D:\\code\\qingcode-next', lastOpenedAt: 0 },
    ])
    expect(workspaceThreads.map((thread) => [thread.projectId, thread.agent]).sort()).toEqual([
      ['p-local', 'claude'], ['p-local', 'codex'],
    ])
    const historyRequests = discovery.mock.calls.filter(([, method]) => method === 'codex.send')
    for (const agent of ['claude', 'codex']) {
      expect(historyRequests).toContainEqual([
        edited, 'codex.send', expect.objectContaining({ agent, msg: expect.objectContaining({
          method: 'thread/list', params: { cwd: ['D:\\code\\qingcode-next'], limit: 100, sortKey: 'updated_at' },
        }) }),
      ])
    }
    const discoveryRequests = discovery.mock.calls.flatMap(([, method, params]) => method === 'server.req' ? [params] : [])
    expect(discoveryRequests).toContainEqual({
      targetId: 'local', method: 'codex.status', params: { agent: 'pi' },
    })
    expect(discoveryRequests).not.toContainEqual(expect.objectContaining({ method: 'codex.open' }))
    expect(discoveryRequests).not.toContainEqual(expect.objectContaining({
      method: 'codex.attach', params: expect.objectContaining({ agent: 'pi' }),
    }))
    discovery.mockRestore()

    state().requestConnect('ssh-93')
    expect(state().credential?.targetId).toBe('ssh-93')
    await state().submitCredentials('', false)
    await wait(320)
    expect(state().targetStates['ssh-93']?.state).toBe('ready')

    // 网关把 hostKey.prompt 转成 mobile.notice，手机端要给出电脑确认提示。
    state().handleGatewayEvent({
      name: 'mobile.notice',
      payload: { kind: 'hostKey', message: '请在电脑上确认主机指纹' },
    })
    expect(state().notice).toBe('请在电脑上确认主机指纹')

    await state().selectTarget('local')
    await wait(30)
    expect(state().projects.some((item) => item.id === 'p-local')).toBe(true)
    expect(state().agentSettings?.agents['local']?.pi?.enabled).toBe(true)
    await state().selectProject('p-local')
    expect(state().sessions['codex:local']?.opened).toBe(true)
    expect(state().sessions['claude:local']?.opened).toBe(true)
    // pi 打开失败只记在 pi 名下，Codex / Claude 的会话照常合并显示。
    expect(state().sessions['pi:local']?.opened).toBe(false)
    expect(state().agentErrors.pi).toContain('pi')
    expect(state().threadsError).toBeNull()
    expect(state().threads.map((item) => `${item.agent}:${item.id}`)).toEqual(['codex:t-demo', 'claude:c-demo'])

    // 打开 Claude 会话走 Claude 通道；事件按 payload.agent 路由，不串到 Codex。
    await state().openThread('c-demo', 'claude')
    expect(state().selectedAgent).toBe('claude')
    expect(state().sessions['claude:local']?.state.threads['c-demo']?.items.length).toBeGreaterThan(0)
    expect(state().sessions['codex:local']?.state.threads['c-demo']).toBeUndefined()
    state().goBack()

    const gatewayRpc = gateway.rpc.bind(gateway)
    let blockResume = true
    const historyRpc = vi.spyOn(gateway, 'rpc').mockImplementation((conn, method, params, agent, timeout) => {
      const request = params as { msg?: { method?: string } }
      if (method === 'codex.send' && request.msg?.method === 'thread/resume' && blockResume) {
        blockResume = false
        return Promise.reject(new Error('会话正被另一个客户端占用'))
      }
      return gatewayRpc(conn, method, params, agent, timeout)
    })
    await state().openThread('t-demo', 'codex')
    expect(state().sessions['codex:local']?.state.threads['t-demo']?.items.length).toBeGreaterThan(0)
    await expect(state().send('接着聊')).resolves.toBe(true)
    const historyMethods = historyRpc.mock.calls.flatMap(([, method, params]) => {
      const msg = (params as { msg?: { method?: string } })?.msg
      return method === 'codex.send' && msg?.method && /^(thread\/(resume|read)|turn\/start)$/.test(msg.method)
        ? [msg.method] : []
    })
    expect(historyMethods).toEqual(['thread/resume', 'thread/read', 'thread/resume', 'turn/start'])
    historyRpc.mockRestore()
    state().goBack()

    const project = state().projects.find((item) => item.id === 'p-local')!
    state().goBack()
    state().goBack()
    expect(state().page).toBe('workspace')
    expect(state().selectedTargetId).toBeNull()
    const pages = new Set<string>()
    const observeNewSession = useApp.subscribe((next) => pages.add(next.page))
    await expect(state().newThread('codex', { project, projects: [project], threads: [] })).resolves.toBe(true)
    observeNewSession()
    expect([...pages]).toEqual(['workspace', 'chat'])
    expect(state().page).toBe('chat')
    expect(state().selectedProjectId).toBe(project.id)
    expect(state().selectedAgent).toBe('codex')
    expect(state().selectedThreadId).toBeTruthy()

    // 模型：Codex 有列表，选中后作为 turn/start 覆盖项发送。
    await state().loadModels('local', 'codex')
    expect(state().models['codex:local']?.models.map((item) => item.model)).toEqual(['gpt-5.5-codex', 'gpt-5.5-mini'])
    state().setModelPrefs('local', 'codex', { model: 'gpt-5.5-mini', effort: 'minimal', fast: false })

    await state().send('你好')
    await wait(600)

    // 浏览器开发模式也能检索项目文件并按稳定版本分块读取。
    const fileScope = { targetId: 'local', projectId: 'p-local' }
    const files = await gateway.rpc<{ entries: { path: string }[] }>(edited, 'mobile.files.list', fileScope)
    expect(files.entries.map((file) => file.path)).toContain('README.md')
    const found = await gateway.rpc<{ entries: { path: string }[] }>(
      edited, 'mobile.files.search', { ...fileScope, query: 'store.ts' },
    )
    expect(found.entries.map((file) => file.path)).toEqual(['apps/mobile/web/src/store.ts'])
    const chunk = await gateway.rpc<{ content: string; version: string }>(
      edited, 'mobile.files.read', { ...fileScope, path: 'README.md', length: 7 },
    )
    expect(atob(chunk.content)).toBe('// mock')
    const nextChunk = await gateway.rpc<{ content: string }>(
      edited, 'mobile.files.read', { ...fileScope, path: 'README.md', offset: 7, length: 6, version: chunk.version },
    )
    expect(atob(nextChunk.content)).toBe(' file:')
    const terminal = await gateway.rpc<{ termId: string }>(edited, 'mobile.term.open', fileScope)
    const termScope = { ...fileScope, termId: terminal.termId }
    await expect(gateway.rpc(edited, 'mobile.term.write', { ...termScope, data: btoa('hello\r') }))
      .resolves.toEqual({ acceptedBytes: 6 })
    const replay = await gateway.rpc<{ chunks: { seq: number; data: string }[] }>(edited, 'mobile.term.attach', {
      ...termScope, sinceSeq: 1,
    })
    expect(replay.chunks.map((entry) => [entry.seq, atob(entry.data)])).toEqual([[2, 'hello\r\n> ']])
    await gateway.rpc(edited, 'mobile.term.close', termScope)
    const threadId = state().selectedThreadId
    const view = threadId ? state().sessions['codex:local']?.state.threads[threadId] : undefined
    expect(view?.items.some((item) => item.kind === 'user')).toBe(true)
    expect(view?.items.some((item) => item.kind === 'agent' && item.text.includes('模拟的'))).toBe(true)
    expect(view?.items.some((item) => item.kind === 'fileChange')).toBe(true)
    expect(state().rateLimits['local']?.snapshot?.primary?.usedPercent).toBeGreaterThan(0)
    const port = (gateway as unknown as { native: { port: MockNativePort } }).native.port
    expect(port.lastTurnParams).toMatchObject({
      agent: 'codex', model: 'gpt-5.5-mini', effort: 'minimal',
      input: [{ type: 'text', text: '你好', text_elements: [] }],
    })
    // turn 完成后的后台刷新不重试打不开的 pi，但保留它的提示。
    expect(state().agentErrors.pi).toContain('pi')

    // Claude 未显式选模型时不带覆盖项。
    await state().newThread('claude')
    expect(state().selectedAgent).toBe('claude')
    await state().loadModels('local', 'claude')
    await state().send('审查一下', [], true)
    await wait(50)
    expect(port.lastTurnParams?.agent).toBe('claude')
    expect(port.lastTurnParams?.input).toEqual([
      { type: 'text', text: expect.stringMatching(/^审查一下\n\n请.*子代理/), text_elements: [] },
    ])
    expect(port.lastTurnParams?.model).toBeUndefined()
    expect(port.lastTurnParams?.effort).toBeUndefined()
    await wait(600)
    const claudeThread = state().selectedThreadId
    expect(state().claudeCosts[JSON.stringify(['local', claudeThread])]).toBeCloseTo(0.012)
    expect(state().claudeRateLimits.local?.primary?.usedPercent).toBe(81)

    // 只读查看：文本分段续读、行号定位，差异优先 git.diff，失败回退到卡片 diff。
    await state().openFile({ path: 'D:\code\qingcode-next\README.md', line: 3 })
    expect(state().viewer?.file?.truncated).toBe(true)
    expect(state().viewer?.line).toBe(3)
    const firstLength = state().viewer?.file?.length ?? 0
    await state().loadMoreFile()
    expect(state().viewer?.file?.length).toBeGreaterThan(firstLength)
    expect(state().goBack()).toBe(true)
    expect(state().viewer).toBeNull()

    await state().openFile({ path: 'D:\code\missing.ts' })
    expect(state().viewer?.error).toBe('文件不存在或已被删除')
    state().closeViewer()

    await state().openDiff({ path: 'D:\code\qingcode-next\a.ts', diff: '+card' })
    expect(state().viewer?.diffSource).toBe('git')
    expect(state().viewer?.diff).toContain('@@')
    await state().openDiff({ path: 'D:\code\qingcode-next\clean.ts', diff: '+card' })
    expect(state().viewer?.diffSource).toBe('card')
    expect(state().viewer?.diff).toBe('+card')
    state().closeViewer()

    state().setDraftText('失败仍保留')
    state().addAnnotation('引用', '备注')
    vi.spyOn(gateway, 'rpc').mockRejectedValueOnce(new Error('模拟网络中断'))
    await expect(state().send(state().draftText)).resolves.toBe(false)
    expect(state().draftText).toBe('失败仍保留')
    expect(state().annotations).toMatchObject([{ quote: '引用', comment: '备注' }])
    expect(state().error).toBe('模拟网络中断')

    vi.spyOn(gateway, 'rpc').mockRestore()
    const actualRpc = gateway.rpc.bind(gateway)
    const rpc = vi.spyOn(gateway, 'rpc').mockImplementation((conn, method, params, agent, timeout) => {
      const request = params as { method?: string; params?: { agent?: string }; msg?: { method?: string } }
      if (method === 'server.req' && request.method === 'codex.attach' && request.params?.agent === 'claude') {
        return Promise.resolve({
          lastSeq: state().sessions['claude:local']?.transport.getLastSeq() ?? 0, truncated: true,
        } as never)
      }
      return actualRpc(conn, method, params, agent, timeout)
    })
    await state().attachOpened()
    expect(rpc).toHaveBeenCalledWith(edited, 'codex.send', expect.objectContaining({
      agent: 'claude', msg: expect.objectContaining({ method: 'thread/read' }),
    }))
    rpc.mockRestore()

    const firstTransport = state().sessions['claude:local']!.transport
    const secondDesktop = { ...edited, id: 'second-desktop' }
    useApp.setState({ connections: [edited, secondDesktop] })
    let releaseProjects!: () => void
    const waiting = new Promise<never>((resolve) => {
      releaseProjects = () => resolve([{ id: 'old-project', targetId: 'local', path: '/went-to-old-host' }] as never)
    })
    const stale = vi.spyOn(gateway, 'rpc').mockImplementation((conn, method, params, agent, timeout) => {
      return conn.id === edited.id && method === 'projects.list'
        ? waiting
        : actualRpc(conn, method, params, agent, timeout)
    })
    const previousProjects = state().selectTarget('local')
    await state().activate(secondDesktop.id)
    releaseProjects()
    await previousProjects
    stale.mockRestore()
    expect(state().projects).toEqual([])
    expect(state().page).toBe('workspace')
    expect(state().sessions).toEqual({})
    expect(state().rateLimits).toEqual({})
    expect(state().claudeRateLimits).toEqual({})
    expect(state().modelPrefs).toEqual({})
    await state().selectTarget('local')
    await state().selectProject('p-local')
    await state().openThread(claudeThread!, 'claude')
    expect(state().sessions['claude:local']?.transport).not.toBe(firstTransport)
    expect(state().draftText).toBe('')

    await state().activate(edited.id)
    await state().selectTarget('local')
    await state().selectProject('p-local')
    await state().openThread(claudeThread!, 'claude')
    expect(state().draftText).toBe('失败仍保留')
    expect(state().annotations).toMatchObject([{ quote: '引用', comment: '备注' }])
    expect(state().modelPrefs['codex:local']?.model).toBe('gpt-5.5-mini')

    const approvalRequestId = 98765
    const approvalEvent = (msg: unknown, seq: number) => state().handleGatewayEvent({
      name: 'codex.recv', payload: { targetId: 'local', agent: 'claude', seq, msg },
    })
    approvalEvent({
      id: approvalRequestId, method: 'item/commandExecution/requestApproval',
      params: { threadId: claudeThread, turnId: 'approval-turn', command: 'git status' },
    }, 10000)
    const pending = () => state().sessions['claude:local']?.state.threads[claudeThread!]?.pendingApprovals
    expect(pending()).toHaveLength(1)
    vi.spyOn(gateway, 'rpc').mockRejectedValueOnce(new Error('模拟审批 HTTP 失败'))
    await expect(state().respondApproval(approvalRequestId, 'decline')).resolves.toBe(false)
    expect(state().approvalSubmitting).toEqual({})
    expect(pending()).toHaveLength(1)
    await expect(state().respondApproval(approvalRequestId, 'decline')).resolves.toBe(true)
    expect(state().approvalSubmitting[String(approvalRequestId)]).toBe(true)
    expect(pending()).toHaveLength(1)
    approvalEvent({ method: 'serverRequest/resolved', params: { threadId: claudeThread, requestId: approvalRequestId } }, 10001)
    expect(state().approvalSubmitting).toEqual({})
    expect(pending()).toHaveLength(0)

    const codexThread = { id: 't-demo', agent: 'codex' } as const
    const claudeConversation = { id: claudeThread!, agent: 'claude' } as const
    const archiveRpc = vi.spyOn(gateway, 'rpc').mockRejectedValueOnce(new Error('模拟归档网络失败'))
    await expect(state().archiveConversation('local', codexThread)).rejects.toThrow('模拟归档网络失败')
    expect(state().threads).toEqual(expect.arrayContaining([expect.objectContaining(codexThread)]))
    await state().archiveConversation('local', codexThread)
    expect(archiveRpc).toHaveBeenCalledWith(edited, 'codex.send', expect.objectContaining({
      targetId: 'local', agent: 'codex', msg: expect.objectContaining({
        method: 'thread/archive', params: { threadId: codexThread.id },
      }),
    }))
    archiveRpc.mockClear()
    await vi.waitFor(async () => expect(await gateway.storageGet('archivedThreads')).toBeTruthy())
    const storage = vi.spyOn(gateway, 'storageSet').mockImplementation((key, value) => key === 'archivedThreads'
      ? Promise.reject(new Error('模拟本地归档失败')) : writeStorage(key, value))
    await expect(state().archiveConversation('local', claudeConversation)).rejects.toThrow('模拟本地归档失败')
    storage.mockRestore()
    expect(state()).toMatchObject({ page: 'chat', selectedThreadId: claudeThread })
    await state().archiveConversation('local', claudeConversation)
    expect(archiveRpc).not.toHaveBeenCalled()
    expect(state()).toMatchObject({ page: 'threads', selectedThreadId: null })
    await state().refreshThreads({ skipFailed: true })
    expect(state().threads.some((thread) => thread.id === codexThread.id || thread.id === claudeThread)).toBe(false)
    await vi.waitFor(async () => {
      const archives = JSON.parse((await gateway.storageGet('archivedThreads')) ?? '{}')
      expect(archives).toEqual({
        [archivedThreadKey(edited.id, 'local', codexThread)]: true,
        [archivedThreadKey(edited.id, 'local', claudeConversation)]: true,
      })
      const saved = JSON.parse((await gateway.storageGet('savedChats')) ?? '{}')
      expect(saved[edited.id]).toBeUndefined()
    })
    await gateway.rpc(edited, 'codex.send', {
      targetId: 'local', agent: 'codex', msg: { id: 'external-unarchive', method: 'thread/unarchive', params: { threadId: codexThread.id } },
    })
    await vi.waitFor(() => expect(state().threads).toEqual(expect.arrayContaining([expect.objectContaining(codexThread)])))
    archiveRpc.mockRestore()

    state().handleGatewayEvent({ name: 'unauthorized' })
    expect(state().needsRepair[edited.id]).toBe('unauthorized')
    state().beginRepair(edited.id)
    expect(state().form).toMatchObject({ mode: 'repair', editId: edited.id })
    await state().pasteFromClipboard()
    await state().pairAndSave()
    expect(state().connections.map((item) => item.id)).toEqual([edited.id, secondDesktop.id])
    expect(state().needsRepair[edited.id]).toBeUndefined()

    controller.stop()
    for (const session of Object.values(state().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
  }, 15_000)

  it('连续打开会话时采用最后一次选择，取消后忽略迟到的历史', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'switch-desktop', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    useApp.setState({ connections: [...state().connections, conn] })
    await state().activate(conn.id)
    const controller = new EventStreamController(gateway, () => conn, {
      onEvent: (event) => state().handleGatewayEvent(event),
      onOpen: () => useApp.setState({ eventsConnected: true }),
      onClose: () => useApp.setState({ eventsConnected: false }),
    })
    controller.start()
    let releaseResume: (() => void) | undefined
    const releaseHistory = () => {
      releaseResume?.()
      releaseResume = undefined
    }
    try {
      await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
      await state().selectTarget('local')
      await state().selectProject('p-local')
      const rpc = gateway.rpc.bind(gateway)
      const disconnected = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
        const [, method, params] = args
        if (method === 'server.req' && (params as { method?: string }).method === 'ping') {
          throw Object.assign(new Error('目标未连接'), { code: 'not_connected' })
        }
        return rpc(...args)
      })
      try {
        await expect(state().openThread('c-demo', 'claude')).resolves.toBe(true)
        expect(disconnected.mock.calls.map(([, method]) => method)).toContain('target.connect')
        expect(state()).toMatchObject({ selectedThreadId: 'c-demo', openingThread: null, error: null })
      } finally {
        disconnected.mockRestore()
      }
      const delayed = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
        const [, method, params] = args
        const request = params as { msg?: { method: string; params?: { threadId?: string } } }
        if (method === 'codex.send' && request.msg?.method === 'thread/resume' && request.msg.params?.threadId === 't-demo') {
          await new Promise<void>((resolve) => { releaseResume = resolve })
        }
        return rpc(...args)
      })
      const first = state().openThread('t-demo', 'codex')
      await vi.waitFor(() => expect(releaseResume).toBeTypeOf('function'))
      expect(state().openingThread).toMatchObject({ threadId: 't-demo', agent: 'codex' })

      const latest = state().openThread('c-demo', 'claude')
      expect(state().openingThread).toMatchObject({ threadId: 'c-demo', agent: 'claude' })
      await expect(latest).resolves.toBe(true)
      releaseHistory()
      await expect(first).resolves.toBe(false)
      expect(state()).toMatchObject({ selectedThreadId: 'c-demo', openingThread: null, error: null })

      const dismissed = state().openThread('t-demo', 'codex')
      await vi.waitFor(() => expect(releaseResume).toBeTypeOf('function'))
      state().cancelPendingNavigation()
      expect(state().openingThread).toBeNull()
      releaseHistory()
      await expect(dismissed).resolves.toBe(false)
      expect(state()).toMatchObject({ selectedThreadId: 'c-demo', openingThread: null, error: null })
      delayed.mockRestore()
    } finally {
      releaseHistory()
      controller.stop()
      for (const session of Object.values(state().sessions)) {
        session.rpc.dispose()
        session.transport.dispose()
      }
    }
  })

  it('运行中可排队、引导或立即发送，停止后可手动继续队列', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'queue-desktop', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    useApp.setState({ connections: [...state().connections, conn] })
    await state().activate(conn.id)
    const controller = new EventStreamController(gateway, () => conn, {
      onEvent: (event) => state().handleGatewayEvent(event),
      onOpen: () => useApp.setState({ eventsConnected: true }),
      onClose: () => useApp.setState({ eventsConnected: false }),
    })
    controller.start()
    try {
      await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
      await state().selectTarget('local')
      await state().selectProject('p-local')
      await state().openThread('t-demo', 'codex')

      const view = () => state().sessions['codex:local']?.state.threads['t-demo']
      const texts = () => view()?.items.flatMap((item) => item.kind === 'user' ? [item.text] : [])
      const queue = () => selectedQueuedSends(state()) ?? []
      const rpc = vi.spyOn(gateway, 'rpc')
      const turnMethods = () => rpc.mock.calls.flatMap(([, method, params]) => {
        const msg = (params as { msg?: { method?: string } } | undefined)?.msg
        return method === 'codex.send' && msg?.method?.startsWith('turn/') ? [msg.method] : []
      })

      await expect(state().send('第一条')).resolves.toBe(true)
      const firstTurn = view()?.activeTurnId
      expect(firstTurn).toBeTruthy()
      expect(state().sending).toBe(false)
      state().setDraftText('排队一')
      const png = 'data:image/png;base64,AA=='
      await expect(state().send(state().draftText, [{ type: 'image', url: png }])).resolves.toBe(true)
      expect(state().draftText).toBe('')
      await expect(state().send('移除这条')).resolves.toBe(true)
      await expect(state().send('排队二')).resolves.toBe(true)
      expect(queue().map((message) => message.text)).toEqual(['排队一', '移除这条', '排队二'])
      state().removeQueuedSend(queue()[1]!.id)
      expect(turnMethods()).toEqual(['turn/start'])

      await expect(state().send('补充方向', [], false, 'steer')).resolves.toBe(true)
      expect(rpc).toHaveBeenCalledWith(conn, 'codex.send', expect.objectContaining({
        agent: 'codex', msg: expect.objectContaining({ method: 'turn/steer', params: expect.objectContaining({
          threadId: 't-demo', expectedTurnId: firstTurn,
        }) }),
      }))
      expect(view()?.activeTurnId).toBe(firstTurn)
      expect(texts()).toContain('补充方向')

      await vi.waitFor(() => expect(view()?.items).toContainEqual(expect.objectContaining({ text: '排队一', images: [png] })))
      expect(queue().map((message) => message.text)).toEqual(['排队二'])
      await expect(state().send('立即跟进', [], false, 'immediate')).resolves.toBe(true)
      expect(texts()).toContain('立即跟进')
      expect(queue()[0]?.error).toBeUndefined()
      expect(turnMethods()).toEqual(['turn/start', 'turn/steer', 'turn/start', 'turn/interrupt', 'turn/start'])

      await state().interrupt()
      expect(view()?.status).toBe('error')
      expect(queue()[0]).toMatchObject({ text: '排队二', error: '上一轮未完成，队列已暂停' })
      expect(texts()).not.toContain('排队二')
      await state().retryQueuedSend()
      await vi.waitFor(() => expect(view()?.status).toBe('idle'))
      expect(texts()).toEqual(['你好', '第一条', '补充方向', '排队一', '立即跟进', '排队二'])
      expect(queue()).toEqual([])

      state().setDraftText('独立草稿')
      state().addAnnotation('草稿引用')
      await expect(state().send('编辑后的消息', [{ type: 'image', url: png }], false, 'queue', { keepDraft: true })).resolves.toBe(true)
      expect(view()?.activity).toBe('running')
      await vi.waitFor(() => expect(view()?.activity).toBe('completed'))
      expect(view()?.items).toContainEqual(expect.objectContaining({ text: '编辑后的消息', images: [png] }))
      expect(state().draftText).toBe('独立草稿')
      expect(state().annotations).toContainEqual(expect.objectContaining({ quote: '草稿引用' }))
      state().removeAnnotation(state().annotations[0]!.id)

      await expect(state().send('模拟队列失败前的一轮')).resolves.toBe(true)
      await expect(state().send('保留失败的排队消息')).resolves.toBe(true)
      rpc.mockRestore()
      const actualRpc = gateway.rpc.bind(gateway)
      const rejectQueued = vi.spyOn(gateway, 'rpc').mockImplementation((connection, method, params, agent, timeout) => {
        const msg = (params as { msg?: { method?: string; params?: { input?: { text?: string }[] } } } | undefined)?.msg
        if (method === 'codex.send' && msg?.method === 'turn/start' && msg.params?.input?.[0]?.text === '保留失败的排队消息') {
          return Promise.reject(new Error('模拟排队网络失败'))
        }
        return actualRpc(connection, method, params, agent, timeout)
      })
      await vi.waitFor(() => expect(queue()[0]).toMatchObject({ text: '保留失败的排队消息', error: '模拟排队网络失败' }))
      expect(texts()).not.toContain('保留失败的排队消息')
      expect(state().sending).toBe(false)
      rejectQueued.mockRestore()
      state().removeQueuedSend(queue()[0]!.id)

      await state().openThread('c-demo', 'claude')
      const unsupportedRpc = vi.spyOn(gateway, 'rpc')
      await expect(state().send('不支持引导', [], false, 'steer')).resolves.toBe(false)
      expect(state().error).toBe('当前 Agent 不支持引导')
      expect(unsupportedRpc.mock.calls).not.toContainEqual([
        conn, 'codex.send', expect.objectContaining({ msg: expect.objectContaining({ method: 'turn/steer' }) }),
      ])
      unsupportedRpc.mockRestore()
    } finally {
      controller.stop()
      await state().removeConnection(conn.id)
    }
  }, 10_000)

  it('从工作台直接打开项目或会话，切换标签后丢弃迟到的跳转', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'workspace-navigation', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    useApp.setState({ connections: [...state().connections, conn] })
    await state().activate(conn.id)
    const controller = new EventStreamController(gateway, () => conn, {
      onEvent: state().handleGatewayEvent,
      onOpen: () => useApp.setState({ eventsConnected: true }),
      onClose: () => useApp.setState({ eventsConnected: false }),
    })
    const pages: string[] = []
    const unsubscribe = useApp.subscribe((next, previous) => {
      if (next.page !== previous.page) pages.push(next.page)
    })
    controller.start()
    try {
      await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
      const projects = await gateway.rpc<Project[]>(conn, 'projects.list')
      const project = projects.find((item) => item.id === 'p-local')!
      const threads = await state().discoverWorkspaceSessions(projects)
      const thread = threads.find((item) => item.id === 't-demo')!
      useWorkspace.setState({ tab: 'sessions', threads: { [conn.id]: threads } })

      const openingProject = showWorkspaceProject(project)
      expect(pages).toEqual(['threads'])
      expect(state()).toMatchObject({ selectedTargetId: project.targetId, selectedProjectId: project.id })
      expect(state().threads).toContainEqual(thread)
      await openingProject
      state().goBack()
      state().goBack()
      pages.length = 0

      let releaseResume!: () => void
      const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve })
      const sendRpc = gateway.rpc.bind(gateway)
      const rpc = vi.spyOn(gateway, 'rpc').mockImplementation(async (connection, method, params, agent, timeout) => {
        if (method === 'codex.send' && (params as { msg?: { method?: string } })?.msg?.method === 'thread/resume') {
          await resumeGate
        }
        return sendRpc(connection, method, params, agent, timeout)
      })
      try {
        const openingThread = openWorkspaceThread(thread, project)
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith(conn, 'codex.send', expect.objectContaining({
          msg: expect.objectContaining({ method: 'thread/resume' }),
        })))
        expect(pages).toEqual([])
        expect(state().selectedTargetId).toBeNull()

        useWorkspace.getState().setTab('projects')
        useWorkspace.getState().setTab('sessions')
        releaseResume()
        await openingThread
        expect(pages).toEqual([])
      } finally {
        releaseResume()
        rpc.mockRestore()
      }

      await openWorkspaceThread(thread, project)
      expect(pages).toEqual(['chat'])
      expect(state()).toMatchObject({
        selectedTargetId: thread.targetId, selectedProjectId: thread.projectId, selectedThreadId: thread.id,
      })
      expect(state().sessions['codex:local']?.state.threads[thread.id]?.items.length).toBeGreaterThan(0)
      expect(state().goBack()).toBe(true)
      expect(state().page).toBe('threads')
    } finally {
      unsubscribe()
      controller.stop()
      useWorkspace.setState({ threads: {} })
      await state().removeConnection(conn.id)
    }
  })

  it('冷启动从加密存储恢复电脑的当前会话及对应草稿', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const conn = {
      id: 'cold-start-desktop', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    const chat = { targetId: 'local', projectId: 'p-local', agent: 'codex', threadId: 't-demo' } as const
    const key = draftKey(conn.id, chat.targetId, chat.projectId, chat.agent, chat.threadId, conn.fp)
    await Promise.all([
      gateway.storageSet('connections', serializeConnections([conn])),
      gateway.storageSet('active', conn.id),
      gateway.storageSet('savedChats', JSON.stringify({ [conn.id]: chat })),
      gateway.storageSet('chatDrafts', JSON.stringify({ [key]: { text: '冷启动草稿', annotations: [] } })),
    ])
    useApp.getState().init()
    await vi.waitFor(() => {
      expect(useApp.getState()).toMatchObject({
        page: 'chat', selectedThreadId: chat.threadId, activeId: conn.id, draftText: '冷启动草稿',
      })
    })
    await useApp.getState().removeConnection(conn.id)
  })
})
