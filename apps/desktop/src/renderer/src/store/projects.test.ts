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
