// @vitest-environment jsdom
import { CodexRpc, type ThreadView } from '@qn/codex-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { type AgentSession, useApp } from '../store'
import { MobileCodexTransport } from '../transport'
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
    expect(host.textContent).toContain('记录[65]')
    expect(host.textContent).not.toContain('记录[64]')
    await act(() => earlier()?.click())
    expect(host.textContent).toContain('记录[5]')
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
    expect(progress()).toContain('Codex 正在处理…')
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

    await act(() => setTurn({ ...thread, status: 'error', activity: 'failed', activeTurnId: null, error: '503: upstream down' }))
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
