/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useGitStatusStore } from './gitStatusStore'
import type { GitStatus } from '@/lib/git/git'
import { getGitHead, getGitWorkdirStatus } from '@/lib/ipc/git'
import type { GitWorkdirStatus } from '@/lib/git/gitStatus'

vi.mock('@/lib/tauri', () => ({ isTauri: () => true }))
vi.mock('@/lib/ipc/git', () => ({
  getGitWorkdirStatus: vi.fn(),
  getGitHead: vi.fn(async () => null),
}))

const sample: GitStatus = {
  is_repository: true,
  branch: 'main',
  changes: [
    { path: 'a.ts', status: ' M' },
    { path: 'b.ts', status: '??' },
  ],
}

describe('gitStatusStore panel snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGitStatusStore.getState().clear()
  })

  it('stores and peeks status by project path', () => {
    useGitStatusStore.getState().setPanelStatus('D:\\repo', sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')).toEqual(sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\other')).toBeNull()
  })

  it('clearPanelStatus removes only matching path when specified', () => {
    useGitStatusStore.getState().setPanelStatus('D:\\repo', sample)
    useGitStatusStore.getState().clearPanelStatus('D:\\other')
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')).toEqual(sample)
    useGitStatusStore.getState().clearPanelStatus('D:\\repo')
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')).toBeNull()
  })

  it('applyFromGitStatus seeds badge and panel state without a second fetch', () => {
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', sample)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    expect(useGitStatusStore.getState().statusFor('D:\\repo\\a.ts')).toBe(' M')
    expect(useGitStatusStore.getState().panelStatus).toEqual(sample)
    expect(useGitStatusStore.getState().peekPanelStatus('D:\\repo')?.changes).toEqual([
      { path: 'a.ts', status: ' M' },
      { path: 'b.ts', status: '??' },
    ])
  })

  it('applyFromGitStatus notifies project-tab badges of the dirty count', () => {
    const seen: number[] = []
    const onCount = (event: Event) => {
      seen.push((event as CustomEvent<{ dirtyCount: number }>).detail.dirtyCount)
    }
    window.addEventListener('qingcode:git-dirty-count', onCount)
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', sample)
    useGitStatusStore.getState().applyFromGitStatus('D:\\repo', {
      ...sample,
      changes: [],
    })
    window.removeEventListener('qingcode:git-dirty-count', onCount)
    expect(seen).toEqual([2, 0])
  })

  it('dirtyCountFor ignores a snapshot that belongs to another project', () => {
    useGitStatusStore.getState().applyFromGitStatus('D:/repo', sample)
    expect(useGitStatusStore.getState().dirtyCountFor('D:/repo')).toBe(2)
    expect(useGitStatusStore.getState().dirtyCountFor('D:\\repo')).toBe(2)
    expect(useGitStatusStore.getState().dirtyCountFor('D:/other')).toBe(0)
    expect(useGitStatusStore.getState().dirtyCountFor(null)).toBe(0)
  })

  it('refresh drops the previous project count before the new snapshot lands', async () => {
    useGitStatusStore.getState().applyFromGitStatus('D:/alpha', sample)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)

    let release: (value: GitWorkdirStatus | null) => void = () => {}
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(
      new Promise<GitWorkdirStatus | null>(resolve => {
        release = resolve
      })
    )

    const pending = useGitStatusStore.getState().refresh('D:/beta')
    expect(useGitStatusStore.getState().projectPath).toBe('D:/beta')
    expect(useGitStatusStore.getState().dirtyCount).toBe(0)
    expect(useGitStatusStore.getState().dirtyCountFor('D:/beta')).toBe(0)

    release({ dirty_count: 1, entries: [{ path: 'D:/beta/x.ts', status: '??' }] })
    await pending
    expect(useGitStatusStore.getState().dirtyCount).toBe(1)
    expect(useGitStatusStore.getState().dirtyCountFor('D:/beta')).toBe(1)
  })

  it('reuses the branch that came back with the workdir snapshot', async () => {
    vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce({
      branch: 'test',
      dirty_count: 1,
      entries: [{ path: 'D:/repo/a.ts', status: ' M' }],
    })

    await useGitStatusStore.getState().refresh('D:/repo')

    expect(useGitStatusStore.getState().panelStatus?.branch).toBe('test')
    // 快照已带分支：不再为状态栏多跑一次全量 status。
    expect(vi.mocked(getGitHead)).not.toHaveBeenCalled()
  })
})
