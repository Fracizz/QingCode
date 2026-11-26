import { describe, expect, it, vi } from 'vitest'
import { archivedThreadKey } from './agents'
import { createGateway, setGateway } from './client'
import { MOCK_FP } from './mock'
import { useApp } from './store'
import type { Connection, Project, Target } from './types'
import { closeTopSheet, displayPath, filterProjects, groupWorkspaceThreads, isWorkspaceTabDoubleTap, recentThreadStatus, registerBackHandler, startWorkspaceObserver, threadPreviewLine, useWorkspace, visibleWorkspaceThreads, type WorkspaceThread } from './workspace'

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
