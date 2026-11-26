import { describe, expect, it } from 'vitest'
import { archivedThreadKey } from './agents'
import type { Project, Target } from './types'
import { closeTopSheet, filterProjects, groupWorkspaceThreads, recentThreadStatus, registerBackHandler, threadPreviewLine, visibleWorkspaceThreads, type WorkspaceThread } from './workspace'

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
  it('按项目名、主机、来源和路径搜索', () => {
    const projects = [laptop, remote]
    expect(filterProjects(projects, targets, ' ci.TEST ')).toEqual([remote])
    expect(filterProjects(projects, targets, '本机')).toEqual([laptop])
    expect(filterProjects(projects, targets, 'sandbox')).toEqual(projects)
    expect(filterProjects(projects, targets, '/srv')).toEqual([remote])
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
