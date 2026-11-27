import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '../../../shared/backendApi'
import { useCodex } from './codex'
import { useProjects } from './projects'
import { useTargets } from './targets'

const { save } = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../lib/backend', () => ({ call: save }))

const project = (id: string, lastOpenedAt: number, targetId = 'local'): Project =>
  ({ id, targetId, path: `/${id}`, name: id, lastOpenedAt })
const projectIds = () => useProjects.getState().projects.map(({ id }) => id)

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  save.mockReset()
  useProjects.setState(useProjects.getInitialState())
})

afterEach(() => vi.unstubAllGlobals())

it('切换项目时立即更新会话上下文，迟到的保存不会取消已打开的会话', async () => {
  const project = { id: 'project', targetId: 'local', path: '/project', name: '项目', lastOpenedAt: 1 }
  let finishSave!: (value: typeof project) => void
  save.mockReturnValueOnce(new Promise<typeof project>((resolve) => { finishSave = resolve }))
  const refresh = vi.spyOn(useCodex.getState(), 'refreshThreads').mockResolvedValue()
  try {
    const selection = useProjects.getState().select(project)
    expect(useCodex.getState().currentCwd).toBe(project.path)
    useCodex.setState({ currentThreadId: 'history' })
    finishSave(project)
    await selection
    expect(useCodex.getState().currentThreadId).toBe('history')
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally {
    refresh.mockRestore()
  }
})

it('打开项目只更新时间，刷新后继续沿用原有顺序', async () => {
  const recent = project('recent', 2)
  const older = project('older', 1)
  const opened = { ...older, lastOpenedAt: 3 }
  save.mockResolvedValueOnce([recent, older]).mockResolvedValueOnce(opened).mockResolvedValueOnce([opened, recent])
  const { load, select } = useProjects.getState()
  const refresh = vi.spyOn(useCodex.getState(), 'refreshThreads').mockResolvedValue()
  try {
    await load('local')
    await select(older)
    expect(projectIds()).toEqual(['recent', 'older'])
    expect(useProjects.getState().projects[1]?.lastOpenedAt).toBe(3)
    await load('local')
    expect(projectIds()).toEqual(['recent', 'older'])
  } finally {
    refresh.mockRestore()
  }
})

it('上下拖动后的顺序跨重载保留，新项目追加到末尾', async () => {
  const a = project('a', 3)
  const b = project('b', 2)
  const c = project('c', 1)
  const added = project('added', 4)
  save.mockResolvedValueOnce([a, b, c]).mockResolvedValueOnce([added, a, c])
  const { load, move } = useProjects.getState()
  await load('local')
  move('a', 'c', 'after')
  expect(projectIds()).toEqual(['b', 'c', 'a'])
  move('c', 'b', 'before')
  expect(projectIds()).toEqual(['c', 'b', 'a'])
  move('c', 'missing', 'before')
  expect(projectIds()).toEqual(['c', 'b', 'a'])

  useProjects.setState(useProjects.getInitialState())
  await load('local')
  expect(projectIds()).toEqual(['c', 'a', 'added'])
})

it('置顶组和普通组各自保留排序，取消置顶后回到原来的顺序', async () => {
  save.mockResolvedValueOnce([project('a', 4), project('b', 3), project('c', 2), project('d', 1)])
  const { load, move, togglePin } = useProjects.getState()
  await load('local')
  togglePin('d')
  togglePin('b')
  expect(projectIds()).toEqual(['d', 'b', 'a', 'c'])

  move('d', 'b', 'after')
  move('c', 'a', 'before')
  move('c', 'b', 'before')
  expect(projectIds()).toEqual(['b', 'd', 'c', 'a'])
  expect(localStorage.getItem('qn.projects.pinned')).toBe('["b","d"]')

  togglePin('b')
  expect(projectIds()).toEqual(['d', 'c', 'b', 'a'])
})

it('切换目标时忽略旧列表响应，各目标的项目顺序独立', async () => {
  const local = [project('a', 2), project('b', 1)]
  const remote = [project('c', 2, 'remote'), project('d', 1, 'remote')]
  let finishLocal!: (projects: Project[]) => void
  save.mockReturnValueOnce(new Promise<Project[]>((resolve) => { finishLocal = resolve }))
    .mockResolvedValueOnce(remote).mockResolvedValueOnce(local).mockResolvedValueOnce(remote)
  const { load, move } = useProjects.getState()
  const pendingLocal = load('local')
  await load('remote')
  move('d', 'c', 'before')
  finishLocal(local)
  await pendingLocal
  expect(projectIds()).toEqual(['d', 'c'])
  await load('local')
  expect(projectIds()).toEqual(['a', 'b'])
  await load('remote')
  expect(projectIds()).toEqual(['d', 'c'])
})

it('重载后按目标恢复多个展开项目及当前项目', async () => {
  const local = project('a', 1)
  const localOther = project('c', 2)
  const remote = project('b', 1, 'remote')
  const { load, select, setExpanded } = useProjects.getState()
  const previousStates = useTargets.getState().states
  const setContext = vi.spyOn(useCodex.getState(), 'setContext')
  const refresh = vi.spyOn(useCodex.getState(), 'refreshThreads').mockResolvedValue()
  save.mockResolvedValueOnce([local, localOther]).mockResolvedValueOnce(local).mockResolvedValueOnce(localOther)
    .mockResolvedValueOnce([remote]).mockResolvedValueOnce(remote)
    .mockResolvedValueOnce([local, localOther]).mockResolvedValueOnce([remote])
  try {
    await load('local')
    await select(local)
    await select(localOther)
    expect(useProjects.getState().treeByTarget.get('local')?.expandedIds).toEqual(['a', 'c'])
    setExpanded(local, false)
    setExpanded(local, true)
    expect(useProjects.getState().selectedId).toBe(localOther.id)
    await load('remote')
    await select(remote)

    useProjects.setState(useProjects.getInitialState())
    useTargets.setState({ states: { local: { id: 'local', state: 'ready' } } })
    setContext.mockClear()
    await load('local')
    expect(useProjects.getState().selectedId).toBe(localOther.id)
    expect(useProjects.getState().treeByTarget.get('local')?.expandedIds).toEqual(['c', 'a'])
    expect(setContext).toHaveBeenLastCalledWith('local', localOther.path, true)

    await load('remote')
    expect(useProjects.getState().selectedId).toBe(remote.id)
    expect(useProjects.getState().treeByTarget.get('remote')?.expandedIds).toEqual(['b'])
    expect(setContext).toHaveBeenLastCalledWith('remote', remote.path, false)
    expect(save.mock.calls.filter(([method]) => method === 'projects.save')).toHaveLength(3)
  } finally {
    setContext.mockRestore()
    refresh.mockRestore()
    useTargets.setState({ states: previousStates })
  }
})

it.each([true, false])('恢复旧版项目展开记录（collapsed=%s）', async (collapsed) => {
  const local = project('a', 1)
  localStorage.setItem('qn.projects.tree.local', JSON.stringify({ projectId: local.id, collapsed }))
  save.mockResolvedValueOnce([local])
  await useProjects.getState().load('local')
  expect(useProjects.getState().selectedId).toBe(local.id)
  expect(useProjects.getState().treeByTarget.get('local')?.expandedIds).toEqual(collapsed ? [] : ['a'])
})

it('当前项目已删除时保留其他展开项目', async () => {
  const saved = { projectId: 'gone', expandedIds: ['gone', 'a'] }
  localStorage.setItem('qn.projects.tree.local', JSON.stringify(saved))
  save.mockResolvedValueOnce([project('a', 1)])
  await useProjects.getState().load('local')
  expect(useProjects.getState().selectedId).toBeNull()
  expect(useProjects.getState().treeByTarget.get('local')).toEqual({ projectId: null, expandedIds: ['a'] })
})

it('已删除的项目不会从上次展开状态恢复', async () => {
  localStorage.setItem('qn.projects.tree.local', JSON.stringify({ projectId: 'gone', collapsed: false }))
  save.mockResolvedValueOnce([project('available', 1)])
  await useProjects.getState().load('local')
  expect(useProjects.getState().selectedId).toBeNull()
  expect(localStorage.getItem('qn.projects.tree.local')).toBeNull()
})

it('每个项目独立保存显示全部或仅显示最近会话的偏好', async () => {
  const { setShowAllThreads } = useProjects.getState()
  setShowAllThreads('a', true)
  setShowAllThreads('b', true)
  setShowAllThreads('b', false)

  vi.resetModules()
  const { useProjects: reloaded } = await import('./projects')
  expect(reloaded.getState().fullThreadLists).toEqual(['a'])
})
