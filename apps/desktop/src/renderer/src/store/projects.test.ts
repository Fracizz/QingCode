import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '../../../shared/backendApi'
import { useCodex } from './codex'
import { projectListOf, useProjects } from './projects'

const { save } = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../lib/backend', () => ({ call: save }))

const project = (id: string, lastOpenedAt: number, targetId = 'local'): Project =>
  ({ id, targetId, path: `/${id}`, name: id, lastOpenedAt })
const projectIds = (targetId = 'local') => projectListOf(useProjects.getState(), targetId).projects.map(({ id }) => id)

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
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

it('多个目标的项目列表分别缓存，活动目标镜像跟随切换', async () => {
  const a = { id: 'a1', targetId: 'ta', path: '/a', name: 'A', lastOpenedAt: 1 }
  const b = { id: 'b1', targetId: 'tb', path: '/b', name: 'B', lastOpenedAt: 1 }
  save.mockResolvedValueOnce([a]).mockResolvedValueOnce([b])
  await useProjects.getState().load('ta')
  await useProjects.getState().load('tb')
  expect(useProjects.getState().byTarget.ta?.projects).toEqual([a])
  expect(useProjects.getState().byTarget.tb?.projects).toEqual([b])

  useProjects.getState().setActiveTarget('tb')
  expect(useProjects.getState().projects).toEqual([b])
  useProjects.getState().setActiveTarget('ta')
  expect(useProjects.getState().projects).toEqual([a])
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
    expect(projectListOf(useProjects.getState(), 'local').projects[1]?.lastOpenedAt).toBe(3)
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

it('迟到的旧列表响应不覆盖其他目标，各目标的项目顺序独立', async () => {
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
  expect(projectIds('remote')).toEqual(['d', 'c'])
  expect(projectIds('local')).toEqual(['a', 'b'])
  await load('local')
  expect(projectIds('local')).toEqual(['a', 'b'])
  await load('remote')
  expect(projectIds('remote')).toEqual(['d', 'c'])
})
