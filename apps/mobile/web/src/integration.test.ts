// 浏览器开发模式的端到端冒烟：粘贴导入 → 配对 → 目标/项目/多 Agent 会话 → 流式对话 → 模型覆盖 → 只读查看文件/差异。
import { describe, expect, it, vi } from 'vitest'
import { composeAttachmentText, insertImagePlaceholders } from '@qn/codex-client'
import { ACCESS_PREFS_STORAGE_KEY, accessPreferenceKey } from './accessPrefs'
import { archivedThreadKey, sessionKey } from './agents'
import { createGateway, setGateway } from './client'
import { buildConnectionInfo } from './link'
import { MOCK_FP, type MockNativePort } from './mock'
import { toModelOptions } from './models'
import { UNCONFIRMED_QUEUED_SEND } from './queuedSends'
import { draftKey, parseConnections, serializeConnections } from './state'
import { displayedAccessMode, selectedAccessMode, selectedCompactionStarting, selectedQueuedSends, useApp } from './store'
import { EventStreamController } from './transport'
import type { ProbeResult, Project } from './types'
import { openWorkspaceThread, showWorkspaceProject, startWorkspaceObserver, useWorkspace } from './workspace'

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

    const gatewayRpc = gateway.rpc.bind(gateway)
    const cursors: (string | null)[] = []
    // 打开 Claude 会话后会另外按轮次摘要到更早的页里补读计划清单。
    const planCursors: (string | null)[] = []
    const paged = vi.spyOn(gateway, 'rpc').mockImplementation((...args) => {
      const [, method, params] = args
      const request = params as { agent?: string; msg?: { id: string; method: string; params: { cursor: string | null; itemsView?: string } } }
      if (method !== 'codex.send' || request.agent !== 'claude' || request.msg?.method !== 'thread/turns/list') return gatewayRpc(...args)
      const { id, params: { cursor, itemsView } } = request.msg
      if (itemsView === 'notLoaded') {
        planCursors.push(cursor)
        state().handleGatewayEvent({ name: 'codex.recv', payload: { targetId: 'local', agent: 'claude', seq: null,
          msg: { id, result: { data: [{ id: 'first', status: 'completed', items: [],
            plan: { explanation: null, plan: [{ step: '更早的步骤', status: 'pending' }] } }], nextCursor: null } },
        } })
        return Promise.resolve(undefined) as ReturnType<typeof gateway.rpc>
      }
      cursors.push(cursor)
      const reply = cursor ? 'first' : 'recent'
      state().handleGatewayEvent({ name: 'codex.recv', payload: { targetId: 'local', agent: 'claude', seq: null,
        msg: { id, result: { data: [{ id: reply, status: 'completed', items: [{ id: reply, type: 'agentMessage', text: reply }] }],
          nextCursor: cursor ? null : 'older' } },
      } })
      return Promise.resolve(undefined) as ReturnType<typeof gateway.rpc>
    })
    try {
      await expect(state().openThread('c-demo', 'claude')).resolves.toBe(true)
      const transcript = () => state().sessions['claude:local']?.state.threads['c-demo']?.items.map((item) => item.id)
      expect(state().selectedAgent).toBe('claude')
      expect(state().sessions['codex:local']?.state.threads['c-demo']).toBeUndefined()
      expect(cursors).toEqual([null])
      expect(transcript()).toEqual(['recent'])
      expect(planCursors).toEqual(['older'])
      await vi.waitFor(() => expect(state().sessions['claude:local']?.state.threads['c-demo']?.plan?.steps)
        .toEqual([{ step: '更早的步骤', status: 'pending' }]))
      const captureScroll = vi.fn()
      await state().loadEarlierHistory(captureScroll)
      expect(captureScroll).toHaveBeenCalledOnce()
      expect(cursors).toEqual([null, 'older'])
      expect(transcript()).toEqual(['first', 'recent'])
    } finally {
      paged.mockRestore()
    }
    state().goBack()

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
    // 总用量经 codex.send 读取；60 秒内重复刷新沿用缓存，不再请求。
    await state().refreshAccountUsage('local')
    const usage = state().rateLimits['local']
    expect(usage?.usage?.lifetimeTokens).toBe(18_640_000)
    expect(usage?.usage?.daily).toHaveLength(7)
    const usageReadAt = usage?.usageUpdatedAt
    await state().refreshAccountUsage('local')
    expect(state().rateLimits['local']?.usageUpdatedAt).toBe(usageReadAt)
    const port =(gateway as unknown as { native: { port: MockNativePort } }).native.port
    expect(port.lastTurnParams).toMatchObject({
      agent: 'codex', model: 'gpt-5.5-mini', effort: 'minimal',
      clientUserMessageId: expect.any(String),
      input: [{ type: 'text', text: '你好', text_elements: [] }],
    })
    // turn 完成后的后台刷新不重试打不开的 pi，但保留它的提示。
    expect(state().agentErrors.pi).toContain('pi')
    state().setAccessMode('auto')
    expect(selectedAccessMode(state())).toBe('auto')
    const callAccessRpc = gateway.rpc.bind(gateway)
    const accessRpc = vi.spyOn(gateway, 'rpc')
    await expect(state().send('仅检查项目')).resolves.toBe(true)
    expect(accessRpc).toHaveBeenCalledWith(edited, 'mobile.turn.start', {
      targetId: 'local', agent: 'codex', accessMode: 'auto', replyViaHttp: true, msg: expect.objectContaining({
        method: 'turn/start', params: {
          threadId, model: 'gpt-5.5-mini', effort: 'minimal', clientUserMessageId: expect.any(String),
          input: [{ type: 'text', text: '仅检查项目', text_elements: [] }],
        },
      }),
    })
    await vi.waitFor(() => expect(state().sessions['codex:local']?.state.threads[threadId!]?.status).toBe('idle'))

    // Claude 未显式选模型时不带覆盖项。
    await state().newThread('claude')
    expect(state().selectedAgent).toBe('claude')
    expect(selectedAccessMode(state())).toBe('default')
    // 已移除的旧档位被忽略。
    state().setAccessMode('readOnly' as never)
    expect(selectedAccessMode(state())).toBe('default')
    await state().loadModels('local', 'claude')
    await state().send('审查一下', [], true)
    await wait(50)
    expect(port.lastTurnParams?.agent).toBe('claude')
    expect(port.lastTurnParams?.clientUserMessageId).toEqual(expect.any(String))
    expect(port.lastTurnParams?.input).toEqual([
      { type: 'text', text: expect.stringMatching(/^审查一下\n\n请.*子代理/), text_elements: [] },
    ])
    expect(port.lastTurnParams?.model).toBeUndefined()
    expect(port.lastTurnParams?.effort).toBeUndefined()
    await wait(600)
    const claudeThread = state().selectedThreadId
    expect(state().claudeCosts[JSON.stringify(['local', claudeThread])]).toBeCloseTo(0.012)
    expect(state().claudeRateLimits.local?.primary?.usedPercent).toBe(81)
    const beforeRestart = state().claudeRateLimits.local
    expect(beforeRestart?.observedAt).toEqual(expect.any(Number))
    let releaseQuota!: (value: unknown) => void
    const delayedQuota = new Promise((resolve) => { releaseQuota = resolve })
    const quotaRequest = vi.spyOn(state().sessions['claude:local']!.rpc, 'request')
      .mockImplementationOnce(() => delayedQuota as never)
    const refreshBeforeRestart = state().refreshClaudeRateLimits('local')
    state().handleGatewayEvent({ name: 'server.evt', payload: { name: 'server.restarted', targetId: 'local' } })
    expect(state().claudeRateLimits.local).toBeUndefined()
    releaseQuota({ rateLimits: beforeRestart })
    await expect(refreshBeforeRestart).resolves.toBe(false)
    expect(state().claudeRateLimits.local).toBeUndefined()
    quotaRequest.mockRestore()
    await state().attachOpened('local')
    await vi.waitFor(() => expect(state().claudeRateLimits.local).toEqual(beforeRestart))

    await state().openThread(threadId!, 'codex')
    expect(selectedAccessMode(state())).toBe('auto')
    state().setAccessMode('default')
    await expect(state().send('按默认权限继续')).resolves.toBe(true)
    expect(accessRpc.mock.calls.filter(([, method]) => method === 'mobile.turn.start')).toHaveLength(1)
    expect(accessRpc).toHaveBeenCalledWith(edited, 'codex.send', expect.objectContaining({
      msg: expect.objectContaining({ method: 'turn/start', params: expect.objectContaining({ threadId }) }),
    }))
    await vi.waitFor(() => expect(state().sessions['codex:local']?.state.threads[threadId!]?.status).toBe('idle'))
    port.setGlobalAccessMode('auto')
    await vi.waitFor(() => expect(state().agentSettings?.globalAccessMode).toBe('auto'))
    expect(selectedAccessMode(state())).toBe('default')
    await expect(state().send('继续使用 Agent 默认权限')).resolves.toBe(true)
    expect(accessRpc).toHaveBeenCalledWith(edited, 'mobile.turn.start', expect.objectContaining({
      targetId: 'local', agent: 'codex', inheritAccess: false, accessMode: 'default',
    }))
    expect(port.lastTurnParams).not.toHaveProperty('sandboxPolicy')
    await vi.waitFor(() => expect(state().sessions['codex:local']?.state.threads[threadId!]?.status).toBe('idle'))
    state().setAccessMode('inherit')
    expect(selectedAccessMode(state())).toBe('auto')
    await expect(state().send('按总控权限继续')).resolves.toBe(true)
    expect(accessRpc).toHaveBeenCalledWith(edited, 'mobile.turn.start', expect.objectContaining({
      targetId: 'local', agent: 'codex', inheritAccess: true, accessMode: 'auto',
    }))
    expect(port.lastTurnParams).toMatchObject({ approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } })
    await vi.waitFor(() => expect(state().sessions['codex:local']?.state.threads[threadId!]?.status).toBe('idle'))
    useApp.setState({ agentSettings: null, legacyAgentSettings: false })
    accessRpc.mockImplementation((connection, method, ...params) => method === 'mobile.agents'
      ? Promise.reject(new Error('暂时无法读取电脑设置')) : callAccessRpc(connection, method, ...params))
    await state().loadAgentSettings()
    await expect(state().send('权限设置暂不可读')).resolves.toBe(true)
    expect(port.lastTurnParams).toMatchObject({ approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } })
    accessRpc.mockImplementation(callAccessRpc)
    await state().loadAgentSettings()
    await state().openThread(claudeThread!, 'claude')
    expect(selectedAccessMode(state())).toBe('auto')
    accessRpc.mockRestore()

    // 只读查看：文本分段续读、行号定位，差异只显示改动卡片自带的 diff，不读 Git。
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

    const gitDiff = vi.spyOn(gateway, 'rpc')
    await state().openDiff({ path: 'D:\code\qingcode-next\a.ts', diff: '+card' })
    expect(state().viewer?.diffSource).toBe('card')
    expect(state().viewer?.diff).toBe('+card')
    await state().openDiff({ path: 'D:\code\qingcode-next\clean.ts' })
    expect(state().viewer?.error).toBe('这次改动没有附带差异')
    expect(gitDiff).not.toHaveBeenCalled()
    gitDiff.mockRestore()
    state().closeViewer()

    const photo = { name: '文件名很长的失败场景验收截图-a-really-long-name.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' }
    const photoDraft = insertImagePlaceholders('失败仍保留', [photo.name]).value
    state().setDraftText(photoDraft, [photo])
    state().addAnnotation('引用', '备注')
    vi.spyOn(gateway, 'rpc').mockRejectedValueOnce(new Error('模拟网络中断'))
    await expect(state().send(composeAttachmentText(photoDraft, [photo]), [{ type: 'image', url: photo.dataUrl }])).resolves.toBe(false)
    expect(state().draftText).toBe(photoDraft)
    expect(state().draftImages).toEqual([photo])
    expect(state().annotations).toMatchObject([{ quote: '引用', comment: '备注' }])
    expect(state().error).toBe('模拟网络中断')
    const photoDraftKey = draftKey(edited.id, 'local', 'p-local', 'claude', claudeThread!, edited.fp)
    await vi.waitFor(async () => {
      expect(JSON.parse((await gateway.storageGet('chatDrafts')) ?? '{}')[photoDraftKey]).toEqual({
        text: '失败仍保留', annotations: state().annotations,
      })
    })

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

    // 断线期间漏了 turn/completed：回放完整但当前会话仍显示运行中时，也要重新读取历史纠正状态。
    const selectedThread = state().selectedThreadId!
    const claudeSession = state().sessions['claude:local']!
    useApp.setState({ sessions: { ...state().sessions, 'claude:local': { ...claudeSession, state: { threads: {
      ...claudeSession.state.threads,
      [selectedThread]: { ...claudeSession.state.threads[selectedThread]!, status: 'running', activity: 'running' },
    } } } } })
    const stuck = vi.spyOn(gateway, 'rpc')
    await state().attachOpened()
    expect(stuck).toHaveBeenCalledWith(edited, 'codex.send', expect.objectContaining({
      agent: 'claude', msg: expect.objectContaining({ method: 'thread/read' }),
    }))
    stuck.mockRestore()

    const firstTransport = state().sessions['claude:local']!.transport
    await state().activate(edited.id, 'targets')
    expect(state()).toMatchObject({ activeId: edited.id, page: 'targets', eventsConnected: true })
    expect(state().sessions['claude:local']?.transport).toBe(firstTransport)
    expect(state().goBack()).toBe(true)
    expect(state()).toMatchObject({ activeId: edited.id, page: 'connections' })

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
    await state().activate(secondDesktop.id, 'targets')
    releaseProjects()
    await previousProjects
    stale.mockRestore()
    expect(state().projects).toEqual([])
    expect(state()).toMatchObject({ activeId: secondDesktop.id, page: 'targets' })
    expect(state().sessions).toEqual({})
    expect(state().rateLimits).toEqual({})
    expect(state().claudeRateLimits).toEqual({})
    expect(state().modelPrefs).toEqual({})
    controller.start()
    await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
    await state().selectTarget('local')
    expect(state().page).toBe('projects')
    expect(state().goBack()).toBe(true)
    expect(state().page).toBe('targets')
    expect(state().goBack()).toBe(true)
    expect(state()).toMatchObject({ activeId: secondDesktop.id, page: 'connections' })
    await state().activate(secondDesktop.id, 'targets')
    await state().selectTarget('local')
    await state().selectProject('p-local')
    await state().openThread(claudeThread!, 'claude')
    expect(state().sessions['claude:local']?.transport).not.toBe(firstTransport)
    expect(state().draftText).toBe('')
    expect(state().draftImages).toEqual([])

    await state().activate(edited.id)
    controller.start()
    await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
    await state().selectTarget('local')
    await state().selectProject('p-local')
    await state().openThread(claudeThread!, 'claude')
    expect(state().draftText).toBe(photoDraft)
    expect(state().draftImages).toEqual([photo])
    expect(state().annotations).toMatchObject([{ quote: '引用', comment: '备注' }])
    expect(state().modelPrefs.codex?.model).toBe('gpt-5.5-mini')

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
    // Claude 也在目标机上归档：失败时停留在会话，成功后电脑端经同一 server 同步隐藏。
    archiveRpc.mockRejectedValueOnce(new Error('模拟 Claude 归档失败'))
    await expect(state().archiveConversation('local', claudeConversation)).rejects.toThrow('模拟 Claude 归档失败')
    expect(state()).toMatchObject({ page: 'chat', selectedThreadId: claudeThread })
    // 首页列表来自工作区缓存；Claude 归档没有本地标记，成功后需从缓存直接移除。
    const cachedClaude = {
      ...claudeConversation, targetId: 'local', projectId: 'p-local', cwd: '/srv/demo', title: 'Claude 会话', preview: '', updatedAt: 1,
    }
    const workspaceBefore = useWorkspace.getState().threads
    useWorkspace.setState({ threads: { ...workspaceBefore, [edited.id]: [cachedClaude] } })
    const stopWorkspace = startWorkspaceObserver()
    await state().archiveConversation('local', claudeConversation)
    expect(useWorkspace.getState().threads[edited.id]?.some((item) => item.id === claudeThread)).toBe(false)
    stopWorkspace()
    useWorkspace.setState({ threads: workspaceBefore })
    expect(archiveRpc).toHaveBeenCalledWith(edited, 'codex.send', expect.objectContaining({
      agent: 'claude', msg: expect.objectContaining({ method: 'thread/archive', params: { threadId: claudeThread } }),
    }))
    expect(state()).toMatchObject({ page: 'threads', selectedThreadId: null })
    await state().refreshThreads({ skipFailed: true })
    expect(state().threads.some((thread) => thread.id === codexThread.id || thread.id === claudeThread)).toBe(false)
    await vi.waitFor(async () => {
      const archives = JSON.parse((await gateway.storageGet('archivedThreads')) ?? '{}')
      // 手机只缓存 Codex 的归档；Claude 的归档以目标机为准，不再本地记录。
      expect(archives).toEqual({
        [archivedThreadKey(edited.id, 'local', codexThread)]: true,
      })
      const saved = JSON.parse((await gateway.storageGet('savedChats')) ?? '{}')
      expect(saved[edited.id]).toBeUndefined()
    })
    const archivedProject = state().projects.find((project) => project.id === 'p-local')!
    await expect(state().listArchivedConversations(archivedProject)).resolves.toMatchObject({
      threads: expect.arrayContaining([expect.objectContaining(codexThread), expect.objectContaining(claudeConversation)]), error: null,
    })
    await state().restoreConversation('local', claudeConversation)
    expect(state().threads).toEqual(expect.arrayContaining([expect.objectContaining(claudeConversation)]))
    await state().restoreConversation('local', codexThread)
    expect(state().threads).toEqual(expect.arrayContaining([expect.objectContaining(codexThread)]))
    await state().renameConversation('local', codexThread.id, '手机重命名的会话')
    expect(state().threads).toEqual(expect.arrayContaining([expect.objectContaining({ ...codexThread, title: '手机重命名的会话' })]))
    await state().archiveConversation('local', codexThread)
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

  it('事件流就绪后立即发送首屏请求，并兼容尚未支持合并请求的网关', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'fast-history', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0,
    }
    useApp.setState({ connections: [...state().connections, conn] })
    const invoke = gateway.rpc.bind(gateway)
    let supportsFastHistory = true
    const rpc = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
      const [, method] = args
      if (method === 'mobile.agents') {
        const settings = await invoke<Record<string, unknown>>(...args)
        return { ...settings, fastHistoryOpen: true }
      }
      if (method === 'mobile.history.open') {
        if (!supportsFastHistory) throw Object.assign(new Error('旧网关'), { code: 'forbidden' })
        return {
          resumed: true, earlier: { turns: 'older' },
          thread: { id: 't-demo', cwd: '', status: { type: 'idle' }, turns: [{
            id: 'latest', status: 'completed', items: [{ id: 'latest', type: 'agentMessage', text: '最晚一轮' }],
          }] },
        }
      }
      return invoke(...args)
    })
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
      rpc.mockClear()
      useApp.setState({ eventsConnected: false })
      vi.useFakeTimers()
      try {
        const opening = state().openThread('t-demo', 'codex')
        expect(rpc).not.toHaveBeenCalled()
        useApp.setState({ eventsConnected: true })
        // 只运行微任务，不推进计时器；旧的 150ms 轮询此时还不会发请求。
        for (let i = 0; i < 8; i++) await Promise.resolve()
        expect(rpc.mock.calls.map(([, method]) => method)).toEqual(['mobile.history.open'])
        await expect(opening).resolves.toBe(true)
        await vi.advanceTimersByTimeAsync(250)
      } finally {
        vi.useRealTimers()
      }
      const opened = state().sessions['codex:local']
      expect(opened?.state.threads['t-demo']?.items.map((item) => item.id)).toEqual(['latest'])
      expect(opened?.resumedCodexThreads.has('t-demo')).toBe(true)

      supportsFastHistory = false
      opened?.loadedThreads.delete('t-demo')
      rpc.mockClear()
      await expect(state().openThread('t-demo', 'codex')).resolves.toBe(true)
      expect(rpc.mock.calls.map(([, method, params]) => method === 'codex.send'
        ? (params as { msg: { method: string } }).msg.method : method)).toEqual([
        'mobile.history.open', 'thread/resume', 'thread/turns/list',
      ])
    } finally {
      rpc.mockRestore()
      controller.stop()
      for (const session of Object.values(state().sessions)) {
        session.rpc.dispose()
        session.transport.dispose()
      }
    }
  })

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
      let needsReconnect = true
      const disconnected = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
        const [, method, params] = args
        const request = params as { msg?: { method?: string } }
        if (needsReconnect && method === 'codex.send' && request.msg?.method === 'thread/resume') {
          needsReconnect = false
          throw Object.assign(new Error('目标未连接'), { code: 'not_connected' })
        }
        return rpc(...args)
      })
      try {
        await expect(state().openThread('c-demo', 'claude')).resolves.toBe(true)
        expect(disconnected.mock.calls.filter(([, method]) => method === 'target.connect')).toHaveLength(1)
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
      expect(state()).toMatchObject({ selectedThreadId: 'c-demo', openingThread: null })
      expect(delayed.mock.calls.filter(([, method, params]) =>
        method === 'codex.send' && (params as { agent?: string }).agent === 'claude',
      )).toEqual([])
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

      vi.useFakeTimers()
      try {
        const timedOut = state().openThread('t-demo', 'codex')
        await vi.advanceTimersByTimeAsync(250)
        expect(releaseResume).toBeTypeOf('function')
        await vi.advanceTimersByTimeAsync(30_000)
        await expect(timedOut).resolves.toBe(false)
        expect(state()).toMatchObject({
          selectedThreadId: 'c-demo', openingThread: null, error: expect.stringContaining('打开会话超时'),
        })
        expect(delayed.mock.calls.some(([, method, params]) =>
          method === 'codex.send' && (params as { msg?: { method?: string } }).msg?.method === 'thread/read',
        )).toBe(false)
        releaseHistory()
        await vi.advanceTimersByTimeAsync(250)
        expect(state()).toMatchObject({ selectedThreadId: 'c-demo', openingThread: null })
      } finally {
        vi.useRealTimers()
      }
      delayed.mockRestore()
      await expect(state().openThread('t-demo', 'codex')).resolves.toBe(true)
      expect(state()).toMatchObject({ selectedThreadId: 't-demo', openingThread: null, error: null })

      state().handleGatewayEvent({
        name: 'codex.recv',
        payload: { targetId: 'local', seq: null, msg: { method: 'thread/closed', params: { threadId: 't-demo' } } },
      })
      const reopened = state().openThread('t-demo', 'codex')
      expect(state().openingThread).toMatchObject({ threadId: 't-demo' })
      await expect(reopened).resolves.toBe(true)
    } finally {
      releaseHistory()
      controller.stop()
      for (const session of Object.values(state().sessions)) {
        session.rpc.dispose()
        session.transport.dispose()
      }
    }
  })

  it('pi 按所选模型的输入模态发送图片', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'pi-images', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0,
    }
    const invoke = gateway.rpc.bind(gateway)
    const rpc = vi.spyOn(gateway, 'rpc').mockImplementation((...args) => {
      const [, method, params] = args
      const request = params as { method?: string; params?: { agent?: string } }
      if (method === 'server.req' && request.method === 'codex.open' && request.params?.agent === 'pi') {
        return Promise.resolve({ initialize: null, lastSeq: 0 }) as ReturnType<typeof gateway.rpc>
      }
      return invoke(...args)
    })
    const controller = new EventStreamController(gateway, () => conn, {
      onEvent: state().handleGatewayEvent,
      onOpen: () => useApp.setState({ eventsConnected: true }),
      onClose: () => useApp.setState({ eventsConnected: false }),
    })
    const image = { type: 'image' as const, url: 'data:image/png;base64,QUJD' }
    try {
      useApp.setState({ connections: [...state().connections, conn] })
      await state().activate(conn.id)
      controller.start()
      await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
      await state().selectTarget('local')
      await state().selectProject('p-local')
      await expect(state().newThread('pi')).resolves.toBe(true)

      const key = sessionKey('local', 'pi')
      const models = toModelOptions([
        { id: 'p/text', model: 'p/text', inputModalities: ['text'], isDefault: true },
        { id: 'p/vision', model: 'p/vision', inputModalities: ['text', 'image'] },
      ])
      useApp.setState({ models: { ...state().models, [key]: { models, loading: false, error: null } } })
      await expect(state().send('文本模型', [image])).resolves.toBe(false)
      expect(state().error).toContain('当前模型不支持')

      state().setModelPrefs('local', 'pi', { model: 'p/vision', effort: null, fast: false })
      await expect(state().send('视觉模型', [image])).resolves.toBe(true)
      expect(rpc.mock.calls).toContainEqual([conn, 'codex.send', expect.objectContaining({
        agent: 'pi', msg: expect.objectContaining({ method: 'turn/start', params: expect.objectContaining({
          model: 'p/vision', input: expect.arrayContaining([image]), clientUserMessageId: expect.any(String),
        }) }),
      })])
      const threadId = state().selectedThreadId!
      const users = () => state().sessions[key]?.state.threads[threadId]?.items.filter((item) => item.kind === 'user')
      const expectedTurnId = state().sessions[key]?.state.threads[threadId]?.activeTurnId
      await expect(state().send('pi 补充要求', [], false, 'steer')).resolves.toBe(true)
      expect(rpc.mock.calls).toContainEqual([conn, 'codex.send', expect.objectContaining({
        agent: 'pi', msg: expect.objectContaining({ method: 'turn/steer', params: expect.objectContaining({ expectedTurnId }) }),
      })])
      await vi.waitFor(() => expect(state().sessions[key]?.state.threads[threadId]?.status).toBe('idle'))
      const before = users()
      expect(before).toMatchObject([
        { text: '视觉模型', images: [image.url], clientId: expect.any(String) },
        { text: 'pi 补充要求', steering: 'currentTurn' },
      ])
      await expect(state().openThread(threadId, 'pi')).resolves.toBe(true)
      expect(users()).toMatchObject([
        { id: before?.[0]?.id, text: '视觉模型', images: [image.url] },
        { id: before?.[1]?.id, text: 'pi 补充要求', steering: 'currentTurn' },
      ])
    } finally {
      controller.stop()
      await state().removeConnection(conn.id)
    }
  })

  it('压缩只发送一次并保留草稿，收到压缩事件后显示进度和结果', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'compact-desktop', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    useApp.setState({ connections: [...state().connections, conn] })
    await state().activate(conn.id)
    const controller = new EventStreamController(gateway, () => conn, {
      onEvent: (event) => state().handleGatewayEvent(event),
      onOpen: () => useApp.setState({ eventsConnected: true }),
      onClose: () => useApp.setState({ eventsConnected: false }),
    })
    const rpc = vi.spyOn(gateway, 'rpc')
    controller.start()
    try {
      await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
      await state().selectTarget('local')
      await state().selectProject('p-local')
      await expect(state().openThread('t-demo', 'codex')).resolves.toBe(true)
      state().setDraftText('保留草稿')
      const thread = () => state().sessions[sessionKey('local', 'codex')]?.state.threads['t-demo']
      const original = thread()?.items
      expect(original?.length).toBeGreaterThan(0)

      const started = state().compactConversation()
      expect(selectedCompactionStarting(state())).toBe(true)
      await expect(state().compactConversation()).resolves.toBe(false)
      // 启动压缩期间的消息排队，等压缩这一轮结束后再发送。
      await expect(state().send('压缩尚未开始', [], false, 'steer')).resolves.toBe(true)
      expect(selectedQueuedSends(state())?.map((message) => message.text)).toEqual(['压缩尚未开始'])
      state().removeQueuedSend(selectedQueuedSends(state())![0]!.id)
      state().setDraftText('保留草稿')
      await expect(started).resolves.toBe(true)
      expect(thread()?.status).toBe('running')
      await expect(state().compactConversation()).resolves.toBe(false)
      await vi.waitFor(() => expect(thread()?.status).toBe('idle'))
      expect(thread()?.items).toEqual([
        ...original!,
        expect.objectContaining({ type: 'contextCompaction', status: 'completed' }),
      ])
      expect(state().draftText).toBe('保留草稿')
      const compactions = () => rpc.mock.calls.filter(([, method, params]) =>
        method === 'codex.send' && (params as { msg?: { method?: string } }).msg?.method === 'thread/compact/start')
      expect(compactions()).toHaveLength(1)
      expect(compactions()[0]?.[2]).toMatchObject({ msg: { params: { threadId: 't-demo' } } })
      await expect(state().openThread('c-demo', 'claude')).resolves.toBe(true)
      await expect(state().compactConversation()).resolves.toBe(true)
      expect(compactions()[1]?.[2]).toMatchObject({ agent: 'claude', msg: { params: { threadId: 'c-demo' } } })
      await vi.waitFor(() => expect(state().sessions[sessionKey('local', 'claude')]?.state.threads['c-demo']?.items)
        .toContainEqual(expect.objectContaining({ type: 'contextCompaction', status: 'completed' })))
    } finally {
      controller.stop()
      rpc.mockRestore()
      await state().removeConnection(conn.id)
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
      const png = 'data:image/png;base64,AA=='
      state().setDraftText('排队一', [{ name: 'img.png', mime: 'image/png', dataUrl: png }])
      await expect(state().send(state().draftText, [{ type: 'image', url: png }])).resolves.toBe(true)
      expect(state().draftText).toBe('')
      expect(state().draftImages).toEqual([])
      await expect(state().send('移除这条')).resolves.toBe(true)
      await expect(state().send('排队二')).resolves.toBe(true)
      expect(queue().map((message) => message.text)).toEqual(['排队一', '移除这条', '排队二'])
      state().removeQueuedSend(queue()[1]!.id)
      const editId = queue()[0]!.id
      const finishEdit = state().beginQueuedEdit(editId)!
      expect(turnMethods()).toEqual(['turn/start'])

      await expect(state().send('补充方向', [], false, 'steer')).resolves.toBe(true)
      expect(rpc).toHaveBeenCalledWith(conn, 'codex.send', expect.objectContaining({
        agent: 'codex', msg: expect.objectContaining({ method: 'turn/steer', params: expect.objectContaining({
          threadId: 't-demo', expectedTurnId: firstTurn,
        }) }),
      }))
      expect(view()?.activeTurnId).toBe(firstTurn)
      expect(texts()).toContain('补充方向')

      await vi.waitFor(() => expect(view()?.status).toBe('idle'))
      expect(turnMethods()).toEqual(['turn/start', 'turn/steer'])
      await expect(state().editQueuedSend(editId, '排队一（已编辑）')).resolves.toBe(true)
      expect(queue().map((message) => message.text)).toEqual(['排队一（已编辑）', '排队二'])
      finishEdit()
      await vi.waitFor(() => expect(view()?.items).toContainEqual(expect.objectContaining({ text: '排队一（已编辑）', images: [png] })))
      await vi.waitFor(() => expect(queue().map((message) => message.text)).toEqual(['排队二']))
      await expect(state().send('立即跟进', [], false, 'immediate')).resolves.toBe(true)
      expect(texts()).toContain('立即跟进')
      expect(queue()[0]?.error).toBeUndefined()
      expect(turnMethods()).toEqual(['turn/start', 'turn/steer', 'turn/start', 'turn/interrupt', 'turn/start'])

      const noticeBeforeStop = state().notice
      await state().interrupt()
      expect(view()?.activity).toBe('interrupted')
      expect(state().notice).toBe(noticeBeforeStop)
      expect(queue()[0]).toMatchObject({ text: '排队二', error: '上一轮未完成，队列已暂停' })
      expect(texts()).not.toContain('排队二')
      await state().retryQueuedSend()
      await vi.waitFor(() => expect(view()?.status).toBe('idle'))
      expect(texts()).toEqual(['你好', '第一条', '补充方向', '排队一（已编辑）', '立即跟进', '排队二'])
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

      await expect(state().send('再开一轮')).resolves.toBe(true)
      const runningTurn = view()?.activeTurnId
      await expect(state().send('排队后改为引导', [{ type: 'image', url: png }])).resolves.toBe(true)
      const steering = vi.spyOn(gateway, 'rpc')
      await expect(state().steerQueuedSend(queue()[0]!.id)).resolves.toBe(true)
      expect(steering.mock.calls).toContainEqual([
        conn, 'codex.send', expect.objectContaining({ msg: expect.objectContaining({
          method: 'turn/steer', params: expect.objectContaining({ expectedTurnId: runningTurn }),
        }) }),
      ])
      expect(view()?.activeTurnId).toBe(runningTurn)
      expect(view()?.items).toContainEqual(expect.objectContaining({ text: '排队后改为引导', images: [png] }))
      expect(queue()).toEqual([])
      steering.mockRestore()

      await state().openThread('c-demo', 'claude')
      // 引导时没有运行中的轮次：按普通消息发送。
      await expect(state().send('开始 Claude 对话', [], false, 'steer')).resolves.toBe(true)
      const claudeView = () => state().sessions['claude:local']?.state.threads['c-demo']
      const claudeTurn = claudeView()?.activeTurnId
      expect(claudeTurn).toBeTruthy()
      await expect(state().send('Claude 排队后引导')).resolves.toBe(true)
      await expect(state().steerQueuedSend(queue()[0]!.id)).resolves.toBe(true)
      expect(claudeView()?.items).toContainEqual(expect.objectContaining({ text: 'Claude 排队后引导', steering: 'currentTurn' }))
      expect(queue()).toEqual([])
    } finally {
      controller.stop()
      await state().removeConnection(conn.id)
    }
  }, 10_000)

  it('切回电脑保留会话权限，排队消息按实际发送前的最后一次设置执行', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const state = useApp.getState
    const conn = {
      id: 'queued-access', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    const other = { ...conn, id: 'queued-access-other', name: '另一台电脑' }
    useApp.setState({ connections: [...state().connections, conn, other] })
    const controller = new EventStreamController(gateway,
      () => state().connections.find((item) => item.id === state().activeId) ?? null,
      {
        onEvent: state().handleGatewayEvent,
        onOpen: () => useApp.setState({ eventsConnected: true }),
        onClose: () => useApp.setState({ eventsConnected: false }),
      })
    const openChat = async (desktopId = conn.id) => {
      await state().activate(desktopId)
      controller.start()
      await vi.waitFor(() => expect(state().eventsConnected).toBe(true))
      await state().selectTarget('local')
      await state().selectProject('p-local')
      await expect(state().openThread('t-demo', 'codex')).resolves.toBe(true)
    }
    try {
      await openChat()
      state().setAccessMode('auto')
      expect(selectedAccessMode(state())).toBe('auto')
      await expect(state().send('第一轮')).resolves.toBe(true)
      // 运行中也能修改：选择立即保存，本轮仍显示实际生效的档位。
      expect(state().sessions['codex:local']?.state.threads['t-demo']?.status).toBe('running')
      state().setAccessMode('default')
      expect(selectedAccessMode(state())).toBe('default')
      expect(displayedAccessMode(state())).toBe('auto')
      state().setAccessMode('auto')
      expect(selectedAccessMode(state())).toBe('auto')
      await expect(state().send('等待发送的消息')).resolves.toBe(true)
      expect(selectedQueuedSends(state())?.[0]?.accessMode).toBeUndefined()
      controller.stop()
      await openChat(other.id)
      expect(selectedAccessMode(state())).toBe('default')
      expect(selectedQueuedSends(state())).toBeUndefined()
      controller.stop()
      await openChat()
      expect(selectedAccessMode(state())).toBe('auto')
      expect(selectedQueuedSends(state())?.[0]?.error).toContain('队列已暂停')
      await vi.waitFor(() => expect(state().sessions['codex:local']?.state.threads['t-demo']?.status).toBe('idle'))

      const queueKey = JSON.stringify([conn.id, 'local', 'codex', 't-demo'])
      useApp.setState(({ queuedSends }) => ({
        queuedSends: { ...queuedSends, [queueKey]: queuedSends[queueKey]!.map((item) => ({ ...item, accessMode: 'auto' })) },
      }))
      state().setAccessMode('default')
      const preference = accessPreferenceKey({ desktopId: conn.id, targetId: 'local', agent: 'codex', threadId: 't-demo' }, conn.fp)
      await vi.waitFor(async () => {
        expect(JSON.parse(await gateway.storageGet(ACCESS_PREFS_STORAGE_KEY) ?? '{}')[preference]).toBe('default')
      })
      const rpc = vi.spyOn(gateway, 'rpc')
      await state().retryQueuedSend()
      expect(rpc.mock.calls.filter(([, , params]) => JSON.stringify(params)?.includes('等待发送的消息')))
        .toEqual([[conn, 'codex.send', expect.objectContaining({
          msg: expect.objectContaining({ method: 'turn/start' }),
        })]])
      expect(selectedQueuedSends(state())).toBeUndefined()
      expect(displayedAccessMode(state())).toBe('default')
      expect(selectedAccessMode(state())).toBe('default')
    } finally {
      controller.stop()
      await state().removeConnection(conn.id)
      await state().removeConnection(other.id)
    }
  })

  it('从工作台进入后按来路返回，切换标签后丢弃迟到的跳转', async () => {
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
      const another = threads.find((item) => item.id === 'c-demo')!
      useWorkspace.setState({ tab: 'projects', threads: { [conn.id]: threads } })

      const openingProject = showWorkspaceProject(project)
      expect(pages).toEqual(['threads'])
      expect(state()).toMatchObject({ selectedTargetId: project.targetId, selectedProjectId: project.id })
      expect(state().threads).toContainEqual(thread)
      await openingProject
      await expect(state().openThread(thread.id, thread.agent)).resolves.toBe(true)
      expect(state().goBack()).toBe(true)
      expect(state()).toMatchObject({ page: 'threads', selectedProjectId: project.id, selectedThreadId: null })
      expect(state().goBack()).toBe(true)
      expect(pages).toEqual(['threads', 'chat', 'threads', 'workspace'])
      expect(useWorkspace.getState().tab).toBe('projects')
      useWorkspace.getState().setTab('sessions')
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
        const openingThread = openWorkspaceThread(another, project)
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

      const requests = vi.spyOn(gateway, 'rpc')
      const reopened = openWorkspaceThread(thread, project)
      expect(pages).toEqual(['chat'])
      expect(state()).toMatchObject({
        selectedTargetId: thread.targetId, selectedProjectId: thread.projectId, selectedThreadId: thread.id,
      })
      expect(state().sessions['codex:local']?.state.threads[thread.id]?.items.length).toBeGreaterThan(0)
      await expect(reopened).resolves.toBe(true)
      expect(requests.mock.calls.map(([, method]) => method)).toEqual(['projects.save'])
      requests.mockRestore()
      await expect(openWorkspaceThread(another, project)).resolves.toBe(true)
      expect(state().goBack()).toBe(true)
      expect(pages).toEqual(['chat', 'workspace'])
      expect(state()).toMatchObject({ page: 'workspace', selectedTargetId: null, selectedProjectId: null, selectedThreadId: null })
      expect(useWorkspace.getState().tab).toBe('sessions')

      await expect(state().newThread('codex', { project, projects, threads })).resolves.toBe(true)
      const newThreadId = state().selectedThreadId
      const savedChat = async () => JSON.parse(await gateway.storageGet('savedChats') ?? '{}')[conn.id]
      await vi.waitFor(async () => expect((await savedChat())?.threadId).toBe(newThreadId))
      expect(state().goBack()).toBe(true)
      expect(pages).toEqual(['chat', 'workspace', 'chat', 'workspace'])
      await vi.waitFor(async () => expect(await savedChat()).toBeUndefined())
    } finally {
      unsubscribe()
      controller.stop()
      useWorkspace.setState({ threads: {} })
      await state().removeConnection(conn.id)
    }
  })

  it('冷启动恢复会话和草稿，按顺序续发待发项并保留发送结果未确认的项', async () => {
    const gateway = createGateway()
    setGateway(gateway)
    const conn = {
      id: 'cold-start-desktop', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: Date.now(),
    }
    const chat = { targetId: 'local', projectId: 'p-local', agent: 'codex', threadId: 't-demo' } as const
    const key = draftKey(conn.id, chat.targetId, chat.projectId, chat.agent, chat.threadId, conn.fp)
    const queueKey = JSON.stringify([conn.id, chat.targetId, chat.agent, chat.threadId])
    const relayQueueKey = JSON.stringify([conn.id, chat.targetId, 'claude', 'c-demo'])
    const queued = {
      id: 'saved-message', text: '重启前排队的消息', annotations: [], delegate: false, overrides: {},
      attachments: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    }
    const relayed = { ...queued, id: 'relayed', text: '已由电脑代发', relayPending: true }
    const compact = { ...queued, id: 'compact', text: '/compact', compact: true, attachments: [] }
    const unconfirmed = { ...queued, id: 'unconfirmed', text: '重启前已发出', sending: true }
    const missingRelay = { ...relayed, id: 'missing-relay', text: '电脑代发记录已丢失' }
    await Promise.all([
      gateway.storageSet('connections', serializeConnections([conn])),
      gateway.storageSet('active', conn.id),
      gateway.storageSet('savedChats', JSON.stringify({ [conn.id]: chat })),
      gateway.storageSet('chatDrafts', JSON.stringify({ [key]: { text: '冷启动草稿', annotations: [] } })),
      gateway.storageSet('queuedSends', JSON.stringify({
        [queueKey]: { fp: conn.fp, items: [relayed, compact, queued, unconfirmed] },
        [relayQueueKey]: { fp: conn.fp, items: [missingRelay] },
      })),
    ])
    const rpc = gateway.rpc.bind(gateway)
    const state = useApp.getState
    const sends: string[] = []
    let connected = false
    let releaseTake!: () => void
    const take = new Promise<void>((resolve) => { releaseTake = resolve })
    const requests = vi.spyOn(gateway, 'rpc').mockImplementation(async (...args) => {
      const [, method, params] = args
      if (method === 'mobile.queue.take') {
        await take
        return { queues: [{ targetId: chat.targetId, agent: chat.agent, threadId: chat.threadId, sentIds: [relayed.id] }] } as never
      }
      if (method === 'target.connect') connected = true
      if (!connected && method === 'server.req' && (params as { method?: string }).method === 'codex.open') {
        throw Object.assign(new Error('目标未连接'), { code: 'not_connected' })
      }
      const msg = (params as { msg?: { method?: string } }).msg
      if (method === 'codex.send' && msg?.method === 'thread/compact/start') sends.push(msg.method)
      if (method === 'codex.send' && msg?.method === 'turn/start') {
        expect(state().sessions['codex:local']?.state.threads[chat.threadId]?.items)
          .toContainEqual(expect.objectContaining({ type: 'contextCompaction', status: 'completed' }))
        sends.push(msg.method)
      }
      return rpc(...args)
    })
    state().init()
    try {
      await vi.waitFor(() => expect(requests.mock.calls.some(([, method]) => method === 'mobile.queue.take')).toBe(true))
      expect(sends).toEqual([])
      releaseTake()
      await vi.waitFor(() => {
        expect(state()).toMatchObject({
          page: 'chat', selectedThreadId: chat.threadId, activeId: conn.id, draftText: '冷启动草稿',
        })
        expect(selectedQueuedSends(state())).toMatchObject([
          { ...unconfirmed, sending: false, error: UNCONFIRMED_QUEUED_SEND },
        ])
      })
      expect(sends).toEqual(['thread/compact/start', 'turn/start'])
      expect(requests.mock.calls).toContainEqual([
        conn, 'codex.send', expect.objectContaining({ msg: expect.objectContaining({ method: 'turn/start', params: expect.objectContaining({
          input: [{ type: 'text', text: queued.text, text_elements: [] }, ...queued.attachments],
        }) }) }),
      ])
      expect(state().queuedSends[relayQueueKey]).toMatchObject([{ id: missingRelay.id, error: UNCONFIRMED_QUEUED_SEND }])
      expect(requests.mock.calls).not.toContainEqual([
        conn, 'server.req', expect.objectContaining({ method: 'ping' }),
      ])
      expect(requests.mock.calls.filter(([, method]) => method === 'target.connect')).toHaveLength(1)
      expect(state().goBack()).toBe(true)
      expect(state().page).toBe('workspace')
    } finally {
      releaseTake()
      await state().removeConnection(conn.id)
    }
  })
})
