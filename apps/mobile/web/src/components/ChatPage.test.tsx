// @vitest-environment jsdom
import { CodexRpc, type ThreadView } from '@qn/codex-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { type AgentSession, useApp } from '../store'
import { MobileCodexTransport } from '../transport'
import { closeTopSheet } from '../workspace'
import { ChatPage } from './ChatPage'

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
    expect(host.querySelector('button[aria-label="访问模式：继承总控"]')).not.toBeNull()
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
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('未能中断本轮。连接超时')

    await act(() => stopButton('停止运行').click())
    await act(() => setTurn({ ...thread, status: 'error', activity: 'interrupted', activeTurnId: null, error: 'Turn interrupted' }))
    await act(() => rejectStop(new Error('迟到的中断请求错误')))
    expect(progress()).toBeUndefined()
    expect(host.textContent?.match(/本轮已中断/g)).toHaveLength(1)
    expect(host.textContent).not.toMatch(/Turn interrupted|本轮失败|未能中断本轮/)
    expect(host.querySelector('[role="alert"]')).toBeNull()

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

it('无子代理时隐藏顶栏，出现子代理时可从顶栏查看记录和实时结果', async () => {
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
    expect(host.querySelector('header.qn-header')).toBeNull()
    expect(host.querySelector('.qn-composer-tools > button:first-child')?.getAttribute('aria-label')).toBe('切换会话')
    await clickButton('切换会话')
    expect(dialog()?.getAttribute('data-placement')).toBe('left')
    await act(() => { expect(closeTopSheet()).toBe(true) })
    expect(dialog()).toBeNull()

    await act(() => useApp.setState({ sessions: { [session.key]: session } }))
    expect(host.querySelector('header button[aria-label="子代理"] svg.lucide-bot')).toBeTruthy()
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
    expect(host.querySelector('header.qn-header')).toBeNull()
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
