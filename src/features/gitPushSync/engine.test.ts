import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRemote } from '@/lib/git/git'
import type { Project } from '@/types'
import { DEFAULT_CONFIG, type GitPushSyncConfig, type SyncTracking } from './core'
import { createGitPushSyncEngine, machineConcurrency, syncMachineKey, type EngineDeps, type SyncResult } from './engine'

const A = { id: 'a', name: 'A', path: 'C:/a' } as Project
const B = { id: 'b', name: 'B', path: 'ssh://c/b' } as Project
const ORIGIN: GitRemote[] = [
  { name: 'origin', fetch_url: 'git@host:team/repo.git', push_urls: ['git@host:team/repo.git'] },
]

function status(partial: Partial<SyncTracking> = {}): SyncTracking {
  return { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, ...partial }
}

function setup(overrides: Partial<EngineDeps> = {}, config: Partial<GitPushSyncConfig> = {}) {
  const records: SyncResult[] = []
  let clock = 1_000_000
  const deps: EngineDeps = {
    projects: () => [A, B],
    config: () => ({ ...DEFAULT_CONFIG, enabled: true, receivers: ['b'], ...config }),
    isTrusted: () => true,
    dirtyEditorCount: () => 0,
    getTracking: vi.fn().mockResolvedValue(status({ behind: 2 })),
    getRemotes: vi.fn().mockResolvedValue(ORIGIN),
    fetch: vi.fn().mockResolvedValue(undefined),
    mergeFastForward: vi.fn().mockResolvedValue(undefined),
    setWatches: vi.fn().mockResolvedValue(undefined),
    afterFastForward: vi.fn(),
    record: (_project, result) => records.push(result),
    notify: vi.fn(),
    rememberIdentity: vi.fn(),
    isLiveDetection: () => false,
    now: () => clock,
    ...overrides,
  }
  const engine = createGitPushSyncEngine(deps)
  return { deps, engine, records, advance: (ms: number) => (clock += ms) }
}

const PUSH = { projectPath: A.path, remote: 'origin', branch: 'main' }

describe('git push sync engine', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fast-forwards a receiver after a push from the same repository', async () => {
    const { deps, engine, records } = setup()
    await engine.handlePush(PUSH)
    // 只拉推送的那一个分支，不做全量 fetch。
    expect(deps.fetch).toHaveBeenCalledWith(B.path, { remote: 'origin', branch: 'main' })
    expect(deps.mergeFastForward).toHaveBeenCalledWith(B.path, 'origin/main')
    expect(deps.afterFastForward).toHaveBeenCalledWith(B)
    expect(records.at(-1)).toMatchObject({ kind: 'synced', commits: 2 })
  })

  it('never fast-forwards the project that pushed', async () => {
    const { deps, engine } = setup({}, { receivers: ['a'] })
    await engine.handlePush(PUSH)
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('does nothing while the feature is disabled', async () => {
    const { deps, engine } = setup({}, { enabled: false })
    await engine.handlePush(PUSH)
    expect(deps.getRemotes).not.toHaveBeenCalled()
  })

  it('ignores pushes to a branch the receiver is not tracking', async () => {
    const { deps, engine } = setup()
    await engine.handlePush({ ...PUSH, branch: 'other' })
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('skips receivers known to belong to another repository without running Git', async () => {
    const C = { id: 'c', name: 'C', path: 'C:/c' } as Project
    const { deps, engine } = setup(
      { projects: () => [A, B, C] },
      { receivers: ['b', 'c'], identities: { c: ['host/team/other'] } },
    )
    await engine.handlePush(PUSH)
    expect(deps.getTracking).not.toHaveBeenCalledWith(C.path)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
  })

  it('reports a missing upstream without fetching', async () => {
    const { deps, engine, records } = setup({
      getTracking: vi.fn().mockResolvedValue(status({ upstream: null })),
    })
    await engine.catchUp(B)
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(records.at(-1)?.kind).toBe('no-upstream')
  })

  it('ignores pushes from a different repository', async () => {
    const getRemotes = vi.fn(async (path: string) =>
      path === A.path
        ? [{ name: 'origin', fetch_url: 'git@host:team/other.git', push_urls: [] }]
        : ORIGIN,
    )
    const { deps, engine } = setup({ getRemotes })
    await engine.handlePush(PUSH)
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('reports divergence without merging', async () => {
    const { deps, engine, records } = setup({
      getTracking: vi.fn().mockResolvedValue(status({ ahead: 1, behind: 1 })),
    })
    await engine.handlePush(PUSH)
    expect(deps.mergeFastForward).not.toHaveBeenCalled()
    expect(records.at(-1)?.kind).toBe('diverged')
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('protects unsaved editors, which Git cannot see', async () => {
    const { deps, engine, records } = setup({ dirtyEditorCount: () => 1 })
    await engine.handlePush(PUSH)
    expect(deps.mergeFastForward).not.toHaveBeenCalled()
    expect(records.at(-1)?.kind).toBe('dirty-editors')
  })

  it('only notifies in notify mode', async () => {
    const { deps, engine, records } = setup({}, { action: 'notify' })
    await engine.handlePush(PUSH)
    expect(deps.fetch).toHaveBeenCalled()
    expect(deps.mergeFastForward).not.toHaveBeenCalled()
    expect(records.at(-1)).toMatchObject({ kind: 'behind', commits: 2 })
  })

  it('records a blocked merge and does not reload', async () => {
    const { deps, engine, records } = setup({
      mergeFastForward: vi.fn().mockRejectedValue('local changes would be overwritten'),
    })
    await engine.handlePush(PUSH)
    expect(records.at(-1)).toMatchObject({ kind: 'blocked' })
    expect(deps.afterFastForward).not.toHaveBeenCalled()
  })

  it('records an unreachable receiver as offline without fetching', async () => {
    const getRemotes = vi.fn(async (path: string) => {
      if (path === B.path) throw new Error('未连接')
      return ORIGIN
    })
    const { deps, engine, records } = setup({ getRemotes })
    await engine.handlePush(PUSH)
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(records.at(-1)?.kind).toBe('offline')
  })

  it('skips untrusted receivers', async () => {
    const { deps, engine } = setup({ isTrusted: project => project.id !== 'b' })
    await engine.handlePush(PUSH)
    expect(deps.getTracking).not.toHaveBeenCalled()
  })

  it('does not repeat the same warning for repeated events', async () => {
    const { deps, engine } = setup({
      getTracking: vi.fn().mockResolvedValue(status({ ahead: 1, behind: 1 })),
    })
    await engine.handlePush(PUSH)
    await engine.handlePush(PUSH)
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('throttles catch-up unless forced', async () => {
    const { deps, engine, advance } = setup()
    await engine.catchUp(B)
    await engine.catchUp(B)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    await engine.catchUp(B, { force: true })
    expect(deps.fetch).toHaveBeenCalledTimes(2)
    advance(2 * 60 * 1000 + 1)
    await engine.catchUp(B)
    expect(deps.fetch).toHaveBeenCalledTimes(3)
  })

  it('catches up only on receivers', async () => {
    const { deps, engine } = setup()
    await engine.catchUp(A)
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('leaves panel pushes to the live watcher when one exists', async () => {
    const { deps, engine } = setup({ isLiveDetection: () => true })
    await engine.handlePanelPush(A.path)
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('uses panel pushes when no live watcher exists', async () => {
    const { deps, engine } = setup()
    await engine.handlePanelPush(A.path)
    expect(deps.mergeFastForward).toHaveBeenCalledWith(B.path, 'origin/main')
  })

  it('watches only projects sharing a repository with another receiver', async () => {
    const other = { id: 'c', name: 'C', path: 'C:/c' } as Project
    const getRemotes = vi.fn(async (path: string) =>
      path === other.path
        ? [{ name: 'origin', fetch_url: 'git@host:team/other.git', push_urls: [] }]
        : ORIGIN,
    )
    const { deps, engine } = setup({ projects: () => [A, B, other], getRemotes })
    await engine.refreshWatches()
    expect(deps.setWatches).toHaveBeenCalledWith([A.path])
  })

  it('keeps watching sources while an offline receiver has a remembered identity', async () => {
    const getRemotes = vi.fn(async (path: string) => {
      if (path === B.path) throw new Error('未连接')
      return ORIGIN
    })
    const { deps, engine } = setup({ getRemotes }, { identities: { b: ['host/team/repo'] } })
    await engine.refreshWatches()
    expect(deps.setWatches).toHaveBeenCalledWith([A.path])
  })

  it('stops all watches when there are no receivers', async () => {
    const { deps, engine } = setup({}, { receivers: [] })
    await engine.refreshWatches()
    expect(deps.setWatches).toHaveBeenCalledWith([])
    expect(deps.getRemotes).not.toHaveBeenCalled()
  })

  it('runs machines in parallel and caps concurrency within one machine', async () => {
    const C = { id: 'c', name: 'C', path: 'ssh://other/c' } as Project
    const D = { id: 'd', name: 'D', path: 'ssh://c/d' } as Project
    const E = { id: 'e', name: 'E', path: 'ssh://c/e' } as Project
    const started: string[] = []
    const gates = new Map<string, () => void>()
    const fetch = vi.fn((path: string) => {
      started.push(path)
      return new Promise<void>(resolve => gates.set(path, resolve))
    })
    const { engine } = setup(
      { projects: () => [A, B, C, D, E], fetch },
      { receivers: ['b', 'c', 'd', 'e'] },
    )
    const done = engine.handlePush(PUSH)
    // ssh:c 同时最多两个任务；另一台机器 C 不受影响。
    await vi.waitFor(() => expect([...started].sort()).toEqual([B.path, C.path, D.path].sort()))
    gates.get(B.path)?.()
    await vi.waitFor(() => expect(started).toContain(E.path))
    gates.get(C.path)?.()
    gates.get(D.path)?.()
    gates.get(E.path)?.()
    await done
  })

  it('syncs the current project first within its machine', async () => {
    const D = { id: 'd', name: 'D', path: 'ssh://c/d' } as Project
    const E = { id: 'e', name: 'E', path: 'ssh://c/e' } as Project
    const F = { id: 'f', name: 'F', path: 'ssh://c/f' } as Project
    const order: string[] = []
    const { engine } = setup(
      {
        projects: () => [A, B, D, E, F],
        currentProjectPath: () => F.path,
        fetch: vi.fn(async (path: string) => {
          order.push(path)
        }),
      },
      { receivers: ['b', 'd', 'e', 'f'] },
    )
    await engine.handlePush(PUSH)
    // B、D 占满两个名额；排队中的 F 是当前项目，跳到 E 前面。
    expect(order.slice(0, 2)).toEqual([B.path, D.path])
    expect(order.slice(2)).toEqual([F.path, E.path])
  })

  it('allows more concurrency on the local machine than over SSH', () => {
    expect(machineConcurrency('local')).toBeGreaterThan(machineConcurrency('ssh:c'))
  })

  it('keys machines by connection, WSL distro or local', () => {
    expect(syncMachineKey({ path: 'ssh://c/x' } as Project)).toBe('ssh:c')
    expect(syncMachineKey({ path: 'wsl://Ubuntu/x' } as Project)).toBe('wsl:Ubuntu')
    expect(syncMachineKey({ path: 'C:/x' } as Project)).toBe('local')
  })
})
