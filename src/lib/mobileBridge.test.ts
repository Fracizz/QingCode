// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  invoke: vi.fn<(action: string, command: string, args?: unknown) => Promise<unknown>>(async () => undefined),
  listProjects: vi.fn<() => Promise<Project[]>>(),
  currentProjects: [] as Project[],
  upload: vi.fn(async () => "'/home/app/mobile.jpg'"),
  connect: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('../store/projectStore', () => ({
  useProjectStore: { getState: () => ({ projects: mocks.currentProjects }) },
}))
vi.mock('./sshTerminalPaste', () => ({ uploadLocalFilesForSshTerminal: mocks.upload }))
vi.mock('./tauri', () => ({
  isTauri: () => true,
  isSshResource: (path: string) => path.startsWith('ssh://'),
  safeInvoke: mocks.invoke,
}))
vi.mock('./projectRepository', () => ({
  withDb: async (_action: string, read: (db: unknown) => unknown) => read({}),
  listProjects: mocks.listProjects,
  listSshConnections: async () => [
    { id: 'ssh-wsl', name: 'WSL', host: 'localhost' },
    { id: 'win-dev', name: 'WinDev', host: '192.168.252.107' },
  ],
}))
vi.mock('./sshWorkspace', async importOriginal => ({
  ...await importOriginal<typeof import('./sshWorkspace')>(),
  ensureSshWorkspaceConnected: mocks.connect,
}))

import { listenForMobileRequests } from './mobileBridge'
import { restrictProject, trustProject } from './workspaceTrust'
import { TERMINAL_PROFILES_KEY } from './terminal/terminalProfiles'
import { trustTerminalProfile } from './terminal/terminalProfileTrust'

const wsl: Project = {
  id: 'wsl', name: 'WSL app', path: String.raw`\\wsl.localhost\Ubuntu\home\code\app`,
  kind: 'wsl', created_at: 1, last_opened_at: 1,
}
const local: Project = { ...wsl, id: 'local', name: 'Local app', path: 'D:/app', kind: 'local' }

async function send(payload: Record<string, unknown>) {
  await listenForMobileRequests()
  const handler = mocks.listen.mock.lastCall![1]
  await handler({ payload: { id: 'request', ...payload } })
  return mocks.invoke.mock.calls.filter(call => call[1] === 'mobile_bridge_reply').at(-1)?.[2]
}

function request(project: string | null = null, attachment?: string) {
  return send({ project, attachment })
}

describe('mobile project bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.currentProjects = [local]
    mocks.listProjects.mockResolvedValue([local, wsl])
    trustProject(local)
    trustProject(wsl)
  })

  it('refreshes saved WSL projects added outside the main window', async () => {
    expect(await request()).toEqual({ id: 'request', data: [
      { id: 'local', name: 'Local app', path: 'D:/app', kind: 'local', host: 'Windows', lastOpenedAt: 1 },
      { id: 'wsl', name: 'WSL app', path: wsl.path, kind: 'wsl', host: 'Ubuntu', lastOpenedAt: 1 },
    ] })
  })

  it('checks the saved project list again when opening a WSL terminal', async () => {
    const scratch = { ...local, id: 'scratch', path: 'D:/scratch', ephemeral: true }
    mocks.currentProjects = [local, scratch]
    expect(await request(wsl.id)).toMatchObject({ data: { id: wsl.id, kind: 'wsl' } })
    expect(mocks.invoke).toHaveBeenCalledWith('同步项目根目录', 'sync_project_roots', {
      roots: [local.path, wsl.path, scratch.path],
    })
  })

  it('excludes restricted and undecided projects and rejects opening them', async () => {
    restrictProject(wsl)
    const undecided = { ...wsl, id: 'undecided', path: 'wsl://Debian/home/app' }
    mocks.listProjects.mockResolvedValue([local, wsl, undecided])
    expect(await request()).toMatchObject({ data: [{ id: local.id }] })
    expect(await request(wsl.id)).toMatchObject({ error: expect.stringContaining('信任') })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(await request(wsl.id, 'C:/tmp/mobile.jpg')).toMatchObject({ error: expect.stringContaining('信任') })
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('does not reopen a project removed in another window', async () => {
    mocks.currentProjects = [local, wsl]
    mocks.listProjects.mockResolvedValue([local])
    expect(await request(wsl.id)).toMatchObject({ error: expect.stringContaining('信任') })
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('keeps a remote connection named WSL on the SSH transport', async () => {
    const remote: Project = {
      ...wsl, id: 'remote', kind: 'ssh', path: 'ssh://ssh-wsl/home/code/app', connection_id: 'ssh-wsl',
    }
    trustProject(remote)
    mocks.listProjects.mockResolvedValue([remote])
    expect(await request()).toMatchObject({
      data: [{ id: remote.id, path: remote.path, kind: 'ssh', host: 'localhost', connectionName: 'WSL' }],
    })
    expect(await request(remote.id)).toMatchObject({
      data: { id: remote.id, kind: 'ssh', host: 'localhost', connectionName: 'WSL' },
    })
    expect(await request(remote.id, 'C:/tmp/mobile.jpg')).toMatchObject({ data: { path: expect.stringContaining('/home/app/mobile.jpg') } })
    expect(mocks.upload).toHaveBeenCalledWith(remote.path, ['C:/tmp/mobile.jpg'])
  })

  it('sends the connection name and address for other remote projects', async () => {
    const remote: Project = {
      ...local, id: 'win', kind: 'ssh', path: 'ssh://win-dev/D:/code/app', connection_id: 'win-dev',
    }
    trustProject(remote)
    mocks.listProjects.mockResolvedValue([remote])
    expect(await request()).toMatchObject({
      data: [{ id: remote.id, kind: 'ssh', host: '192.168.252.107', connectionName: 'WinDev' }],
    })
  })

  it('lists saved terminal profiles without their commands', async () => {
    localStorage.setItem(TERMINAL_PROFILES_KEY, JSON.stringify({
      defaultShell: 'pwsh',
      profiles: [
        { id: 'claude', name: 'Claude', command: 'claude', shell: 'auto' },
        { id: 'ops', name: '  ', command: 'deploy\n--dry-run', shell: 'cmd' },
      ],
    }))
    trustTerminalProfile({ id: 'claude', command: 'claude' })
    const reply = await send({ project: null, profiles: true })
    expect(reply).toEqual({ id: 'request', data: [
      { id: 'default', name: '普通终端', trusted: true },
      { id: 'claude', name: 'Claude', trusted: true },
      { id: 'ops', name: '未命名配置', trusted: false },
    ] })
    expect(JSON.stringify(reply)).not.toContain('deploy')
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  it('resolves a trusted profile with the desktop shell rules and rejects untrusted ones', async () => {
    localStorage.setItem(TERMINAL_PROFILES_KEY, JSON.stringify({
      defaultShell: 'pwsh',
      profiles: [{ id: 'ops', name: 'Ops', command: 'deploy\n  --dry-run', shell: 'pwsh' }],
    }))
    expect(await send({ profile: 'default' })).toEqual({ id: 'request', data: {
      id: 'default', name: '普通终端', command: '', shell: 'pwsh',
    } })
    expect(await send({ profile: 'ops' })).toMatchObject({ error: expect.stringContaining('信任此配置') })
    trustTerminalProfile({ id: 'ops', command: 'deploy\n  --dry-run' })
    expect(await send({ profile: 'ops' })).toEqual({ id: 'request', data: {
      id: 'ops', name: 'Ops', command: 'deploy; --dry-run', shell: 'pwsh',
    } })
    expect(await send({ profile: 'missing' })).toMatchObject({ error: expect.stringContaining('不存在') })
  })
})
