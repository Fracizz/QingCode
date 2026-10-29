import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
const mocks = vi.hoisted(() => ({ open: vi.fn(), invoke: vi.fn(), load: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('./tauri', () => ({ safeInvoke: mocks.invoke, isTauri: () => true }))
vi.mock('./projectSettings', async () => ({ ...await vi.importActual('./projectSettings'), loadProjectSettings: mocks.load, saveProjectSettings: mocks.save }))
import { recoverServerPackage } from './sshServerRecovery'
const project: Project = { id: 'failed', name: 'failed', path: 'ssh://c/home/failed', kind: 'ssh', created_at: 1, last_opened_at: 1 }
const valid = { expectedVersion: '0.1.14-beta.9', packageVersion: '0.1.14-beta.9', sourcePath: '/new/servers/qingcode-server-x86_64', directory: '/new/servers', problem: null }
const previous = { version: 1, custom: { keep: true }, 'ssh.server.offlineDir': '/old', 'ssh.server.autoDownload': false }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockReset().mockResolvedValue('/new')
  mocks.invoke.mockReset().mockImplementation(async (_action, command) => command === 'ssh_reset_server_failure' ? undefined : valid)
  mocks.load.mockReset().mockResolvedValue(previous)
  mocks.save.mockReset().mockResolvedValue(undefined)
})
describe('server package recovery', () => {
  it('rejects a wrong version without changing settings or clearing failures', async () => {
    mocks.invoke.mockResolvedValue({ ...valid, packageVersion: 'old', problem: '版本不匹配' })
    const onInfo = vi.fn()
    await expect(recoverServerPackage(project, 'choose', new AbortController().signal, onInfo)).rejects.toThrow('版本不匹配')
    expect(onInfo).toHaveBeenCalledWith(expect.objectContaining({ packageVersion: 'old' }))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalledWith(expect.anything(), 'ssh_reset_server_failure', expect.anything())
  })
  it('canceling the picker preserves settings and does not prepare a service', async () => {
    mocks.open.mockResolvedValue(null)
    expect(await recoverServerPackage(project, 'choose', new AbortController().signal, vi.fn())).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('updates only the failed project after validation and preserves unrelated values', async () => {
    expect(await recoverServerPackage(project, 'choose', new AbortController().signal, vi.fn())).toBe(true)
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(project, { ...previous, 'ssh.server.offlineDir': '/new/servers' })
    expect(previous['ssh.server.offlineDir']).toBe('/old')
    expect(mocks.invoke).toHaveBeenLastCalledWith('清除远端服务失败状态', 'ssh_reset_server_failure', { rootUri: project.path })
  })
  it('forces a client download before changing settings and selects its verified cache', async () => {
    await recoverServerPackage(project, 'download', new AbortController().signal, vi.fn())
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, '下载远端服务包', 'ssh_download_server_package', { rootUri: project.path })
    expect(mocks.save).toHaveBeenCalledWith(project, expect.objectContaining({ 'ssh.server.offlineDir': '/new/servers', 'ssh.server.autoDownload': true }))
  })
  it('download failure leaves the existing package selection intact', async () => {
    mocks.invoke.mockRejectedValue(new Error('network offline'))
    await expect(recoverServerPackage(project, 'download', new AbortController().signal, vi.fn())).rejects.toThrow('network offline')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('ignores a download that finishes after the opening was closed', async () => {
    let finish!: (value: typeof valid) => void
    mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const onInfo = vi.fn()
    const pending = recoverServerPackage(project, 'download', controller.signal, onInfo)
    controller.abort()
    finish(valid)
    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
    expect(onInfo).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('propagates persistence failure so the dialog cannot retry with unsaved settings', async () => {
    mocks.save.mockRejectedValue(new Error('disk full'))
    await expect(recoverServerPackage(project, 'choose', new AbortController().signal, vi.fn())).rejects.toThrow('disk full')
    expect(previous['ssh.server.offlineDir']).toBe('/old')
  })
})
