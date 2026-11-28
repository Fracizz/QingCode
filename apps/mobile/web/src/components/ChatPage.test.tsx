// @vitest-environment jsdom
import { CodexRpc, type ThreadView } from '@qn/codex-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { type AgentSession, useApp } from '../store'
import { clearToasts, useToasts } from '../toast'
import { MobileCodexTransport } from '../transport'
import { closeTopSheet } from '../workspace'
import { ChatPage } from './ChatPage'

it('输入斜杠后可触摸执行命令，命令文本不会作为消息发送', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useApp.getState()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const newThread = vi.fn().mockResolvedValue(true)
  const send = vi.fn()
  try {
    await act(() => {
      useApp.setState({ selectedTargetId: 'local', selectedAgent: 'pi', draftText: '', newThread, send,
        setDraftText: (draftText) => useApp.setState({ draftText }) })
      root.render(<ChatPage />)
    })
    const input = host.querySelector('textarea')!
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '/ne')
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    const option = host.querySelector<HTMLButtonElement>('[aria-label="对话命令"] button')
    expect(option?.textContent).toContain('/new')
    await act(() => option?.click())
    expect(newThread).toHaveBeenCalledExactlyOnceWith('pi')
    expect(send).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  } finally {
    await act(() => root.unmount())
    host.remove()
    useApp.setState(initial)
    vi.unstubAllGlobals()
  }
})

it('最终回复所在分页保留工作用时和回复时间，展开后显示完整工作步骤', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useApp.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const transport = new MobileCodexTransport('local', async () => undefined)
  const rpc = new CodexRpc(transport)
  const completedAtMs = new Date(2026, 10, 27, 15, 52).getTime()
  const thread: ThreadView = {
    id: 'timed', status: 'idle', activeTurnId: null, pendingApprovals: [],
    turns: [{ id: 'turn', outcome: 'completed', startedAtMs: completedAtMs - 544_000, durationMs: 544_000,
      itemIds: ['user', 'interim', 'thinking', 'command', 'file', 'reply'] }],
    items: [
      { kind: 'user', id: 'user', text: '开始' },
      { kind: 'agent', id: 'interim', text: '先梳理引用点', streaming: false },
      { kind: 'reasoning', id: 'thinking', summary: '检查文件', streaming: false },
      { kind: 'command', id: 'command', command: 'git status --short', output: '', status: 'completed', exitCode: 0 },
      { kind: 'fileChange', id: 'file', changes: [{ path: 'app.ts', kind: 'update' }], status: 'completed' },
      { kind: 'agent', id: 'reply', text: '检查完成', completedAtMs, streaming: false },
      // 让默认分页起点正好落在最终回复，验证用时摘要一起显示。
      ...Array.from({ length: 30 }, (_, index) => [
        { kind: 'user', id: `next-${index}`, text: `问题 ${index}` } as const,
        ...(index < 29 ? [{ kind: 'agent', id: `next-reply-${index}`, text: `后续记录 ${index}`, streaming: false } as const] : []),
      ]).flat(),
    ],
  }
  const session: AgentSession = {
    key: 'codex:local', agent: 'codex', targetId: 'local', rpc, transport,
    opened: true, opening: false, openError: null, lastSeq: null,
    resumedCodexThreads: new Set(), loadedThreads: new Set(), state: { threads: { timed: thread } },
  }
  try {
    await act(() => {
      useApp.setState({ selectedTargetId: 'local', selectedThreadId: thread.id, sessions: { [session.key]: session } })
      root.render(<ChatPage />)
    })
    const summary = host.querySelector('summary')!
    expect(summary.textContent).toContain('工作了 9m 4s')
    expect(summary.querySelector('time')?.dateTime).toBe(new Date(completedAtMs).toISOString())
    expect(host.querySelectorAll('time')).toHaveLength(1)
    expect(host.textContent!.indexOf('工作了 9m 4s')).toBeLessThan(host.textContent!.indexOf('检查完成'))
    expect(host.textContent).not.toContain('先梳理引用点')
    expect(host.textContent).not.toContain('已运行 1 条命令')
    await act(() => {
      const details = summary.closest('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    expect(host.textContent).toContain('先梳理引用点')
    expect(host.textContent).toContain('已运行 1 条命令')
    expect(host.textContent).toContain('改动 1 个文件')
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial)
    rpc.dispose()
    vi.unstubAllGlobals()
  }
})

it('长会话先显示最新消息，可以逐批查看完整历史', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useApp.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const transport = new MobileCodexTransport('local', async () => undefined)
  const rpc = new CodexRpc(transport)
  const thread: ThreadView = {
    id: 'long', status: 'idle', activeTurnId: null, pendingApprovals: [],
    items: Array.from({ length: 125 }, (_, i) => ({ kind: 'agent', id: String(i), text: `记录[${i}]`, streaming: false })),
  }
  const session: AgentSession = {
    key: 'codex:local', agent: 'codex', targetId: 'local', rpc, transport,
    opened: true, opening: false, openError: null, lastSeq: null,
    resumedCodexThreads: new Set(), loadedThreads: new Set(), state: { threads: { long: thread } },
  }
  const earlier = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '查看更早消息')
  try {
    await act(() => {
      useApp.setState({
        selectedTargetId: 'local', selectedThreadId: thread.id, eventsConnected: true,
        sessions: { [session.key]: session },
      })
      root.render(<ChatPage />)
    })
    expect(host.textContent).toContain('记录[124]')
    expect(host.querySelector('button[aria-label="访问模式：请求批准（跟随总控）"]')).not.toBeNull()
    expect(host.textContent).toContain('记录[65]')
    expect(host.textContent).not.toContain('记录[64]')
    await act(() => earlier()?.click())
    expect(host.textContent).toContain('记录[5]')
    expect(host.querySelector('[aria-label="回到最新"]')).toBeNull()
    expect(host.textContent).not.toContain('记录[4]')
    await act(() => earlier()?.click())
    expect(host.textContent).toContain('记录[0]')
    expect(earlier()).toBeUndefined()
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial)
    rpc.dispose()
    vi.unstubAllGlobals()
  }
})

it('中断请求失败可重试，确认中断后只显示一条状态，真正的轮次失败仍保留详情', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useApp.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const transport = new MobileCodexTransport('local', async () => undefined)
  const rpc = new CodexRpc(transport)
  const thread: ThreadView = {
    id: 'thread', status: 'running', activity: 'running', activeTurnId: 'turn', pendingApprovals: [],
    items: [
      { kind: 'user', id: 'message', text: '开始' },
      { kind: 'agent', id: 'reply', text: '已检查项目，继续处理', streaming: false },
      { kind: 'command', id: 'command', command: 'git status --short', output: '', status: 'completed', exitCode: 0 },
    ],
  }
  const session: AgentSession = {
    key: 'codex:local', agent: 'codex', targetId: 'local', rpc, transport,
    opened: true, opening: false, openError: null, lastSeq: null,
    resumedCodexThreads: new Set(), loadedThreads: new Set(), state: { threads: { thread } },
  }
  const interrupt = vi.fn<() => Promise<void>>()
  let rejectStop: (error: Error) => void
  interrupt.mockImplementation(() => new Promise((_, reject) => { rejectStop = reject }))

  function setTurn(view: ThreadView) {
    useApp.setState({ sessions: { [session.key]: { ...session, state: { threads: { thread: view } } } } })
  }

  function stopButton(label: string) {
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (!button) throw new Error(`缺少按钮 ${label}`)
    return button
  }

  try {
    await act(() => {
      useApp.setState({ selectedTargetId: 'local', selectedThreadId: 'thread', eventsConnected: true, interrupt })
      setTurn(thread)
      root.render(<ChatPage />)
    })
    const progress = () => host.querySelector('.qn-thinking[role="status"]')?.textContent
    expect(progress()).toContain('Codex 正在思考…')
    await act(() => setTurn({ ...thread, activity: 'input' }))
    expect(progress()).toContain('等待输入…')
    await act(() => setTurn(thread))
    await act(() => stopButton('停止运行').click())
    expect(stopButton('正在中断').disabled).toBe(true)
    await act(() => rejectStop(new Error('连接超时')))
    const toasts = () => useToasts.getState().items.map((item) => item.message).join(' | ')
    expect(toasts()).toContain('未能中断本轮。连接超时')
    clearToasts()

    await act(() => stopButton('停止运行').click())
    await act(() => setTurn({ ...thread, status: 'error', activity: 'interrupted', activeTurnId: null, error: 'Turn interrupted' }))
    await act(() => rejectStop(new Error('迟到的中断请求错误')))
    expect(progress()).toBeUndefined()
    expect(host.textContent?.match(/本轮已中断/g)).toHaveLength(1)
    expect(host.textContent).not.toMatch(/Turn interrupted|本轮失败|未能中断本轮/)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(toasts()).toBe('')

    await act(() => setTurn({ ...thread, status: 'error', activity: 'failed', activeTurnId: null, error: '503: upstream down',
      items: [...thread.items, { kind: 'user', id: 'next', text: '开始下一轮' }],
      turns: [{ id: 'turn', outcome: 'interrupted', startedAtMs: null, durationMs: null, itemIds: ['message', 'reply', 'command'] }],
    }))
    expect(host.textContent?.match(/本轮已中断/g)).toHaveLength(1)
    expect(host.textContent!.indexOf('本轮已中断')).toBeLessThan(host.textContent!.indexOf('开始下一轮'))
    const error = host.querySelector('[role="alert"]')?.textContent
    expect(error).toContain('模型服务暂时不可用（503）')
    expect(error).toContain('upstream down')
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial)
    rpc.dispose()
    vi.unstubAllGlobals()
  }
})

it('会话切换常驻顶栏，出现子代理时也可从顶栏查看记录和实时结果', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const methods = {
    showModal(this: HTMLDialogElement) { this.open = true },
    close(this: HTMLDialogElement) { this.open = false },
  }
  const original = Object.entries(methods).map(([name, method]) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)
    Object.defineProperty(HTMLDialogElement.prototype, name, { value: method, configurable: true })
    return { name, descriptor }
  })
  const initial = useApp.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const transport = new MobileCodexTransport('local', async () => undefined)
  const rpc = new CodexRpc(transport)
  const historyTurn = (id: string, status: string, messages: string[]) => ({
    id, status, items: messages.map((text, index) => ({ id: `${id}-${index}`, type: 'agentMessage', text })),
  })
  const latest = historyTurn('check', 'inProgress', [
    '本地窗口中的较早条目', ...Array.from({ length: 39 }, (_, index) => `检查记录[${index}]`), '已开始检查',
  ])
  let attempt = 0
  let finishEarlier!: (value: object) => void
  const request = vi.fn(async (method: string, params: { cursor?: string | null }) => {
    if (method === 'thread/read') return { thread: {
      id: 'child', agentNickname: 'Review', agentRole: 'reviewer', model: 'test-model',
      status: { type: 'active' }, turns: [],
    } }
    if (method !== 'thread/turns/list') return { data: [], nextCursor: null }
    if (params.cursor === 'before-check') {
      if (++attempt === 1) throw new Error('测试网络错误')
      return { data: [historyTurn('earlier', 'completed', ['服务器中的更早记录'])], nextCursor: 'before-earlier' }
    }
    if (params.cursor === 'before-earlier') {
      return new Promise<object>((resolve) => { finishEarlier = resolve })
    }
    return { data: [latest], nextCursor: 'before-check' }
  })
  const spy = vi.spyOn(rpc, 'request').mockImplementation(request as typeof rpc.request)
  const historyReads = () => spy.mock.calls.filter(([method]) => method === 'thread/read')
  const historyPages = () => spy.mock.calls.filter(([method]) => method === 'thread/turns/list')

  const parent: ThreadView = {
    id: 'parent', status: 'running', activeTurnId: 'main', pendingApprovals: [],
    items: [
      { kind: 'subagent', id: 'spawn', title: '启动子代理', detail: '检查模块边界', status: '调用已返回',
        agents: [{ threadId: 'child', label: '', status: '运行中', result: '' }] },
      { kind: 'subagent', id: 'event', title: '与子代理交互', detail: '', status: '已交互',
        agents: [{ threadId: 'child', label: '', status: '已交互', result: '' }] },
    ],
  }
  const child: ThreadView = {
    id: 'child', status: 'running', activeTurnId: 'check', pendingApprovals: [], items: [],
    subagent: { parentThreadId: 'parent', name: 'Review', role: 'reviewer', model: 'test-model', task: '' },
  }
  const session: AgentSession = {
    key: 'codex:local', agent: 'codex', targetId: 'local', rpc, transport,
    opened: true, opening: false, openError: null, lastSeq: null,
    resumedCodexThreads: new Set(), loadedThreads: new Set(), state: { threads: { parent, child } },
  }

  const dialog = () => host.querySelector('dialog[open]')
  const clickButton = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((node) =>
      node.getAttribute('aria-label') === label || node.textContent?.trim().startsWith(label))
    expect(button, label).toBeDefined()
    await act(() => button?.click())
  }

  try {
    await act(() => {
      useApp.setState({
        selectedTargetId: 'local', selectedThreadId: 'parent', eventsConnected: true,
        sessions: { [session.key]: { ...session, state: { threads: { parent: { ...parent, items: [] } } } } },
      })
      root.render(<ChatPage />)
    })
    const switcher = host.querySelector('header button[aria-label="切换会话"]')
    expect(switcher).not.toBeNull()
    expect(switcher?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('header button[aria-label="子代理"]')).toBeNull()
    expect(host.querySelector('.qn-composer button[aria-label="切换会话"]')).toBeNull()
    await clickButton('切换会话')
    expect(dialog()?.getAttribute('data-placement')).toBe('full')
    expect(switcher?.getAttribute('aria-expanded')).toBe('true')
    await act(() => { expect(closeTopSheet()).toBe(true) })
    expect(dialog()).toBeNull()
    expect(switcher?.getAttribute('aria-expanded')).toBe('false')

    await act(() => useApp.setState({ sessions: { [session.key]: session } }))
    const dockButton = '.qn-status-dock[data-state="open"] button[aria-label="子代理"]'
    expect(host.querySelector(`${dockButton} svg.lucide-bot`)).toBeTruthy()
    expect(host.querySelector('header button[aria-label="子代理"]')).toBeNull()
    expect(host.querySelector('header button[aria-label="返回"]')).toBeNull()
    expect(host.querySelector('.qn-body')?.textContent).not.toContain('启动子代理')
    expect(historyReads()).toHaveLength(0)
    await clickButton('子代理')
    expect(dialog()?.textContent).toContain('1 个子代理')
    expect(dialog()?.textContent).toContain('运行中')
    expect(historyReads()).toHaveLength(0)
    await clickButton('Review')
    expect(historyReads()).toEqual([['thread/read', { threadId: 'child', includeTurns: false }]])
    expect(historyPages()).toEqual([['thread/turns/list', {
      threadId: 'child', cursor: null, limit: 8, sortDirection: 'desc', itemsView: 'full',
    }]])
    expect(dialog()?.textContent).toContain('检查模块边界')
    expect(dialog()?.textContent).toContain('reviewer · test-model')
    expect(dialog()?.textContent).toContain('活动记录 · 2')
    expect(dialog()?.textContent).toContain('已开始检查')
    expect(dialog()?.textContent).not.toContain('本地窗口中的较早条目')

    await clickButton('查看更早记录')
    expect(dialog()?.textContent).toContain('本地窗口中的较早条目')
    expect(historyPages()).toHaveLength(1)
    await clickButton('查看更早记录')
    expect(dialog()?.textContent).toContain('测试网络错误')
    await clickButton('查看更早记录')
    expect(historyPages().at(-1)?.[1]).toMatchObject({ threadId: 'child', cursor: 'before-check' })
    expect(dialog()?.textContent).not.toContain('测试网络错误')
    expect(dialog()?.textContent).toContain('服务器中的更早记录')
    expect(dialog()?.textContent?.indexOf('服务器中的更早记录')).toBeLessThan(dialog()?.textContent?.indexOf('已开始检查') ?? -1)

    await clickButton('查看更早记录')
    expect(dialog()?.textContent).toContain('正在加载更早记录…')
    await clickButton('刷新记录')
    expect(historyPages().at(-1)?.[1]).toMatchObject({ threadId: 'child', cursor: null })
    await act(() => finishEarlier({ data: [historyTurn('stale', 'completed', ['刷新前的过期记录'])], nextCursor: null }))
    expect(dialog()?.textContent).not.toContain('刷新前的过期记录')
    expect(dialog()?.textContent).not.toContain('服务器中的更早记录')

    await act(() => useApp.setState({ sessions: { [session.key]: { ...session, state: { threads: {
      parent,
      child: { ...child, status: 'idle', activity: 'completed',
        items: [{ id: 'live', kind: 'agent', text: '实时检查完成', streaming: false }] },
    } } } } }))
    expect(dialog()?.textContent).toContain('实时检查完成')
    expect(dialog()?.textContent).toContain('已开始检查')
    await clickButton('返回子代理列表')
    expect(dialog()?.textContent).toContain('已完成')
    await act(() => useApp.setState({ selectedThreadId: 'other' }))
    expect(dialog()).toBeNull()
    expect(host.querySelector('.qn-status-dock')).toBeNull()
    expect(host.querySelector('header button[aria-label="切换会话"]')).toBe(switcher)
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial)
    rpc.dispose()
    for (const { name, descriptor } of original) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('已结束轮次的回复可以新建对话继续，进行中的回复不提供', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useApp.getState()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const transport = new MobileCodexTransport('local', async () => undefined)
  const rpc = new CodexRpc(transport)
  const forkConversation = vi.fn().mockResolvedValue(true)
  const thread: ThreadView = {
    id: 'forkable', status: 'running', activeTurnId: 'live', pendingApprovals: [],
    turns: [
      { id: 'done', outcome: 'completed', startedAtMs: null, durationMs: null, itemIds: ['ask', 'answer'] },
      { id: 'live', startedAtMs: null, durationMs: null, itemIds: ['ask-live', 'answer-live'] },
    ],
    items: [
      { kind: 'user', id: 'ask', text: '第一问' },
      { kind: 'agent', id: 'answer', text: '第一答', streaming: false },
      { kind: 'user', id: 'ask-live', text: '第二问' },
      { kind: 'agent', id: 'answer-live', text: '第二答', streaming: false },
    ],
  }
  const session: AgentSession = {
    key: 'codex:local', agent: 'codex', targetId: 'local', rpc, transport,
    opened: true, opening: false, openError: null, lastSeq: null,
    resumedCodexThreads: new Set(), loadedThreads: new Set(), state: { threads: { forkable: thread } },
  }
  const buttons = () => [...document.querySelectorAll('button')]
  const forkButton = () => buttons().find((button) => button.textContent === '新建对话继续')
  // jsdom 没有实现原生弹窗方法。
  const dialogMethods = Object.entries({
    showModal(this: HTMLDialogElement) { this.open = true },
    close(this: HTMLDialogElement) { this.open = false },
  }).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)
    Object.defineProperty(HTMLDialogElement.prototype, name, { value, configurable: true })
    return { name, descriptor }
  })
  try {
    await act(() => {
      useApp.setState({ selectedTargetId: 'local', selectedAgent: 'codex', selectedThreadId: thread.id,
        sessions: { [session.key]: session }, forkConversation })
      root.render(<ChatPage />)
    })
    const triggers = () => buttons().filter((button) => button.getAttribute('aria-label') === '消息操作')
    expect(triggers()).toHaveLength(2)
    await act(() => triggers()[1]!.click())
    expect(forkButton()).toBeUndefined()
    await act(() => { closeTopSheet() })
    await act(() => triggers()[0]!.click())
    await act(async () => forkButton()!.click())
    expect(forkConversation).toHaveBeenCalledExactlyOnceWith('done')
  } finally {
    await act(() => root.unmount())
    host.remove()
    clearToasts()
    useApp.setState(initial)
    rpc.dispose()
    vi.unstubAllGlobals()
    for (const { name, descriptor } of dialogMethods) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
    }
  }
})
