import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SshConnection } from '../types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), info: vi.fn(), list: vi.fn(), prepare: vi.fn(), update: vi.fn(), trusted: vi.fn(() => true),
  settings: vi.fn(async () => ({ autoDownload: true, offlineDir: '/offline' })),
}))
vi.mock('./tauri', () => ({ safeInvoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('./projectRepository', () => ({ getSshConnection: vi.fn(), upsertSshConnection: vi.fn(), listSshConnections: mocks.list }))
vi.mock('./sshServerSettings', () => ({ getSshServerEnabled: () => true, loadSshPreparationSettings: mocks.settings }))
vi.mock('./workspaceTrust', () => ({ isProjectTrusted: mocks.trusted }))
vi.mock('./directAgent', async importOriginal => ({ ...await importOriginal<typeof import('./directAgent')>(), directAgentApi: { info: mocks.info } }))
vi.mock('./directServerUpdate', async importOriginal => ({ ...await importOriginal<typeof import('./directServerUpdate')>(), directServerUpdateApi: { prepare: mocks.prepare, update: mocks.update } }))

import { prepareSshWorkspace } from './sshWorkspace'
import { useServerOperationStore } from '../store/serverOperationStore'

let sequence = 0
let project: Project
let ssh: SshConnection
const mismatch = new Error('[direct:version] Server 版本不匹配：远端 old，本端 current')
const ready = () => ({ rootUri: project.path, connectionId: ssh.id, phase: 'readyServer', mode: 'server', connectionMode: 'server', transport: 'agent', version: 'current', reason: null })

beforeEach(() => {
  vi.clearAllMocks()
  const id = `auto-${++sequence}`
  project = { id, connection_id: id, path: `ssh://${id}/project`, name: 'Project', kind: 'ssh', created_at: 1, last_opened_at: 1 }
  ssh = { id, name: 'SSH', host: 'localhost', port: 22, username: 'dev', auth_kind: 'privateKey', private_key_path: '/key', host_key_fingerprint: 'SHA256:confirmed', created_at: 1 }
  mocks.trusted.mockReturnValue(true)
  mocks.info.mockResolvedValue({ enabled: true, host: 'localhost' })
  mocks.list.mockImplementation(async () => [ssh])
  mocks.settings.mockResolvedValue({ autoDownload: true, offlineDir: '/offline' })
  mocks.prepare.mockResolvedValue({ expectedVersion: 'current', packageVersion: 'current', directory: '/offline', problem: null })
  mocks.update.mockImplementation(async () => ready())
  mocks.invoke.mockImplementation(async (_label, command) => {
    if (command === 'ssh_prepare_workspace') throw mismatch
  })
  useServerOperationStore.setState({ tasks: {} })
})

const run = () => prepareSshWorkspace(project.path, new AbortController().signal, () => {}, { project, background: true })

describe('first-open automatic paired Server update', () => {
  it('prepares a local package, updates, then retries readiness without changing transport', async () => {
    let preparations = 0
    mocks.invoke.mockImplementation(async (_label, command) => {
      if (command === 'ssh_prepare_workspace' && preparations++ === 0) throw mismatch
    })
    await run()
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ packageSource: { mode: 'offline', directory: '/offline' }, sshConnectionId: ssh.id }), expect.any(Function))
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ packageDirectory: '/offline', rootUri: project.path }), expect.any(Function))
    expect(preparations).toBe(2)
    expect(useServerOperationStore.getState().tasks[project.path].finishedAt).toBeDefined()
  })

  it('shares one attempt across concurrent roots and never loops after failure', async () => {
    mocks.update.mockRejectedValue(new Error('SSH authentication failed'))
    const results = await Promise.allSettled([run(), run()])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    await expect(run()).rejects.toThrow('SSH authentication failed')
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledTimes(1)
  })

  it('only inspects local packages even when automatic download is enabled in settings', async () => {
    mocks.settings.mockResolvedValue({ autoDownload: true, offlineDir: '' })
    mocks.prepare.mockResolvedValue({ expectedVersion: 'current', packageVersion: null, directory: null, problem: '缺少本机包' })
    await expect(run()).rejects.toThrow('缺少本机包')
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ packageSource: { mode: 'automatic', allowDownload: false } }), expect.any(Function))
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('never updates a mismatched local version even when the backend omitted a problem', async () => {
    mocks.prepare.mockResolvedValue({ expectedVersion: 'current', packageVersion: 'old', directory: '/offline', problem: null })
    await expect(run()).rejects.toThrow('校验')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each(['password', 'fingerprint', 'otherHost', 'ambiguous'])('keeps the manual path when %s prevents safe automatic authorization', async condition => {
    if (condition === 'password') ssh.auth_kind = 'password'
    if (condition === 'fingerprint') ssh.host_key_fingerprint = ''
    if (condition === 'otherHost') ssh.host = 'other-host'
    if (condition === 'ambiguous') mocks.list.mockImplementation(async () => [{ ...ssh, id: 'a' }, { ...ssh, id: 'b' }])
    await expect(run()).rejects.toThrow('SSH 连接')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('does not update untrusted projects, SSH-only profiles, or transport failures', async () => {
    mocks.trusted.mockReturnValue(false)
    await expect(run()).rejects.toThrow('版本不匹配')
    expect(mocks.prepare).not.toHaveBeenCalled()
    mocks.trusted.mockReturnValue(true)
    mocks.info.mockResolvedValue(null)
    await expect(run()).rejects.toThrow('版本不匹配')
    mocks.invoke.mockRejectedValue(new Error('TLS identity changed'))
    await expect(run()).rejects.toThrow('TLS identity changed')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('checks cancellation and trust again after package preparation', async () => {
    mocks.prepare.mockImplementation(async () => {
      mocks.trusted.mockReturnValue(false)
      return { expectedVersion: 'current', packageVersion: 'current', directory: '/offline', problem: null }
    })
    await expect(run()).rejects.toThrow('授权')
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
