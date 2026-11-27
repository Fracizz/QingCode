// @vitest-environment jsdom
import { act, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { applyNotification, CodexRpc } from '@qn/codex-client'
import { LOCAL_TARGET, type Project, type SshTarget } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { BackendCodexTransport } from '../../lib/codexTransport'
import type { ThreadSummary } from '../../lib/threads'
import { useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { TooltipProvider } from '../primitives'
import { Sidebar } from './Sidebar'

it('用铃铛临时提前活动会话、项目和目标，再点恢复工作区顺序', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalTargets = useTargets.getState()
  const originalProjects = useProjects.getState()
  const originalCodex = useCodex.getState()
  const remote: SshTarget = {
    id: 'remote', kind: 'ssh', name: '远端', host: 'example', port: 22, username: 'user', auth: { kind: 'agent' },
  }
  const quiet: Project = { id: 'quiet', targetId: remote.id, name: '空闲项目', path: '/quiet', lastOpenedAt: 0 }
  const busy: Project = { id: 'busy', targetId: remote.id, name: '活动项目', path: '/busy', lastOpenedAt: 0 }
  const projectList = { projects: [quiet, busy], loading: false, error: null }
  const threads: ThreadSummary[] = Array.from({ length: 9 }, (_, index) => ({
    id: String(index), title: `会话 ${index}`, preview: '', agent: 'codex', cwd: busy.path, updatedAt: 9 - index,
    activity: index === 8 ? 'pending' : 'idle',
  }))
  const key = JSON.stringify([remote.id, busy.path])
  const list = { targetId: remote.id, cwd: busy.path, threads, loading: false, error: null }
  useTargets.setState({
    targets: [LOCAL_TARGET, remote], sidebarIds: [remote.id], selectedId: LOCAL_TARGET.id, loaded: true,
    states: { [remote.id]: { id: remote.id, state: 'ready' } },
  })
  useProjects.setState({
    byTarget: { [remote.id]: projectList },
    treeByTarget: new Map([[remote.id, { projectId: null, expandedIds: [busy.id] }]]),
    load: vi.fn(async () => undefined),
  })
  const agentKey = sessionKey(remote.id, 'codex')
  const transport = new BackendCodexTransport(remote.id)
  const rpc = new CodexRpc(transport)
  useCodex.setState({
    threadLists: { [key]: list }, refreshThreads: vi.fn(async () => undefined),
    sessions: { [agentKey]: {
      key: agentKey, targetId: remote.id, agent: 'codex', transport, rpc,
      state: { threads: { '8': {
        id: '8', activity: 'pending', status: 'running', activeTurnId: 'turn', pendingApprovals: [],
        items: [{ id: 'reply', kind: 'agent', text: '', streaming: true }],
      } } },
      threadsAwaitingResume: new Set(), opened: false, openedConfig: null,
      opening: false, openError: null, openFailure: null, agentVersion: null, lastSeq: null,
    } },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const noop = () => {}
  const render = vi.fn()
  const append = () => act(() => useCodex.setState((state) => {
    const session = state.sessions[agentKey]!
    const next = applyNotification(session.state, {
      method: 'item/agentMessage/delta', params: { threadId: '8', turnId: 'turn', itemId: 'reply', delta: '正文增量' },
    })
    return { sessions: { ...state.sessions, [agentKey]: { ...session, state: next } } }
  }))

  try {
    await act(() => root.render(
      <TooltipProvider>
        <Profiler id="sidebar" onRender={render}>
          <Sidebar onImport={noop} onMobile={noop} onSettings={noop}
            onAdd={noop} onEdit={noop} onSelect={noop} onConnect={noop} onDisconnect={noop} onForgetSecret={noop} />
        </Profiler>
      </TooltipProvider>,
    ))
    const bell = host.querySelector<HTMLButtonElement>('button[aria-label="查看活动会话"]')!
    const targets = () => Array.from(host.querySelectorAll('section[aria-label]'), (section) => section.getAttribute('aria-label'))
    const projects = () => Array.from(host.querySelectorAll('.qn-project-tree [title$="项目"]'), (project) => project.textContent)
    const firstThread = () => host.querySelector('[aria-label="活动项目会话列表"] button')?.textContent
    expect(bell.getAttribute('aria-pressed')).toBe('false')
    expect(targets()).toEqual(['本机', '远端'])
    expect(projects()).toEqual(['空闲项目', '活动项目'])
    expect(firstThread()).toBe('会话 0')
    expect(host.textContent).not.toContain('会话 8')
    render.mockClear()
    await append()
    expect(render).not.toHaveBeenCalled()

    await act(() => bell.click())
    expect(bell.getAttribute('aria-pressed')).toBe('true')
    expect(targets()).toEqual(['远端', '本机'])
    expect(projects()).toEqual(['活动项目', '空闲项目'])
    expect(firstThread()).toBe('会话 8')
    expect(useProjects.getState().byTarget[remote.id]).toBe(projectList)
    render.mockClear()
    await append()
    expect(useCodex.getState().sessions[agentKey]?.state.threads['8']?.items[0]).toMatchObject({ text: '正文增量正文增量' })
    expect(render).not.toHaveBeenCalled()

    await act(() => useCodex.setState((state) => {
      const session = state.sessions[agentKey]!
      const next = applyNotification(session.state, {
        method: 'thread/status/changed', params: { threadId: '8', status: { type: 'active', activeFlags: [] } },
      })
      return { sessions: { ...state.sessions, [agentKey]: { ...session, state: next } } }
    }))
    expect(host.querySelector('[aria-label="活动项目会话列表"] [role="img"][aria-label="运行中"]')).toBeTruthy()
    expect(firstThread()).toBe('会话 8')

    await act(() => bell.click())
    expect(bell.getAttribute('aria-pressed')).toBe('false')
    expect(targets()).toEqual(['本机', '远端'])
    expect(projects()).toEqual(['空闲项目', '活动项目'])
    expect(firstThread()).toBe('会话 0')

    await act(() => bell.click())
    await act(() => useCodex.setState({
      sessions: {},
      threadLists: { [key]: { ...list, threads: threads.map((thread) => ({ ...thread, activity: 'completed' })) } },
    }))
    expect(bell.getAttribute('aria-pressed')).toBe('true')
    expect(targets()).toEqual(['本机', '远端'])
    expect(firstThread()).toBe('会话 0')
  } finally {
    await act(() => root.unmount())
    host.remove()
    rpc.dispose()
    transport.dispose()
    useTargets.setState(originalTargets, true)
    useProjects.setState(originalProjects, true)
    useCodex.setState(originalCodex, true)
    vi.unstubAllGlobals()
  }
})
