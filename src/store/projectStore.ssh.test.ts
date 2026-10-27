// @vitest-environment jsdom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  restoreWorkspace: false,
  ensureWorkspaceTrust: vi.fn(() => 'trusted'),
  ensureSshWorkspaceConnected: vi.fn(),
  prepareSshWorkspace: vi.fn(),
  isSshSharedServerReady: vi.fn(),
  requestSshReconnect: vi.fn(),
  safeInvoke: vi.fn(),
  loadProjectsFromDb: vi.fn(),
  listSshConnections: vi.fn(),
  touchAndLoadRecentFiles: vi.fn(),
  loadProjectRootTree: vi.fn(),
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
vi.mock('../lib/windowSession', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/windowSession')>()),
  shouldRestoreWorkspace: () => mocks.restoreWorkspace,
}))
vi.mock('./editorSessionBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('./editorSessionBridge')>()),
  activateProjectSession: vi.fn(),
}))

import { useProjectStore } from './projectStore'
import { cancelSshOpening, useSshOpeningStore } from './sshOpeningStore'

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
  cancelSshOpening()
  mocks.loadProjectRootTree.mockResolvedValue([])
  useProjectStore.setState({
    projects: [remote],
    currentProject: null,
    unavailableProjectIds: [],
    projectTrees: {},
    projectTreeErrors: {},
    toasts: [],
    refreshProjectTree: vi.fn().mockResolvedValue(undefined),
  })
})

describe('SSH project availability', () => {
  it('uses a lightweight hint for a shared service while keeping project activation gated on preparation', async () => {
    mocks.isSshSharedServerReady.mockResolvedValueOnce(true)
    let finish!: () => void
    mocks.prepareSshWorkspace.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const opening = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalled())
    expect(useSshOpeningStore.getState().attempt?.reusingServer).toBe(true)
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
      remote.path, expect.any(AbortSignal), expect.any(Function)
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
    expect(useSshOpeningStore.getState().attempt?.error).toContain('ConnectFailed')
    expect(mocks.requestSshReconnect).not.toHaveBeenCalled()
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])

    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().projectTrees[remote.id]?.[0]?.name).toBe('README.md')
    expect(useProjectStore.getState().projectTreeErrors[remote.id]).toBe('')
    expect(mocks.ensureSshWorkspaceConnected).toHaveBeenCalledTimes(2)
    expect(useSshOpeningStore.getState().attempt).toBeNull()
  })

  it('keeps the previous workspace active until service and first file read complete, and ignores duplicate clicks', async () => {
    let finishService!: () => void
    mocks.prepareSshWorkspace.mockImplementationOnce(() => new Promise<void>(resolve => { finishService = resolve }))
    useProjectStore.setState({ currentProject: local })
    const opening = useProjectStore.getState().switchProject(remote)
    await vi.waitFor(() => expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1))

    expect(useProjectStore.getState().currentProject).toEqual(local)
    expect(useSshOpeningStore.getState().attempt?.stage).toBe('service')
    expect(mocks.loadProjectRootTree).not.toHaveBeenCalled()
    expect(await useProjectStore.getState().switchProject(remote)).toBe(false)
    finishService()
    expect(await opening).toBe(true)
    expect(useProjectStore.getState().currentProject).toEqual(remote)
    expect(useProjectStore.getState().projectTrees[remote.id]).toEqual([])
    expect(mocks.prepareSshWorkspace).toHaveBeenCalledTimes(1)
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

  it('shows daemon preparation failures without asking for SSH credentials', async () => {
    mocks.prepareSshWorkspace.mockRejectedValueOnce(new Error('远端 daemon 不可用'))
    expect(await useProjectStore.getState().switchProject(remote)).toBe(false)
    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(useSshOpeningStore.getState().attempt?.error).toContain('daemon 不可用')
    expect(mocks.requestSshReconnect).not.toHaveBeenCalled()
    expect(mocks.loadProjectRootTree).not.toHaveBeenCalled()
  })
})

afterAll(() => {
  useProjectStore.setState(initialState, true)
})
