// @vitest-environment jsdom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  restoreWorkspace: false,
  ensureWorkspaceTrust: vi.fn(() => 'trusted'),
  ensureSshWorkspaceConnected: vi.fn(),
  prepareSshWorkspace: vi.fn(),
  isSshSharedServerReady: vi.fn(),
  isSshWorkspaceReady: vi.fn(),
  requestSshReconnect: vi.fn(),
  safeInvoke: vi.fn(),
  loadProjectsFromDb: vi.fn(),
  listSshConnections: vi.fn(),
  touchAndLoadRecentFiles: vi.fn(),
  loadProjectRootTree: vi.fn(),
  takeSshWarmup: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  safeInvoke: mocks.safeInvoke,
  isTauri: () => true,
  NotInTauriError: class NotInTauriError extends Error {},
}))
vi.mock('../lib/projectRepository', () => ({
  loadProjectsFromDb: mocks.loadProjectsFromDb,
  listSshConnections: mocks.listSshConnections,
  touchAndLoadRecentFiles: mocks.touchAndLoadRecentFiles,
}))
vi.mock('../lib/sshWorkspace', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/sshWorkspace')>()),
  ensureSshWorkspaceConnected: mocks.ensureSshWorkspaceConnected,
  prepareSshWorkspace: mocks.prepareSshWorkspace,
  isSshSharedServerReady: mocks.isSshSharedServerReady,
  isSshWorkspaceReady: mocks.isSshWorkspaceReady,
  requestSshReconnect: mocks.requestSshReconnect,
}))
vi.mock('../lib/fileTreeCache', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/fileTreeCache')>()),
  loadProjectRootTree: mocks.loadProjectRootTree,
}))
vi.mock('../lib/workspaceTrust', () => ({
  ensureWorkspaceTrust: mocks.ensureWorkspaceTrust,
  pushTrustedRootsToNative: vi.fn(),
}))
vi.mock('../lib/pathAllowlist', () => ({
  syncRootsFromProjects: vi.fn(),
}))
vi.mock('./sshWarmupStore', () => ({
  beginSshForeground: () => () => {},
  takeSshWarmup: mocks.takeSshWarmup,
  peekSshWarmup: () => undefined,
  cancelSshWarmup: vi.fn(),
}))
vi.mock('../lib/windowSession', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/windowSession')>()),
  shouldRestoreWorkspace: () => mocks.restoreWorkspace,
}))
vi.mock('./editorSessionBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('./editorSessionBridge')>()),
  activateProjectSession: vi.fn(),
}))

import { useProjectStore } from './projectStore'
import { cancelSshOpening, latestSshOpening, sshOpeningKey, useSshOpeningStore } from './sshOpeningStore'

const remote: Project = {
  id: 'remote',
  name: 'django',
  path: 'ssh://connection/home/team/django',
  kind: 'ssh',
  connection_id: 'connection',
  root_path: '/home/team/django',
  created_at: 1,
  last_opened_at: 1,
}
const local: Project = {
  id: 'local',
  name: 'local',
  path: 'D:/code/local',
  created_at: 1,
  last_opened_at: 1,
}

const initialState = useProjectStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.restoreWorkspace = false
  mocks.listSshConnections.mockResolvedValue([])
  mocks.touchAndLoadRecentFiles.mockResolvedValue([])
  mocks.safeInvoke.mockResolvedValue(undefined)
  mocks.ensureSshWorkspaceConnected.mockResolvedValue(undefined)
  mocks.prepareSshWorkspace.mockResolvedValue(undefined)
  mocks.isSshSharedServerReady.mockResolvedValue(false)
  mocks.isSshWorkspaceReady.mockResolvedValue(false)
  cancelSshOpening()
  mocks.loadProjectRootTree.mockResolvedValue([])
  useProjectStore.setState({
    projects: [remote],
    currentProject: null,
    unavailableProjectIds: [],
    projectTrees: {},
    projectTreeErrors: {},
    toasts: [],
    projectCatalogReady: false,
    refreshProjectTree: vi.fn().mockResolvedValue(undefined),
  })
})

describe('SSH project availability', () => {
  it('does not activate native watches when directory reading finishes after cancellation', async () => {
    let finish!: (value: []) => void
    mocks.loadProjectRootTree.mockImplementationOnce(() => new Promise<[]>(resolve => { finish = resolve }))
    const switching = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.loadProjectRootTree).toHaveBeenCalled())
    cancelSshOpening()
    expect(await switching).toBe(false)
    finish([])
    await Promise.resolve()
    expect(mocks.safeInvoke.mock.calls.some(call => call[1] === 'ssh_activate_workspace')).toBe(false)
    expect(useProjectStore.getState().currentProject).toBeNull()
  })
  it('prepares again when the warmed connection is gone by the time the project opens', async () => {
    mocks.takeSshWarmup.mockReturnValueOnce(Promise.resolve([]))
    mocks.isSshWorkspaceReady.mockResolvedValueOnce(false)
    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(mocks.ensureSshWorkspaceConnected).toHaveBeenCalledWith(remote)
    expect(mocks.prepareSshWorkspace).toHaveBeenCalledWith(remote.path, expect.any(AbortSignal), expect.any(Function), { project: remote })
  })

  it('skips preparation but reads the directory when the warmed service kept no tree', async () => {
    mocks.takeSshWarmup.mockReturnValueOnce(Promise.resolve(undefined))
    mocks.isSshWorkspaceReady.mockResolvedValueOnce(true)
    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(mocks.prepareSshWorkspace).not.toHaveBeenCalled()
    expect(mocks.loadProjectRootTree).toHaveBeenCalledTimes(1)
  })

  it('records why an open missed background preparation and where the time went', async () => {
    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    const call = mocks.safeInvoke.mock.calls.find(item => item[1] === 'ssh_open_diagnostic_event')
    expect(call?.[2]).toEqual({ event: expect.objectContaining({
      projectId: remote.id, connectionId: 'connection', warmup: 'none', reused: false, outcome: 'opened',
      prepareMs: expect.any(Number), filesMs: expect.any(Number),
    }) })
  })

  it('joins background preparation without activating early, then opens without preparing twice', async () => {
    const tree = [{ name: 'remote.txt', path: `${remote.path}/remote.txt`, is_dir: false, loaded: true }]
    let finish!: (value: typeof tree) => void
    mocks.takeSshWarmup.mockReturnValueOnce(new Promise<typeof tree>(resolve => { finish = resolve }))
    mocks.isSshWorkspaceReady.mockResolvedValueOnce(true)
    const switching = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.takeSshWarmup).toHaveBeenCalled())
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(mocks.prepareSshWorkspace).not.toHaveBeenCalled()
    finish(tree)
    expect(await switching).toBe(true)
    expect(mocks.prepareSshWorkspace).not.toHaveBeenCalled()
    expect(mocks.safeInvoke.mock.calls.filter(call => call[1] === 'ssh_activate_workspace')).toHaveLength(1)
    expect(mocks.loadProjectRootTree).not.toHaveBeenCalled()
    expect(useProjectStore.getState().fileTree).toEqual(tree)
    expect(useProjectStore.getState().refreshProjectTree).toHaveBeenCalledWith(remote)
    expect(mocks.touchAndLoadRecentFiles).toHaveBeenCalledTimes(1)
  })

  it('cancels foreground activation while a shared background task finishes later', async () => {
    let finish!: (value: []) => void
    mocks.takeSshWarmup.mockReturnValueOnce(new Promise<[]>(resolve => { finish = resolve }))
    const switching = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.takeSshWarmup).toHaveBeenCalled())
    cancelSshOpening()
    expect(await switching).toBe(false)
    finish([])
    await Promise.resolve()
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(mocks.prepareSshWorkspace).not.toHaveBeenCalled()
    expect(mocks.touchAndLoadRecentFiles).not.toHaveBeenCalled()
  })
  it('uses a lightweight hint for a shared service while keeping project activation gated on preparation', async () => {
    mocks.isSshSharedServerReady.mockResolvedValueOnce(true)
    let finish!: () => void
    mocks.prepareSshWorkspace.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const opening = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalled())
    expect(latestSshOpening()?.reusingServer).toBe(true)
    expect(useProjectStore.getState().currentProject).toBeNull()
    finish()
    expect(await opening).toBe(true)
    expect(mocks.loadProjectRootTree).toHaveBeenCalledWith(remote)
  })
  it('reloads explicitly imported projects without activating a project or opening a trust prompt', async () => {
    mocks.restoreWorkspace = true
    mocks.loadProjectsFromDb.mockResolvedValue({ migrated: false, projects: [local], importedFromSettings: 1 })
    await useProjectStore.getState().loadProjects({ restoreCurrent: false })
    expect(useProjectStore.getState().projects).toEqual([local])
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(mocks.ensureWorkspaceTrust).not.toHaveBeenCalled()
    expect(mocks.touchAndLoadRecentFiles).not.toHaveBeenCalled()
  })
  it('releases background warmup before the restored remote project finishes opening', async () => {
    mocks.restoreWorkspace = true
    mocks.loadProjectsFromDb.mockResolvedValue({ migrated: false, projects: [remote], importedFromSettings: 0 })
    let finishPrepare!: () => void
    mocks.prepareSshWorkspace.mockImplementationOnce(() => new Promise<void>(resolve => { finishPrepare = resolve }))
    const loading = useProjectStore.getState().loadProjects()
    // 恢复的远程项目正在安装/更新服务时，其他连接的预热与服务更新已可开始。
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalled())
    expect(useProjectStore.getState().projectCatalogReady).toBe(true)
    expect(useProjectStore.getState().currentProject).toBeNull()
    finishPrepare()
    await loading
    expect(useProjectStore.getState().currentProject?.id).toBe(remote.id)
  })

  it('does not call an unattended SSH validation that disables the project', async () => {
    mocks.loadProjectsFromDb.mockResolvedValue({
      migrated: false,
      projects: [remote],
      importedFromSettings: 0,
    })

    await useProjectStore.getState().loadProjects()

    expect(mocks.ensureSshWorkspaceConnected).not.toHaveBeenCalled()
    expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
      '检查项目目录', 'validate_directory', { path: remote.path }
    )
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])
  })

  it('allows retry after a disconnected session and opens the same folder again', async () => {
    mocks.ensureSshWorkspaceConnected.mockRejectedValueOnce(new Error('SSH session closed'))

    expect(await useProjectStore.getState().switchProject(remote)).toBe(false)
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])
    expect(mocks.requestSshReconnect).toHaveBeenCalledWith(remote)

    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().currentProject?.id).toBe(remote.id)
    expect(mocks.prepareSshWorkspace).toHaveBeenCalledWith(
      remote.path, expect.any(AbortSignal), expect.any(Function), { project: remote }
    )
    expect(mocks.loadProjectRootTree).toHaveBeenCalledWith(remote)
    expect(await useProjectStore.getState().switchProject(local)).toBe(true)
    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])
  })

  it('reports a missing remote directory without disabling the project or asking for credentials', async () => {
    mocks.ensureSshWorkspaceConnected.mockRejectedValueOnce(
      new Error('远程项目目录不可用：No such file')
    )

    expect(await useProjectStore.getState().switchProject(remote)).toBe(false)
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])
    expect(mocks.requestSshReconnect).not.toHaveBeenCalled()
    expect(useProjectStore.getState().toasts[0]?.text).toContain('远程项目目录不可用')
  })

  it('keeps a failed initial scan in the opening dialog and activates only after retry succeeds', async () => {
    useProjectStore.setState({ refreshProjectTree: initialState.refreshProjectTree })
    mocks.loadProjectRootTree
      .mockRejectedValueOnce(new Error('打开 SSH SFTP 通道失败：ConnectFailed'))
      .mockResolvedValueOnce([{ path: `${remote.path}/README.md`, name: 'README.md', is_dir: false, loaded: true }])

    expect(await useProjectStore.getState().switchProject(remote)).toBe(false)
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(useProjectStore.getState().projectTrees[remote.id]).toBeUndefined()
    expect(latestSshOpening()?.error).toContain('ConnectFailed')
    expect(mocks.requestSshReconnect).not.toHaveBeenCalled()
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])

    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().projectTrees[remote.id]?.[0]?.name).toBe('README.md')
    expect(useProjectStore.getState().projectTreeErrors[remote.id]).toBe('')
    expect(mocks.ensureSshWorkspaceConnected).toHaveBeenCalledTimes(2)
    expect(latestSshOpening()).toBeNull()
  })

  it('keeps the previous workspace active until service and first file read complete, and joins duplicate clicks', async () => {
    let finishService!: () => void
    mocks.prepareSshWorkspace.mockImplementationOnce(() => new Promise<void>(resolve => { finishService = resolve }))
    useProjectStore.setState({ currentProject: local })
    const opening = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1))

    expect(useProjectStore.getState().currentProject).toEqual(local)
    expect(latestSshOpening()?.stage).toBe('service')
    expect(mocks.loadProjectRootTree).not.toHaveBeenCalled()
    const duplicate = useProjectStore.getState().switchProject(remote)
    finishService()
    expect(await opening).toBe(true)
    expect(await duplicate).toBe(true)
    expect(useProjectStore.getState().currentProject).toEqual(remote)
    expect(useProjectStore.getState().projectTrees[remote.id]).toEqual([])
    expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1)
  })

  it('lets a local project click win while the remote opening keeps preparing in the background', async () => {
    let finishService!: () => void
    mocks.prepareSshWorkspace.mockImplementationOnce(() => new Promise<void>(resolve => { finishService = resolve }))
    useProjectStore.setState({ projects: [remote, local] })
    const opening = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1))

    // 本机项目不等待、也不取消另一个连接上的打开流程。
    expect(await useProjectStore.getState().switchProject(local)).toBe(true)
    expect(useProjectStore.getState().currentProject).toEqual(local)
    expect(latestSshOpening()?.project).toEqual(remote)
    finishService()
    expect(await opening).toBe(false)
    expect(latestSshOpening()).toBeNull()
    expect(useProjectStore.getState().currentProject).toEqual(local)
    // 准备好的目录树留作缓存，下次点击可直接切换。
    expect(useProjectStore.getState().projectTrees[remote.id]).toEqual([])
  })

  it('runs openings on different SSH connections concurrently and supersedes only the same connection', async () => {
    const other: Project = { ...remote, id: 'remote-2', name: 'other', path: 'ssh://conn-2/srv/other', connection_id: 'conn-2' }
    const sibling: Project = { ...remote, id: 'remote-3', name: 'sibling', path: `${remote.path}-sibling` }
    const finishers: Array<() => void> = []
    mocks.prepareSshWorkspace.mockImplementation(() => new Promise<void>(resolve => { finishers.push(resolve) }))
    useProjectStore.setState({ projects: [remote, other, sibling, local], currentProject: local })
    const first = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1))
    const second = useProjectStore.getState().switchProject(other)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(2))
    expect(Object.keys(useSshOpeningStore.getState().attempts).sort()).toEqual(
      [sshOpeningKey(remote), sshOpeningKey(other)].sort()
    )

    // 同一连接上的新打开取代旧的。
    const third = useProjectStore.getState().switchProject(sibling)
    expect(await first).toBe(false)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(3))
    expect(useSshOpeningStore.getState().attempts[sshOpeningKey(remote)]?.project).toEqual(sibling)
    finishers.forEach(finish => finish())
    expect(await second).toBe(false)
    expect(await third).toBe(true)
    expect(useProjectStore.getState().currentProject).toEqual(sibling)
    mocks.prepareSshWorkspace.mockReset()
  })

  it('cancels a slow connection without letting its late completion activate the project', async () => {
    let finishConnect!: () => void
    mocks.ensureSshWorkspaceConnected.mockImplementationOnce(() => new Promise<void>(resolve => { finishConnect = resolve }))
    useProjectStore.setState({ currentProject: local })
    const opening = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.ensureSshWorkspaceConnected).toHaveBeenCalledTimes(1))
    cancelSshOpening()
    expect(await opening).toBe(false)
    finishConnect()
    await Promise.resolve()
    expect(useProjectStore.getState().currentProject).toEqual(local)
    expect(mocks.prepareSshWorkspace).not.toHaveBeenCalled()
    expect(mocks.requestSshReconnect).not.toHaveBeenCalled()
  })

  it('switches back to a connected remote project instantly from its cached tree and refreshes in background', async () => {
    const cached = [{ path: `${remote.path}/src`, name: 'src', is_dir: true, loaded: true, children: [] }]
    mocks.isSshWorkspaceReady.mockResolvedValue(true)
    useProjectStore.setState({ currentProject: local, projectTrees: { [remote.id]: cached } })

    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().currentProject).toEqual(remote)
    expect(useProjectStore.getState().fileTree).toBe(cached)
    expect(useProjectStore.getState().projectTrees[remote.id]).toBe(cached)
    expect(latestSshOpening()).toBeNull()
    expect(mocks.ensureSshWorkspaceConnected).not.toHaveBeenCalled()
    expect(mocks.prepareSshWorkspace).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(useProjectStore.getState().refreshProjectTree).toHaveBeenCalledWith(remote)
    )
  })

  it('falls back to full preparation when the cached remote project is no longer connected', async () => {
    useProjectStore.setState({ currentProject: local, projectTrees: { [remote.id]: [] } })
    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(mocks.ensureSshWorkspaceConnected).toHaveBeenCalledWith(remote)
    expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1)
  })

  it('shows daemon preparation failures without asking for SSH credentials', async () => {
    mocks.prepareSshWorkspace.mockRejectedValueOnce(new Error('远端 daemon 不可用'))
    expect(await useProjectStore.getState().switchProject(remote)).toBe(false)
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(latestSshOpening()?.error).toContain('daemon 不可用')
    expect(mocks.requestSshReconnect).not.toHaveBeenCalled()
    expect(mocks.loadProjectRootTree).not.toHaveBeenCalled()
  })
})

afterAll(() => {
  useProjectStore.setState(initialState, true)
})
