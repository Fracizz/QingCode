import { expect, it, vi } from 'vitest'
import { useCodex } from './codex'
import { useProjects } from './projects'

const { save } = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../lib/backend', () => ({ call: save }))

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
