// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { Project, SshConnection, TerminalTab } from '../types'
import type { WarmupStatus } from '../lib/sshWarmupQueue'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), prepare: vi.fn(), sync: vi.fn(), spawn: vi.fn(), loadConfigs: vi.fn(), policy: vi.fn(),
  enabled: vi.fn(() => true), backend: vi.fn(() => true), restore: vi.fn(() => true),
  trusted: vi.fn((_project: Project) => true), suspended: vi.fn((_id: string) => false),
}))

const connection = (id: string, overrides: Partial<SshConnection> = {}): SshConnection => ({
  id, name: id, host: id, username: 'user', port: 22, auth_kind: 'privateKey',
  host_key_fingerprint: 'SHA256:confirmed', created_at: 0, updated_at: 0, mode: 'server', ...overrides,
})
const sshProject = (id: string, host = 'a', time = 1): Project => ({
  id, name: id, path: `ssh://${host}/${id}`, kind: 'ssh', connection_id: host, created_at: 0, last_opened_at: time,
} as Project)
const localProject = (id: string, time = 1): Project => ({
  id, name: id, path: `D:/work/${id}`, kind: 'local', created_at: 0, last_opened_at: time,
} as Project)
const pending = (project: Project, overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: `tab-${project.id}`, name: 'Claude', projectId: project.id, cwd: project.path, launchCommand: '',
  status: 'exited', exitCode: null, persistent: true, ptyId: `pty-${project.id}`,
  connectionId: project.path.startsWith('ssh://') ? project.connection_id ?? undefined : '__local__',
  awaitingRestoreSpawn: true, ptySpawnPending: true, ...overrides,
})

const projectStore = create(() => ({ projects: [] as Project[], sshConnections: [] as SshConnection[] }))
const terminalStore = create(() => ({
  terminals: [] as TerminalTab[], syncDetachedTerminals: mocks.sync, spawnRestoredTerminals: mocks.spawn,
}))
const warmupStore = create(() => ({ statuses: new Map<string, WarmupStatus>() as ReadonlyMap<string, WarmupStatus> }))

vi.mock('../store/projectStore', () => ({ useProjectStore: projectStore }))
vi.mock('../store/terminalStore', () => ({ useTerminalStore: terminalStore }))
vi.mock('../store/sshWarmupStore', () => ({ useSshWarmupStore: warmupStore }))
vi.mock('../store/runConfigStore', () => ({ useRunConfigStore: { getState: () => ({ loadConfigs: mocks.loadConfigs }) } }))
vi.mock('../lib/runConfigRuntime', () => ({ applyRunConfigSessionRestorePolicy: mocks.policy }))
vi.mock('../lib/terminalAutoReattachSettings', () => ({
  isTerminalAutoReattachEnabled: mocks.enabled,
  loadTerminalAutoReattachEnabled: async () => mocks.enabled(),
}))
vi.mock('../lib/runtimeCapabilities', () => ({ hasBackend: mocks.backend }))
vi.mock('../lib/windowSession', () => ({ shouldRestoreWorkspace: mocks.restore }))
vi.mock('../lib/workspaceTrust', () => ({ createProjectTrustChecker: () => mocks.trusted, isProjectTrusted: mocks.trusted }))
vi.mock('../lib/sshServerSettings', () => ({ getSshServerEnabled: () => true }))
vi.mock('../lib/sshWorkspace', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/sshWorkspace')>(),
  ensureSshWorkspaceConnected: mocks.connect,
  prepareSshWorkspace: mocks.prepare,
  isSshBackgroundSuspended: mocks.suspended,
}))

const { useTerminalAutoReattach } = await import('./useTerminalAutoReattach')
const { autoReattachLanes } = await import('../lib/terminal/terminalAutoReattach')

const remote = sshProject('remote', 'a', 2)
const local = localProject('local')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.enabled.mockReturnValue(true)
  mocks.backend.mockReturnValue(true)
  mocks.restore.mockReturnValue(true)
  mocks.trusted.mockReturnValue(true)
  mocks.suspended.mockReturnValue(false)
  mocks.connect.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue(undefined)
  mocks.sync.mockResolvedValue(undefined)
  mocks.spawn.mockResolvedValue(undefined)
  mocks.loadConfigs.mockResolvedValue([])
  mocks.policy.mockResolvedValue(0)
  projectStore.setState({ projects: [remote, local], sshConnections: [connection('a')] })
  terminalStore.setState({ terminals: [pending(remote), pending(local)] })
  warmupStore.setState({ statuses: new Map() })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function startup() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  await act(async () => {})
}

describe('autoReattachLanes', () => {
  it('groups projects with reattachable tabs by connection, most recent first', () => {
    const projects = [
      sshProject('old', 'a', 1), sshProject('new', 'a', 5), sshProject('other', 'b', 3), localProject('local', 2),
      sshProject('compat', 'ssh-mode'), sshProject('unconfirmed', 'no-fp'), sshProject('offline', 'manual'),
      sshProject('denied', 'a'), { ...sshProject('temp', 'a'), ephemeral: true } as Project, sshProject('idle', 'a'),
      sshProject('create-only', 'a'),
    ]
    const terminals = projects
      .filter(project => project.id !== 'idle')
      .map(project => project.id === 'create-only'
        ? pending(project, { persistent: false, ptyId: undefined })
        : pending(project))
    const lanes = autoReattachLanes(projects, [
      connection('a'), connection('b'), connection('ssh-mode', { mode: 'ssh' }),
      connection('no-fp', { host_key_fingerprint: '' }), connection('manual'),
    ], terminals, {
      serverEnabled: true,
      trusted: project => project.id !== 'denied',
      suspended: id => id === 'manual',
    })
    expect(lanes.map(lane => lane.map(project => project.id))).toEqual([['new', 'old'], ['other'], ['local']])
  })
})

describe('useTerminalAutoReattach', () => {
  it('reattaches every project in the background after startup, once in StrictMode', async () => {
    renderHook(() => useTerminalAutoReattach(true), { wrapper: StrictMode })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(mocks.connect).not.toHaveBeenCalled()
    await startup()

    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.connect).toHaveBeenCalledWith(remote, expect.objectContaining({ background: true }))
    expect(mocks.prepare).toHaveBeenCalledWith(remote.path, expect.any(AbortSignal), expect.any(Function), { project: remote, background: true })
    expect(mocks.sync).toHaveBeenCalledWith(remote.id)
    expect(mocks.sync).not.toHaveBeenCalledWith(local.id)
    expect(mocks.policy).toHaveBeenCalledWith(remote.id, [])
    expect(mocks.spawn).toHaveBeenCalledWith(remote.id, { background: true })
    expect(mocks.spawn).toHaveBeenCalledWith(local.id, { background: true })
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the setting is off', async () => {
    mocks.enabled.mockReturnValue(false)
    renderHook(() => useTerminalAutoReattach(true))
    await startup()
    act(() => warmupStore.setState({ statuses: new Map([[remote.path, { phase: 'ready' }]]) }))
    await act(async () => {})
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('leaves terminals pending when the host cannot be reached without a prompt', async () => {
    mocks.connect.mockRejectedValue(new Error('SSH 密码未保存在本机'))
    renderHook(() => useTerminalAutoReattach(true))
    await startup()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledWith(local.id, { background: true })
  })

  it('reattaches a project as soon as background warmup has it ready, without reconnecting', async () => {
    const recent = sshProject('recent', 'a', 3)
    projectStore.setState({ projects: [remote, local, recent] })
    terminalStore.setState({ terminals: [] })
    renderHook(() => useTerminalAutoReattach(true))
    act(() => warmupStore.setState({ statuses: new Map([[recent.path, { phase: 'preparing' }]]) }))
    act(() => warmupStore.setState({ statuses: new Map([[recent.path, { phase: 'ready' }]]) }))
    await act(async () => {})
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.sync).toHaveBeenCalledWith(recent.id)
    // 没有待接回标签时不读运行配置。
    expect(mocks.loadConfigs).not.toHaveBeenCalled()
    // 仍是就绪状态的其他更新不重复触发。
    act(() => warmupStore.setState({ statuses: new Map([[recent.path, { phase: 'ready' }]]) }))
    await act(async () => {})
    expect(mocks.sync).toHaveBeenCalledOnce()
  })

  it.each(['fresh', 'browser'])('does not run in a %s window', async mode => {
    if (mode === 'fresh') mocks.restore.mockReturnValue(false)
    else mocks.backend.mockReturnValue(false)
    renderHook(() => useTerminalAutoReattach(true))
    await startup()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('cancels pending work when the app coordinator unmounts', async () => {
    let finish!: () => void
    mocks.connect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const view = renderHook(() => useTerminalAutoReattach(true))
    await startup()
    expect(mocks.connect).toHaveBeenCalledOnce()
    view.unmount()
    await act(async () => { finish() })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
