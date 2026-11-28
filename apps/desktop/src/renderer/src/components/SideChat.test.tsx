// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CodexRpc } from '@qn/codex-client'
import { sessionKey } from '../lib/agents'
import { BackendCodexTransport } from '../lib/codexTransport'
import { pendingSendKey, useCodex } from '../store/codex'
import { TooltipProvider } from './primitives'
import { SideChat } from './SideChat'

it('侧聊运行时可点结束，有排队消息时先确认', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useCodex.getState()
  const chat = { targetId: 'local', agent: 'codex', threadId: 'side' } as const
  const key = sessionKey(chat.targetId, chat.agent)
  const transport = new BackendCodexTransport(chat.targetId, chat.agent)
  const rpc = new CodexRpc(transport)
  const endSideChat = vi.fn(async () => {})
  useCodex.setState({
    currentTargetId: chat.targetId, currentAgent: chat.agent, currentThreadId: 'parent', currentCwd: '/work',
    sessions: { [key]: {
      key, targetId: chat.targetId, agent: chat.agent, rpc, transport,
      state: { threads: { side: { id: 'side', status: 'running', activeTurnId: 'turn', items: [], pendingApprovals: [] } } },
      threadsAwaitingResume: new Set(), opened: true, openedConfig: null, opening: false,
      openError: null, openFailure: null, agentVersion: null, lastSeq: null,
    } },
    pendingSends: { [pendingSendKey(chat)]: [{ id: 1, text: '排队消息', overrides: {}, input: [] }] },
    endSideChat,
  })
  useCodex.getState().openSideChat()
  const state = useCodex.getState()
  const [sideKey, side] = Object.entries(state.sideChats)[0]!
  useCodex.setState({ sideChats: { [sideKey]: { ...side, threadId: chat.threadId } } })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const dialogButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
    .find((button) => button.textContent === label)!
  try {
    await act(() => root.render(<TooltipProvider><SideChat /></TooltipProvider>))
    const end = host.querySelector<HTMLButtonElement>('button[aria-label="结束侧边对话"]')!
    expect(end.disabled).toBe(false)
    await act(() => end.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('当前回复会停止，未发送的内容会被丢弃。')
    await act(() => dialogButton('取消').click())
    expect(endSideChat).not.toHaveBeenCalled()
    await act(() => end.click())
    await act(() => dialogButton('结束对话').click())
    expect(endSideChat).toHaveBeenCalledExactlyOnceWith(true)
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState(initial, true)
    rpc.dispose()
    transport.dispose()
    vi.unstubAllGlobals()
  }
})

it('持久分支侧聊折叠工作过程，队列优先于下一条建议', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useCodex.getState()
  const chat = { targetId: 'local', agent: 'claude', threadId: 'branch' } as const
  const key = sessionKey(chat.targetId, chat.agent)
  const transport = new BackendCodexTransport(chat.targetId, chat.agent)
  const rpc = new CodexRpc(transport)
  useCodex.setState({
    currentTargetId: chat.targetId, currentAgent: chat.agent, currentThreadId: 'parent', currentCwd: '/work',
    sessions: { [key]: {
      key, targetId: chat.targetId, agent: chat.agent, rpc, transport,
      state: { threads: { branch: {
        id: 'branch', status: 'idle', activeTurnId: null, pendingApprovals: [],
        turns: [{ id: 'turn', itemIds: ['command', 'reply'], outcome: 'completed', startedAtMs: null, durationMs: null }],
        items: [
          { kind: 'command', id: 'command', command: 'node --version', output: 'v22', status: 'completed' },
          { kind: 'agent', id: 'reply', text: '已检查版本。', streaming: false },
        ],
        promptSuggestion: { turnId: 'turn', text: '继续检查配置' },
      } } },
      threadsAwaitingResume: new Set(), opened: true, openedConfig: null, opening: false,
      openError: null, openFailure: null, agentVersion: null, lastSeq: null,
    } },
    pendingSends: { [pendingSendKey(chat)]: [{ id: 1, text: '排队消息', overrides: {}, input: [] }] },
  })
  useCodex.getState().openSideChat()
  const [sideKey, side] = Object.entries(useCodex.getState().sideChats)[0]!
  useCodex.setState({ sideChats: { [sideKey]: { ...side, threadId: chat.threadId, forked: true } } })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(() => root.render(<TooltipProvider><SideChat /></TooltipProvider>))
    expect(host.querySelector('summary')?.textContent).toBe('工作过程')
    expect(host.textContent).not.toContain('node --version')
    expect(host.textContent).not.toContain('继续检查配置')
    await act(() => useCodex.setState({ pendingSends: {} }))
    expect(host.textContent).toContain('继续检查配置')
  } finally {
    await act(() => root.unmount())
    host.remove()
    useCodex.setState(initial, true)
    rpc.dispose()
    transport.dispose()
    vi.unstubAllGlobals()
  }
})
