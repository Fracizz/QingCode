/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { useGitStatusStore } from './gitStatusStore'
import type { GitStatus } from '@/lib/git/git'
import { getGitHead, getGitStatus, getGitWorkdirStatus } from '@/lib/ipc/git'
import type { GitWorkdirStatus } from '@/lib/git/gitStatus'

vi.mock('@/lib/tauri', () => ({ isTauri: () => true }))
vi.mock('@/lib/ipc/git', () => ({
  getGitWorkdirStatus: vi.fn(),
  getGitStatus: vi.fn(),
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
    vi.resetAllMocks()
    vi.mocked(getGitHead).mockResolvedValue(null)
    useGitStatusStore.getState().clear()
  })

  afterEach(() => {
    useGitStatusStore.getState().clear()
    vi.useRealTimers()
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

  it('coalesces refreshes during a read into a single trailing read', async () => {
    let release: (value: GitWorkdirStatus | null) => void = () => {}
    vi.mocked(getGitWorkdirStatus)
      .mockReturnValueOnce(
        new Promise<GitWorkdirStatus | null>(resolve => {
          release = resolve
        })
      )
      // 补读看到的是读取期间新增的改动（例如刚保存的文件）。
      .mockResolvedValueOnce({
        dirty_count: 2,
        entries: [
          { path: 'D:/repo/a.ts', status: ' M' },
          { path: 'D:/repo/b.ts', status: ' M' },
        ],
      })

    const counts: number[] = []
    const unsubscribe = useGitStatusStore.subscribe((state, previous) => {
      if (state.dirtyCount !== previous.dirtyCount) counts.push(state.dirtyCount)
    })
    const first = useGitStatusStore.getState().refresh('D:/repo')
    const second = useGitStatusStore.getState().refresh('D:/repo')
    const third = useGitStatusStore.getState().refresh('D:/repo')
    expect(vi.mocked(getGitWorkdirStatus)).toHaveBeenCalledTimes(1)

    release({ dirty_count: 1, entries: [{ path: 'D:/repo/a.ts', status: ' M' }] })
    await Promise.all([first, second, third])

    // 读取期间的两次调用只补读一次，并且不丢掉补读的结果。
    expect(vi.mocked(getGitWorkdirStatus)).toHaveBeenCalledTimes(2)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    unsubscribe()
    expect(counts).toEqual([2])
  })

  it('does not re-read when nothing asked for a refresh during the read', async () => {
    vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce({ dirty_count: 0, entries: [] })
    await useGitStatusStore.getState().refresh('D:/repo')
    expect(vi.mocked(getGitWorkdirStatus)).toHaveBeenCalledTimes(1)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(release => {
    resolve = release
  })
  return { promise, resolve }
}

describe('per-project Git refresh ordering', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getGitHead).mockResolvedValue(null)
    useGitStatusStore.getState().clear()
  })
  afterEach(() => {
    useGitStatusStore.getState().clear()
    vi.useRealTimers()
  })

  it('keeps a background snapshot visible while activating and refreshing its project', async () => {
    useGitStatusStore.getState().applyFromGitStatus('D:/alpha', { ...sample, changes: [] })
    vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce({
      dirty_count: 2,
      branch: 'main',
      entries: [
        { path: 'D:/beta/a.ts', status: ' M' },
        { path: 'D:/beta/b.ts', status: '??' },
      ],
    })
    await useGitStatusStore.getState().refresh('D:/beta', { background: true })
    expect(useGitStatusStore.getState().projectPath).toBe('D:/alpha')
    expect(useGitStatusStore.getState().dirtyCount).toBe(0)
    expect(useGitStatusStore.getState().dirtyCountFor('D:/beta')).toBe(2)

    const read = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(read.promise)
    const pending = useGitStatusStore.getState().refresh('D:\\beta')
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    expect(useGitStatusStore.getState().peekPanelStatus('D:/beta')?.changes).toHaveLength(2)
    read.resolve({ dirty_count: 0, branch: 'main', entries: [] })
    await pending
    expect(useGitStatusStore.getState().dirtyCount).toBe(0)
  })

  it('shares reads across A → B → A without allowing B to replace A', async () => {
    const a = deferred<GitWorkdirStatus | null>()
    const b = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const first = useGitStatusStore.getState().refresh('D:/alpha', { reuseInFlight: true })
    const second = useGitStatusStore.getState().refresh('D:/beta', { reuseInFlight: true })
    const third = useGitStatusStore.getState().refresh('D:/alpha', { reuseInFlight: true })
    a.resolve({
      dirty_count: 1,
      branch: 'alpha',
      entries: [{ path: 'D:/alpha/a.ts', status: ' M' }],
    })
    await Promise.all([first, third])
    b.resolve({ dirty_count: 0, branch: 'beta', entries: [] })
    await second
    expect(getGitWorkdirStatus).toHaveBeenCalledTimes(2)
    expect(useGitStatusStore.getState().panelStatus?.branch).toBe('alpha')
    expect(useGitStatusStore.getState().dirtyCount).toBe(1)
    expect(useGitStatusStore.getState().peekPanelStatus('D:/beta')?.branch).toBe('beta')
  })

  it('rejects a status read older than an applied mutation snapshot', async () => {
    const read = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(read.promise)
    const pending = useGitStatusStore.getState().refresh('D:/repo')
    useGitStatusStore.getState().applyFromGitStatus('D:/repo', sample)
    read.resolve({ dirty_count: 0, branch: 'old', entries: [] })
    await pending
    expect(useGitStatusStore.getState().panelStatus).toEqual(sample)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
  })

  it('does not resurrect cleared state when a request from the previous session returns', async () => {
    const read = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(read.promise)
    const pending = useGitStatusStore.getState().refresh('D:/repo')
    useGitStatusStore.getState().clear()
    useGitStatusStore.getState().applyFromGitStatus('D:/repo', sample)
    read.resolve({ dirty_count: 0, branch: 'old', entries: [] })
    await pending
    expect(useGitStatusStore.getState().panelStatus).toEqual(sample)
  })

  it('serializes a full panel read behind an existing background workdir read', async () => {
    const read = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(read.promise)
    vi.mocked(getGitStatus).mockResolvedValueOnce({ ...sample, ahead: 1, behind: 2 })
    const background = useGitStatusStore.getState().refresh('D:/repo', { background: true })
    const panel = useGitStatusStore
      .getState()
      .refresh('D:/repo', { full: true, reuseInFlight: true })
    const duplicate = useGitStatusStore
      .getState()
      .refresh('D:/repo', { full: true, reuseInFlight: true })
    expect(getGitStatus).not.toHaveBeenCalled()
    read.resolve({ dirty_count: 0, branch: 'main', entries: [] })
    await Promise.all([background, panel, duplicate])
    expect(getGitStatus).toHaveBeenCalledTimes(1)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    expect(useGitStatusStore.getState().panelStatus?.ahead).toBe(1)
  })

  it('keeps the cached count and list when a full read fails', async () => {
    useGitStatusStore.getState().applyFromGitStatus('D:/repo', sample)
    vi.mocked(getGitStatus).mockRejectedValueOnce(new Error('offline'))
    await expect(useGitStatusStore.getState().refresh('D:/repo', { full: true })).rejects.toThrow(
      'offline'
    )
    expect(useGitStatusStore.getState().panelStatus).toEqual(sample)
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
  })

  it('does not turn an ambiguous lightweight failure into an empty repository', async () => {
    useGitStatusStore.getState().applyFromGitStatus('D:/repo', sample)
    vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce(null)
    vi.mocked(getGitStatus).mockRejectedValueOnce(new Error('allowlist not ready'))
    await useGitStatusStore.getState().refresh('D:/repo')
    expect(useGitStatusStore.getState().dirtyCount).toBe(2)
    expect(useGitStatusStore.getState().panelStatus).toEqual(sample)

    vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce(null)
    vi.mocked(getGitStatus).mockResolvedValueOnce({
      is_repository: false,
      branch: null,
      changes: [],
    })
    await useGitStatusStore.getState().refresh('D:/repo')
    expect(useGitStatusStore.getState().dirtyCount).toBe(0)
    expect(useGitStatusStore.getState().panelStatus?.is_repository).toBe(false)
  })

  it('reports a shared full-read failure only to the full-read caller', async () => {
    const read = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(read.promise)
    vi.mocked(getGitStatus).mockRejectedValueOnce(new Error('offline'))
    const watcher = useGitStatusStore.getState().refresh('D:/repo')
    const panel = useGitStatusStore
      .getState()
      .refresh('D:/repo', { full: true, reuseInFlight: true })
    const rejected = expect(panel).rejects.toThrow('offline')
    read.resolve({ dirty_count: 0, branch: 'main', entries: [] })
    await expect(watcher).resolves.toBeUndefined()
    await rejected
  })

  it('keeps a newer workdir result when HEAD metadata is filled during its read', async () => {
    useGitStatusStore.getState().applyFromGitStatus('D:/repo', { ...sample, branch: null })
    const read = deferred<GitWorkdirStatus | null>()
    vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(read.promise)
    const pending = useGitStatusStore.getState().refresh('D:/repo')
    const cached = useGitStatusStore.getState().peekPanelStatus('D:/repo')!
    useGitStatusStore.getState().setPanelStatus('D:/repo', { ...cached, branch: 'main' })
    read.resolve({ dirty_count: 0, entries: [] })
    await pending
    expect(useGitStatusStore.getState().dirtyCount).toBe(0)
    expect(useGitStatusStore.getState().panelStatus?.branch).toBe('main')
  })

  it('does not reactivate the old project when its debounced watcher event fires', async () => {
    vi.useFakeTimers()
    useGitStatusStore.getState().applyFromGitStatus('D:/alpha', sample)
    useGitStatusStore.getState().scheduleRefresh('D:/alpha', 200)
    useGitStatusStore.getState().applyFromGitStatus('D:/beta', { ...sample, changes: [] })
    vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce({
      dirty_count: 0,
      branch: 'alpha',
      entries: [],
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(useGitStatusStore.getState().projectPath).toBe('D:/beta')
    expect(useGitStatusStore.getState().panelStatus?.branch).toBe('main')
  })
})
