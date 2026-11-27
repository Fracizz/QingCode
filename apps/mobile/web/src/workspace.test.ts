import { describe, expect, it, vi } from 'vitest'
import { archivedThreadKey } from './agents'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { useApp } from './store'
import type { Connection, Project, Target } from './types'
import { applyThreadOrder, threadAttentionTier, workspaceThreadOrder, changeThreadPreference, closeTopSheet, displayPath, filterProjects, groupWorkspaceThreads, isWorkspaceTabDoubleTap, moveWorkspaceProject, orderWorkspaceProjects, recentThreadStatus, registerBackHandler, startWorkspaceObserver, stickyGroupOrder, workspaceGroupKey, threadPreviewLine, useWorkspace, visibleWorkspaceThreads, type WorkspaceThread } from './workspace'

const laptop: Project = { id: 'laptop', targetId: 'local', name: 'sandbox', path: 'C:\\sandbox', lastOpenedAt: 1 }
const remote: Project = { id: 'remote', targetId: 'ssh', name: 'sandbox', path: '/srv/sandbox', lastOpenedAt: 0 }
const targets: Target[] = [
  { id: 'local', name: '本机', kind: 'local' },
  { id: 'ssh', name: 'CI', kind: 'ssh', host: 'ci.test', port: 22, username: 'runner', auth: { kind: 'agent' } },
]
const thread = (project: Project, patch: Partial<WorkspaceThread> = {}): WorkspaceThread => ({
  id: 'same-id',
  agent: 'codex',
  targetId: project.targetId,
  projectId: project.id,
  title: '定位构建问题',
  cwd: project.path,
  updatedAt: 1,
  preview: '',
  ...patch,
})

describe('移动工作台', () => {
  it.each(['sessions', 'projects', 'connections'] as const)('只识别连续双击同一标签 %s', (tab) => {
    expect(isWorkspaceTabDoubleTap(null, { tab, at: 100 })).toBe(false)
    expect(isWorkspaceTabDoubleTap({ tab, at: 100 }, { tab, at: 400 })).toBe(true)
    expect(isWorkspaceTabDoubleTap({ tab, at: 100 }, { tab, at: 500 })).toBe(false)
    const other = tab === 'sessions' ? 'projects' : 'sessions'
    expect(isWorkspaceTabDoubleTap({ tab: other, at: 100 }, { tab, at: 200 })).toBe(false)
  })

  it('按项目名、主机、来源和路径搜索', () => {
    const projects = [laptop, remote]
    expect(filterProjects(projects, targets, ' ci.TEST ')).toEqual([remote])
    expect(filterProjects(projects, targets, '本机')).toEqual([laptop])
    expect(filterProjects(projects, targets, 'sandbox')).toEqual(projects)
    expect(filterProjects(projects, targets, '/srv')).toEqual([remote])
  })

  it('默认显示所有连接的项目，指定连接后只搜索该连接下的项目', () => {
    const otherRemote = { ...remote, id: 'other', targetId: 'other-ssh' }
    const projects = [laptop, remote, otherRemote]
    expect(filterProjects(projects, targets, '')).toEqual(projects)
    expect(filterProjects(projects, targets, '', 'ssh')).toEqual([remote])
    expect(filterProjects(projects, targets, 'sandbox', 'local')).toEqual([laptop])
    expect(filterProjects(projects, targets, '本机', 'ssh')).toEqual([])
    expect(filterProjects(projects, targets, '', 'missing')).toEqual([])
  })

  it('按项目和目标分组，同名项目和同 id 会话互不覆盖', () => {
    const status = [thread(laptop), thread(remote, { updatedAt: 4 }), thread(remote, { agent: 'claude', updatedAt: 2 })]
    expect(groupWorkspaceThreads(status, [laptop, remote], '').map(({ project, threads }) => (
      [project.id, threads.map((item) => item.agent)]
    ))).toEqual([['remote', ['codex', 'claude']], ['laptop', ['codex']]])
    expect(groupWorkspaceThreads(status, [laptop, remote], 'Claude')[0]?.threads).toEqual([status[2]])
  })

  it('归档只隐藏当前电脑、目标和 Agent 的对应会话', () => {
    const archivedThread = thread(laptop)
    const otherThreads = [thread(remote), thread(laptop, { agent: 'claude' })]
    const all = [archivedThread, ...otherThreads]
    const archived = { [archivedThreadKey('desktop-a', laptop.targetId, archivedThread)]: true } as const
    expect(visibleWorkspaceThreads(all, 'desktop-a', archived)).toEqual(otherThreads)
    expect(visibleWorkspaceThreads(all, 'desktop-b', archived)).toEqual(all)
  })

  it('恢复手机上的会话置顶、本地别名和项目排序，并按电脑区分', async () => {
    const gateway = createGateway()
    const app = useApp.getState()
    const workspace = useWorkspace.getState()
    const desktopId = 'desktop-organization'
    const connection: Connection = { id: desktopId, name: '电脑', host: 'localhost', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0 }
    const older = thread(laptop, { agent: 'claude' })
    const newer = thread(laptop, { id: 'newer', updatedAt: 2 })
    const nextProject = { ...laptop, id: 'second' }
    setGateway(gateway)
    useApp.setState({ connections: [connection], activeId: desktopId })
    useWorkspace.setState({ preferences: {} })
    let stop = startWorkspaceObserver()
    try {
      changeThreadPreference(desktopId, older, { pinned: true, title: '本地别名' })
      moveWorkspaceProject(desktopId, nextProject, [laptop, nextProject], -1)
      await vi.waitFor(async () => expect(await gateway.storageGet('workspace.sessions')).toContain('本地别名'))
      stop()
      useWorkspace.setState({ preferences: {} })
      stop = startWorkspaceObserver()
      await vi.waitFor(() => expect(useWorkspace.getState().preferences[desktopId]).toBeDefined())
      const prefs = useWorkspace.getState().preferences[desktopId]
      expect(groupWorkspaceThreads([newer, older], [laptop], '', prefs)[0]?.threads.map(({ title }) => title))
        .toEqual(['本地别名', newer.title])
      expect(groupWorkspaceThreads([newer, older], [laptop], '本地别名', prefs)[0]?.threads).toHaveLength(1)
      expect(orderWorkspaceProjects([laptop, nextProject], prefs?.projectOrders.local)).toEqual([nextProject, laptop])
      expect(useWorkspace.getState().preferences['another-desktop']).toBeUndefined()
    } finally {
      stop()
      useApp.setState(app)
      useWorkspace.setState(workspace)
      setGateway(null)
    }
  })

  it('立即保存已读到的历史，重开后电脑离线也能按原项目分组', async () => {
    const gateway = createGateway()
    const app = useApp.getState()
    const workspace = useWorkspace.getState()
    const conn: Connection = {
      id: 'desktop-a', name: '电脑', host: '192.168.1.2', port: 38500,
      fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0,
    }
    const project = { ...laptop, name: '自定义项目名', lastOpenedAt: Date.UTC(2026, 10, 26) }
    const row = thread(project, { preview: '上一条消息', activity: 'running' })
    const savedRow = thread(project)
    // 旧版缓存中另一台电脑的历史可能比本次更新更晚读到。
    await gateway.storageSet('workspace.sessions', JSON.stringify({ 'desktop-b': [thread(remote)] }))
    setGateway(gateway)
    useApp.setState({
      connections: [conn], activeId: conn.id,
      selectedTargetId: project.targetId, selectedProjectId: project.id, projects: [project],
    })
    useWorkspace.setState({ threads: {}, projects: {} })
    vi.useFakeTimers()
    let stop = startWorkspaceObserver()
    try {
      const write = vi.spyOn(gateway, 'storageSet')
      useApp.setState({ threads: [row] })
      await vi.advanceTimersByTimeAsync(25)
      const payload = write.mock.calls.find(([key]) => key === 'workspace.sessions')?.[1]
      expect(JSON.parse(payload ?? '{}')).toEqual({
        'desktop-a': { projects: [project], threads: [savedRow] },
        'desktop-b': { projects: [remote], threads: [thread(remote)] },
      })
      stop()

      useWorkspace.setState({ threads: {}, projects: {} })
      vi.spyOn(gateway, 'rpc').mockRejectedValue(new Error('电脑离线'))
      stop = startWorkspaceObserver()
      await useWorkspace.getState().loadProjects(conn.id)
      await vi.advanceTimersByTimeAsync(10)
      const current = useWorkspace.getState()
      const projects = current.projects[conn.id]!
      expect(projects.error).toBe(true)
      expect(groupWorkspaceThreads(current.threads[conn.id]!, projects.items, '')).toEqual([
        { project, threads: [savedRow] },
      ])
      expect(current.threads['desktop-b']).toEqual([thread(remote)])
    } finally {
      stop()
      vi.useRealTimers()
      useApp.setState(app)
      useWorkspace.setState(workspace)
      setGateway(null)
    }
  })

  it('实时审批高于运行状态并覆盖列表中的旧状态', () => {
    const row = thread(laptop, { unread: true, activity: 'running' })
    expect(recentThreadStatus(row, { status: 'running', pendingApprovals: [{}] })).toBe('pending')
    expect(recentThreadStatus(row, { status: 'idle', pendingApprovals: [] })).toBe('unread')
    expect(recentThreadStatus(row)).toBe('running')
  })

  it('Android 返回键先关闭最上层弹层', () => {
    const order: number[] = []
    const first = registerBackHandler(() => order.push(1))
    const second = registerBackHandler(() => order.push(2))
    try {
      expect(closeTopSheet()).toBe(true)
      second()
      expect(closeTopSheet()).toBe(true)
      expect(order).toEqual([2, 1])
    } finally {
      first()
      second()
    }
    expect(closeTopSheet()).toBe(false)
  })
})

describe('会话分档排序', () => {
  it('待处理 > 未读结果 > 运行中 > 其余，看过的结果不压过运行中', () => {
    expect(threadAttentionTier('pending')).toBe(0)
    expect(threadAttentionTier('input')).toBe(0)
    expect(threadAttentionTier('unread')).toBe(1)
    expect(threadAttentionTier('failed', true)).toBe(1)
    expect(threadAttentionTier('running', true)).toBe(2)
    expect(threadAttentionTier('completed')).toBe(3)
  })

  it('分组按最需要关注的会话排序，档内按时间，置顶仍在组内最前', () => {
    const rows = [
      thread(laptop, { id: 'new-idle', updatedAt: 9 }),
      thread(laptop, { id: 'old-running', updatedAt: 1, activity: 'running' }),
      thread(remote, { id: 'remote-input', updatedAt: 2 }),
      thread(remote, { id: 'remote-done', updatedAt: 3, activity: 'completed', unread: true }),
    ]
    const status = (item: WorkspaceThread) => item.id === 'remote-input' ? 'input' as const : recentThreadStatus(item)
    const groups = groupWorkspaceThreads(rows, [laptop, remote], '', undefined, status)
    expect(groups.map((group) => group.threads.map((item) => item.id))).toEqual([
      ['remote-input', 'remote-done'],
      ['old-running', 'new-idle'],
    ])
  })

  it('稳定顺序：沿用旧顺序重排分组，新会话排在最前', () => {
    const a = thread(laptop, { id: 'a' })
    const b = thread(laptop, { id: 'b' })
    const c = thread(remote, { id: 'c' })
    const fresh = [{ project: remote, threads: [c] }, { project: laptop, threads: [b, a] }]
    const settled = workspaceThreadOrder([{ project: laptop, threads: [a, b] }])
    expect(applyThreadOrder(fresh, settled).map((group) => group.threads.map((item) => item.id))).toEqual([['c'], ['a', 'b']])
    expect(applyThreadOrder(fresh, [])).toBe(fresh)
  })

  it('项目分组位置固定：已有项目不随会话状态重排，新项目插到最前', () => {
    const a = thread(laptop, { id: 'a' })
    const c = thread(remote, { id: 'c' })
    const before = [{ project: laptop, threads: [a] }, { project: remote, threads: [c] }]
    const fixed = stickyGroupOrder(before.map(workspaceGroupKey), [])
    // remote 的会话变成待审批后排到了最前，但分组位置不变。
    const fresh = [{ project: remote, threads: [c] }, { project: laptop, threads: [a] }]
    const next = stickyGroupOrder(fresh.map(workspaceGroupKey), fixed)
    expect(next).toEqual(fixed)
    expect(applyThreadOrder(fresh, [], next).map((group) => group.project.id)).toEqual([laptop.id, remote.id])
    expect(stickyGroupOrder(['x', ...fixed], fixed)).toEqual(['x', ...fixed])
    // 被搜索暂时过滤掉的项目保留原位。
    expect(stickyGroupOrder([fixed[1]!], fixed)).toEqual(fixed)
  })
})

describe('threadPreviewLine', () => {
  it('预览与标题相同或只是标题的延续时不重复显示', () => {
    expect(threadPreviewLine('额度不用两地方都显示', '额度不用两地方都显示')).toBe('')
    expect(threadPreviewLine('梳理前端组件 封装...', '梳理前端组件  封装 方便统一维护')).toBe('')
    expect(threadPreviewLine('确认子智能体适配状态', '适配子智能体了吗')).toBe('适配子智能体了吗')
    expect(threadPreviewLine('标题', '  ')).toBe('')
  })
})

describe('displayPath', () => {
  it('Windows 路径去掉前导斜杠并换成反斜杠，其余原样', () => {
    expect(displayPath('/D:/code/qingcode-next')).toBe('D:\\code\\qingcode-next')
    expect(displayPath('d:/x')).toBe('D:\\x')
    expect(displayPath('/D:')).toBe('D:\\')
    expect(displayPath('/home/code/QingCode')).toBe('/home/code/QingCode')
  })
})

describe('最近会话的新结果标记', () => {
  const conn: Connection = {
    id: 'desktop-unread', name: '电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0,
  }
  const session = (threads: Record<string, unknown>) =>
    ({ 'codex:local': { state: { threads } } }) as unknown as ReturnType<typeof useApp.getState>['sessions']
  const view = (activity: string) => ({ id: 'same-id', status: 'idle', activeTurnId: null, items: [], pendingApprovals: [], activity })

  async function observe(cached: WorkspaceThread, run: () => void): Promise<WorkspaceThread | undefined> {
    const gateway = createGateway()
    const app = useApp.getState()
    const workspace = useWorkspace.getState()
    setGateway(gateway)
    useApp.setState({
      connections: [conn], activeId: conn.id, page: 'workspace', sessions: session({}),
      selectedTargetId: null, selectedProjectId: null, selectedThreadId: null, threads: [], archivedThreads: {},
    })
    useWorkspace.setState({ threads: { [conn.id]: [cached] }, projects: {} })
    const stop = startWorkspaceObserver()
    try {
      run()
      return useWorkspace.getState().threads[conn.id]?.[0]
    } finally {
      stop()
      useApp.setState(app)
      useWorkspace.setState(workspace)
      setGateway(null)
    }
  }

  it('首次读入的历史会话不算新结果，也不改动更新时间', async () => {
    const result = await observe(thread(laptop, { activity: 'idle', updatedAt: 5 }), () => {
      // 打开会话时先写入历史，再切到对话页；中间这一步不能被当成"刚完成"。
      useApp.setState({ sessions: session({ 'same-id': view('completed') }) })
      useApp.setState({ page: 'chat', selectedTargetId: 'local', selectedThreadId: 'same-id', selectedAgent: 'codex' })
    })
    expect(result).toMatchObject({ updatedAt: 5 })
    expect(result?.unread).toBeFalsy()
  })

  it('点开会话不改变排序：电脑列表以服务器时间为准，清除未读不抬高时间', async () => {
    // 旧缓存里的时间曾被「恢复会话刷新 updatedAt」抬高到 9，电脑列表给出的排序时间是 5。
    const result = await observe(thread(laptop, { updatedAt: 9, unread: true }), () => {
      const { targetId: _target, projectId: _project, ...summary } = thread(laptop, { updatedAt: 5 })
      useApp.setState({ selectedTargetId: 'local', selectedProjectId: laptop.id, threads: [summary] })
      useApp.setState({ page: 'chat', selectedThreadId: 'same-id', selectedAgent: 'codex' })
    })
    expect(result).toMatchObject({ updatedAt: 5, unread: false })
  })

  it('运行中的会话在后台结束时标记为有新结果', async () => {
    const running = await observe(thread(laptop, { activity: 'idle', updatedAt: 5 }), () => {
      useApp.setState({ sessions: session({ 'same-id': view('running') }) })
      useApp.setState({ sessions: session({ 'same-id': view('completed') }) })
    })
    expect(running).toMatchObject({ unread: true, activity: 'completed' })
    // 列表里还是运行中、读入时已经结束，同样是用户还没看过的结果。
    const listed = await observe(thread(laptop, { activity: 'running', updatedAt: 5 }), () => {
      useApp.setState({ sessions: session({ 'same-id': view('failed') }) })
    })
    expect(listed).toMatchObject({ unread: true, activity: 'failed' })
  })
})

it('重新配对换了证书指纹后丢弃该电脑的会话缓存，只改地址时保留', async () => {
  const gateway = createGateway()
  const app = useApp.getState()
  const workspace = useWorkspace.getState()
  const conn: Connection = {
    id: 'desktop-repair', name: '电脑', host: '192.168.1.2', port: 38500,
    fp: MOCK_FP, token: 'mock-token', desktopName: '电脑', createdAt: 0,
  }
  setGateway(gateway)
  useApp.setState({ connections: [conn], activeId: null })
  useWorkspace.setState({ threads: { [conn.id]: [thread(laptop)] }, projects: { [conn.id]: { items: [laptop], loading: false, error: false, loaded: true } } })
  const stop = startWorkspaceObserver()
  try {
    useApp.setState({ connections: [{ ...conn, host: 'frp.example.com' }] })
    expect(useWorkspace.getState().threads[conn.id]).toHaveLength(1)
    useApp.setState({ connections: [{ ...conn, fp: 'ef'.repeat(32), token: 'new-token' }] })
    expect(useWorkspace.getState().threads[conn.id]).toBeUndefined()
    expect(useWorkspace.getState().projects[conn.id]).toBeUndefined()
  } finally {
    stop()
    useApp.setState(app)
    useWorkspace.setState(workspace)
    setGateway(null)
  }
})
