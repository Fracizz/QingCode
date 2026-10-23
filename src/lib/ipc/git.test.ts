import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitWorkdirStatus } from './git'

const safeInvoke = vi.fn()

vi.mock('../tauri', () => ({
  isSshResource: (value: unknown) => typeof value === 'string' && value.startsWith('ssh://'),
  safeInvoke: (...args: unknown[]) => safeInvoke(...args),
}))

describe('getGitWorkdirStatus', () => {
  beforeEach(() => {
    safeInvoke.mockReset()
  })

  it('carries the branch from the SSH status round-trip', async () => {
    safeInvoke.mockResolvedValue({
      is_repository: true,
      branch: 'test',
      changes: [
        { path: 'a.ts', status: ' M' },
        { path: 'b.ts', status: '??' },
      ],
    })

    const status = await getGitWorkdirStatus('ssh://c1/D:/code/app')

    expect(safeInvoke).toHaveBeenCalledWith('读取 Git 状态', 'git_status', {
      path: 'ssh://c1/D:/code/app',
    })
    expect(status).toEqual({
      branch: 'test',
      dirty_count: 2,
      entries: [
        { path: 'ssh://c1/D:/code/app/a.ts', status: ' M' },
        { path: 'ssh://c1/D:/code/app/b.ts', status: '??' },
      ],
    })
  })

  it('reports no snapshot for a non-repository SSH project', async () => {
    safeInvoke.mockResolvedValue({ is_repository: false, branch: null, changes: [] })
    await expect(getGitWorkdirStatus('ssh://c1/home/app')).resolves.toBeNull()
  })

  it('keeps using the local command for local projects', async () => {
    safeInvoke.mockResolvedValue({
      entries: [{ path: 'D:/repo/a.ts', status: ' M' }],
      dirty_count: 1,
    })
    const status = await getGitWorkdirStatus('D:/repo')
    expect(safeInvoke).toHaveBeenCalledWith('读取 Git 状态', 'get_git_workdir_status', {
      path: 'D:/repo',
    })
    expect(status?.branch).toBeUndefined()
  })
})
