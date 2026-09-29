// @vitest-environment jsdom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  ensureSshWorkspaceConnected: vi.fn(),
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
  requestSshReconnect: mocks.requestSshReconnect,
}))
vi.mock('../lib/fileTreeCache', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/fileTreeCache')>()),
  loadProjectRootTree: mocks.loadProjectRootTree,
}))
vi.mock('../lib/workspaceTrust', () => ({
  ensureWorkspaceTrust: () => 'trusted',
  pushTrustedRootsToNative: vi.fn(),
}))
vi.mock('../lib/pathAllowlist', () => ({
  syncRootsFromProjects: vi.fn(),
}))
vi.mock('../lib/windowSession', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/windowSession')>()),
  shouldRestoreWorkspace: () => false,
}))
vi.mock('./editorSessionBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('./editorSessionBridge')>()),
  activateProjectSession: vi.fn(),
}))

import { useProjectStore } from './projectStore'

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
  mocks.listSshConnections.mockResolvedValue([])
  mocks.touchAndLoadRecentFiles.mockResolvedValue([])
  mocks.safeInvoke.mockResolvedValue(undefined)
  mocks.ensureSshWorkspaceConnected.mockResolvedValue(undefined)
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
    expect(mocks.safeInvoke).toHaveBeenCalledWith(
      '检查项目目录', 'validate_directory', { path: remote.path }
    )
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

  it('keeps a failed SFTP root scan visible and clears it after retry', async () => {
    useProjectStore.setState({ refreshProjectTree: initialState.refreshProjectTree })
    mocks.loadProjectRootTree
      .mockRejectedValueOnce(new Error('打开 SSH SFTP 通道失败：ConnectFailed'))
      .mockResolvedValueOnce([{ path: `${remote.path}/README.md`, name: 'README.md', is_dir: false, loaded: true }])

    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().projectTrees[remote.id]).toBeUndefined()
    expect(useProjectStore.getState().projectTreeErrors[remote.id]).toContain('ConnectFailed')
    expect(useProjectStore.getState().unavailableProjectIds).toEqual([])

    expect(await useProjectStore.getState().switchProject(remote)).toBe(true)
    expect(useProjectStore.getState().projectTrees[remote.id]?.[0]?.name).toBe('README.md')
    expect(useProjectStore.getState().projectTreeErrors[remote.id]).toBe('')
    expect(mocks.ensureSshWorkspaceConnected).toHaveBeenCalledTimes(2)
  })
})

afterAll(() => {
  useProjectStore.setState(initialState, true)
})
