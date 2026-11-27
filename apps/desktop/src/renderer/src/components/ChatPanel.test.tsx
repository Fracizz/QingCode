// @vitest-environment jsdom
import { act, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { applyNotification, CodexRpc, type ItemView, type ThreadView } from '@qn/codex-client'
import { sessionKey } from '../lib/agents'
import { BackendCodexTransport } from '../lib/codexTransport'
import { currentChatKey, useCodex } from '../store/codex'
import { ChatPanel } from './ChatPanel'
import { TooltipProvider } from './primitives'
import { RenderBoundary } from './RenderBoundary'
import { SideChat } from './SideChat'

it.each(['codex', 'claude', 'pi'] as const)('从 %s 的已结束回复创建新对话，当前轮次不可用', async (agent) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initialState = useCodex.getState()
  const targetId = 'local'
  const key = sessionKey(targetId, agent)
  const transport = new BackendCodexTransport(targetId, agent)
  const rpc = new CodexRpc(transport)
  const forkThread = vi.fn(async () => true)
  const makeTurn = (id: string) => ({
    id, startedAtMs: null, durationMs: null, itemIds: [`${id}-user`, `${id}-reply`],
  })
  const view: ThreadView = {
    id: 'source', status: 'running', activeTurnId: 'active', pendingApprovals: [],
    turns: [makeTurn('past'), makeTurn('active')],
    items: ['past', 'active'].flatMap((id): ItemView[] => [
      { kind: 'user', id: `${id}-user`, text: id },
      { kind: 'agent', id: `${id}-reply`, text: `${id} reply`, streaming: false },
    ]),
  }
  useCodex.setState({
    currentTargetId: targetId, currentAgent: agent, currentCwd: '/work', currentThreadId: 'source', forkThread,
    sessions: { [key]: {
      key, targetId, agent, rpc, transport, state: { threads: { source: view } },
      threadsAwaitingResume: new Set(), opened: false, openedConfig: null,
      opening: false, openError: null, openFailure: null, agentVersion: null, lastSeq: null,
    } },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const open = (trigger: HTMLElement) => act(() =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const action = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((entry) => entry.textContent?.trim() === '新建对话继续')
  try {
    await act(() => root.render(<TooltipProvider><ChatPanel onConnect={() => {}} onAddTarget={() => {}} /></TooltipProvider>))
    const [past, active] = host.querySelectorAll<HTMLElement>('button[aria-label="更多操作"]')
    await open(active!)
    expect(action()).toBeUndefined()
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await open(past!)
    expect(action()).toBeDefined()
    await act(() => action()!.click())
    expect(forkThread).toHaveBeenCalledExactlyOnceWith('source', agent, 'past')
  } finally {
    await act(() => root.unmount())
    host.remove()
    rpc.dispose()
    transport.dispose()
    useCodex.setState(initialState, true)
    vi.unstubAllGlobals()
  }
})

it('主对话和侧聊在显示正在思考时隐藏兜底进度，仍显示等待输入', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initialState = useCodex.getState()
  const targetId = 'local'
  const key = sessionKey(targetId, 'codex')
  const transport = new BackendCodexTransport(targetId)
  const rpc = new CodexRpc(transport)
  const makeThread = (id: string): ThreadView => ({
    id, status: 'running', activeTurnId: 'turn', pendingApprovals: [], items: [],
    turns: [{ id: 'turn', startedAtMs: null, durationMs: null, itemIds: [] }],
  })
  useCodex.setState({
    currentTargetId: targetId, currentAgent: 'codex', currentCwd: '/work', currentThreadId: 'front',
    sessions: { [key]: {
      key, targetId, agent: 'codex', rpc, transport,
      state: { threads: { front: makeThread('front'), side: makeThread('side') } },
      threadsAwaitingResume: new Set(), opened: false, openedConfig: null,
      opening: false, openError: null, openFailure: null, agentVersion: null, lastSeq: null,
    } },
  })
  useCodex.setState({ sideChats: { [currentChatKey(useCodex.getState())]: {
    targetId, agent: 'codex', cwd: '/work', parentThreadId: 'front', threadId: 'side',
    open: true, busy: false, expired: false, draft: '', firstMessage: '', annotations: [], error: null,
  } } })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const update = (notification: (threadId: string) => Parameters<typeof applyNotification>[1]) =>
    act(() => useCodex.setState((state) => {
      const session = state.sessions[key]!
      const next = applyNotification(applyNotification(session.state, notification('front')), notification('side'))
      return { sessions: { ...state.sessions, [key]: { ...session, state: next } } }
    }))
  const expectProgress = (...messages: string[]) => {
    for (const selector of ['main', 'aside[aria-label="侧边对话"]']) {
      const rows = host.querySelector(selector)!.querySelectorAll('.qn-message-activity')
      const progress = Array.from(rows, (row) => row.textContent).filter((text) => text?.endsWith('…'))
      expect(progress, selector).toEqual(messages)
    }
  }

  try {
    await act(() => root.render(
      <TooltipProvider><ChatPanel onConnect={() => {}} onAddTarget={() => {}} /><SideChat /></TooltipProvider>,
    ))
    expectProgress('正在处理…')

    await update((threadId) => ({ method: 'item/reasoning/summaryTextDelta', params: {
      threadId, turnId: 'turn', itemId: 'reasoning', summaryIndex: 0, delta: '分析请求',
    } }))
    expectProgress('正在思考…')

    await update((threadId) => ({ method: 'thread/status/changed', params: {
      threadId, status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    } }))
    expectProgress('正在思考…', '等待输入…')

    await update((threadId) => ({ method: 'thread/status/changed', params: {
      threadId, status: { type: 'active', activeFlags: [] },
    } }))
    await update((threadId) => ({ method: 'item/completed', params: {
      threadId, turnId: 'turn', completedAtMs: 1,
      item: { type: 'reasoning', id: 'reasoning', summary: ['分析请求'], content: [] },
    } }))
    expectProgress('正在处理…')
  } finally {
    await act(() => root.unmount())
    host.remove()
    rpc.dispose()
    transport.dispose()
    useCodex.setState(initialState, true)
    vi.unstubAllGlobals()
  }
})

it('同一目标的后台会话增量不会让主对话和侧边对话重绘', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initialState = useCodex.getState()
  const targetId = 'local'
  const key = sessionKey(targetId, 'codex')
  const transport = new BackendCodexTransport(targetId)
  const rpc = new CodexRpc(transport)
  const makeThread = (id: string): ThreadView => ({
    id, status: 'running', activeTurnId: 'turn', pendingApprovals: [],
    items: [{ id: 'reply', kind: 'agent', text: '输出', streaming: true }],
  })
  useCodex.setState({
    currentTargetId: targetId, currentAgent: 'codex', currentCwd: '/work', currentThreadId: 'front',
    sessions: { [key]: {
      key, targetId, agent: 'codex', rpc, transport,
      state: { threads: { front: makeThread('front'), back: makeThread('back'), side: makeThread('side') } },
      threadsAwaitingResume: new Set(), opened: false, openedConfig: null,
      opening: false, openError: null, openFailure: null, agentVersion: null, lastSeq: null,
    } },
  })
  useCodex.setState({ sideChats: { [currentChatKey(useCodex.getState())]: {
    targetId, agent: 'codex', cwd: '/work', parentThreadId: 'front', threadId: 'side',
    open: true, busy: false, expired: false, draft: '', firstMessage: '', annotations: [], error: null,
  } } })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const mainRender = vi.fn()
  const sideRender = vi.fn()
  const append = (threadId: string, delta: string) => act(() => useCodex.setState((state) => {
    const session = state.sessions[key]!
    const next = applyNotification(session.state, {
      method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'reply', delta },
    })
    return { sessions: { ...state.sessions, [key]: { ...session, state: next } } }
  }))

  try {
    await act(() => root.render(
      <TooltipProvider>
        <Profiler id="main" onRender={mainRender}><ChatPanel onConnect={() => {}} onAddTarget={() => {}} /></Profiler>
        <Profiler id="side" onRender={sideRender}><SideChat /></Profiler>
      </TooltipProvider>,
    ))
    mainRender.mockClear()
    sideRender.mockClear()

    await append('back', '后台增量')
    expect(useCodex.getState().sessions[key]?.state.threads.back?.items[0]).toMatchObject({ text: '输出后台增量' })
    expect(mainRender).not.toHaveBeenCalled()
    expect(sideRender).not.toHaveBeenCalled()

    await append('front', '主对话增量')
    expect(host.querySelector('main')?.textContent).toContain('输出主对话增量')
    expect(sideRender).not.toHaveBeenCalled()
    mainRender.mockClear()

    await append('side', '侧边对话增量')
    expect(host.querySelector('aside[aria-label="侧边对话"]')?.textContent).toContain('输出侧边对话增量')
    expect(mainRender).not.toHaveBeenCalled()

    await act(() => useCodex.setState((state) => {
      const session = state.sessions[key]!
      const child: ThreadView = {
        ...makeThread('child'),
        subagent: { parentThreadId: 'front', name: '检查助手', role: '', model: '', task: '' },
      }
      const next = { threads: { ...session.state.threads, child } }
      return { sessions: { ...state.sessions, [key]: { ...session, state: next } } }
    }))
    expect(host.querySelector('button[aria-label="子代理"]')?.textContent).toContain('1')
  } finally {
    await act(() => root.unmount())
    host.remove()
    rpc.dispose()
    transport.dispose()
    useCodex.setState(initialState, true)
    vi.unstubAllGlobals()
  }
})

it.each([null, 'existing-thread'])('发送纯文本后仍可继续输入（会话 %s）', async (threadId) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initialState = useCodex.getState()
  const send = vi.fn<typeof initialState.send>(async (_text, options) => {
    if (!useCodex.getState().currentThreadId) {
      options?.onThreadCreated?.('new-thread')
      useCodex.setState({ currentThreadId: 'new-thread' })
    }
    return true
  })
  useCodex.setState({ currentTargetId: 'local', currentThreadId: threadId, send })
  const host = document.body.appendChild(document.createElement('div'))
  const onCaughtError = vi.fn()
  const root = createRoot(host, { onCaughtError })

  const typeMessage = (text: string) => act(() => {
    const input = host.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })

  try {
    await act(() => root.render(
      <RenderBoundary fallback={<p>桌面界面显示异常</p>}>
        <TooltipProvider>
          <ChatPanel onConnect={() => {}} onAddTarget={() => {}} />
        </TooltipProvider>
      </RenderBoundary>,
    ))
    expect(host.querySelector('button[aria-label="子代理"]')).toBeNull()
    await typeMessage('第一条消息')
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())

    expect(send).toHaveBeenCalledExactlyOnceWith('第一条消息', expect.objectContaining({
      input: [{ type: 'text', text: '第一条消息', text_elements: [] }],
    }))
    expect(onCaughtError).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')?.value).toBe('')
    await typeMessage('下一条消息')
    expect(host.querySelector('textarea')?.value).toBe('下一条消息')

    await typeMessage('/help')
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('/compact')
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState(initialState, true)
    vi.unstubAllGlobals()
  }
})

it.each(['paste', 'drop', 'picker'])('图片占位可以预览且随附件单独发送（%s）', async (source) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const decodeImage = vi.fn().mockRejectedValue(new Error('jsdom 不解码图片'))
  vi.stubGlobal('createImageBitmap', decodeImage)
  const initialState = useCodex.getState()
  const send = vi.fn<typeof initialState.send>().mockResolvedValue(true)
  useCodex.setState({ currentTargetId: 'local', currentAgent: 'codex', currentThreadId: null, send })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)

  try {
    await act(() => root.render(
      <TooltipProvider>
        <ChatPanel onConnect={() => {}} onAddTarget={() => {}} />
      </TooltipProvider>,
    ))
    const area = host.querySelector('textarea')!
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '看这图 [其他.png]')
      area.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    area.setSelectionRange(1, 2)
    const files = [new File(['image content'], 'image.png', { type: 'image/png' })]

    await act(async () => {
      if (source === 'picker') {
        const picker = host.querySelector<HTMLInputElement>('input[type=file]')!
        Object.defineProperty(picker, 'files', { value: files })
        picker.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        const event = new Event(source, { bubbles: true, cancelable: true })
        const transfer = { files, types: ['Files'], getData: () => '' }
        Object.defineProperty(event, source === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer })
        area.dispatchEvent(event)
      }
      await vi.waitFor(() => expect(decodeImage).toHaveBeenCalledTimes(1))
    })

    expect(area.value).toBe('看 [image.png] 图 [其他.png]')
    expect(area.selectionStart).toBe('看 [image.png] '.length)
    expect(document.activeElement).toBe(area)
    expect(host.querySelectorAll('[aria-label="移除 image.png"]')).toHaveLength(1)
    const highlighted = host.querySelectorAll('.text-qn-composer-attachment')
    expect([...highlighted].map((node) => node.textContent)).toEqual(['[image.png]'])
    expect(highlighted[0]?.parentElement?.textContent).toBe(area.value)

    const dialog = host.querySelector<HTMLDialogElement>('dialog[aria-label="图片预览 image.png"]')!
    const showModal = vi.fn()
    Object.assign(dialog, { showModal })
    const token = host.querySelector<HTMLElement>('[role="button"][aria-label="预览 [image.png]"]')!
    await act(() => token.click())
    await act(() => token.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(showModal).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalled()

    if (source === 'paste') {
      // 只有图片时也应发送，且新会话没有来自图片名的正文或标题。
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '[image.png]')
        area.dispatchEvent(new InputEvent('input', { bubbles: true }))
      })
    }
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
    const image = { type: 'image', url: 'data:image/png;base64,aW1hZ2UgY29udGVudA==' }
    // 占位保留在正文里，并追加附图编号，模型才能知道用户指的是哪张图。
    const body = '看 [image.png] 图 [其他.png]\n\n附图编号（按本条消息中图片的先后顺序）：\n1. [image.png]'
    expect(send).toHaveBeenCalledExactlyOnceWith(source === 'paste' ? '' : body, expect.objectContaining({
      input: source === 'paste' ? [image] : [{ type: 'text', text: body, text_elements: [] }, image],
    }))
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState(initialState, true)
    vi.unstubAllGlobals()
  }
})

it('用键盘预览并跳转到尚未渲染的早期轮次', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const position = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.dataset.turnAnchor === 'prompt-0' ? 160 : 0)
  })
  const initialState = useCodex.getState()
  const key = sessionKey('local', 'codex')
  const transport = new BackendCodexTransport('local')
  const rpc = new CodexRpc(transport)
  const items = Array.from({ length: 32 }, (_, index): ItemView[] => [
    { id: `prompt-${index}`, kind: 'user', text: `问题 ${index + 1}` },
    { id: `reply-${index}`, kind: 'agent', text: `回复 ${index + 1}`, streaming: false },
  ]).flat()
  useCodex.setState({
    currentTargetId: 'local',
    currentThreadId: 'history',
    currentAgent: 'codex',
    sessions: {
      [key]: {
        key, targetId: 'local', agent: 'codex', rpc, transport,
        state: { threads: { history: { id: 'history', status: 'idle', activeTurnId: null, items, pendingApprovals: [] } } },
        threadsAwaitingResume: new Set(), opened: false, openedConfig: null,
        opening: false, openError: null, openFailure: null, agentVersion: null, lastSeq: null,
      },
    },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)

  try {
    await act(() => root.render(
      <TooltipProvider>
        <ChatPanel onConnect={() => {}} onAddTarget={() => {}} />
      </TooltipProvider>,
    ))
    const rail = host.querySelector('nav[aria-label="会话轮次"]')!
    const markers = rail.querySelectorAll('button')
    expect(markers).toHaveLength(32)
    expect(markers[31]?.getAttribute('aria-current')).toBe('location')
    expect(host.querySelector('[data-turn-anchor="prompt-0"]')).toBeNull()

    await act(() => {
      markers[31]!.focus()
      markers[31]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(document.activeElement).toBe(markers[0])
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('问题 1回复 1')

    const scroll = host.querySelector('.qn-chat-selection')!
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000 })
    await act(() => markers[0]!.click())
    expect(host.querySelector('[data-turn-anchor="prompt-0"]')).toBeTruthy()
    expect(scroll.scrollTop).toBe(148)

    await act(() => useCodex.setState({ currentThreadId: null }))
    expect(host.querySelector('nav[aria-label="会话轮次"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState(initialState, true)
    rpc.dispose()
    transport.dispose()
    position.mockRestore()
    vi.unstubAllGlobals()
  }
})
