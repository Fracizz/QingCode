// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { Project, SshConnection } from '../types'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), prepare: vi.fn(), toast: vi.fn(), backend: vi.fn(() => true),
  restore: vi.fn(() => true), trusted: vi.fn((_project: Project) => true), suspended: vi.fn((_id: string) => false),
}))
const connection = (id: string, direct = true): SshConnection => ({
  id, name: id, host: id, username: 'user', port: 22, auth_kind: 'privateKey',
  host_key_fingerprint: 'SHA256:confirmed', created_at: 0,
  ...(direct ? { agentEndpoint: { host: id, port: 48763 } } : {}),
})
const project = (id: string, host = 'a', time = 1): Project => ({
  id, name: id, path: `ssh://${host}/${id}`, kind: 'ssh', connection_id: host,
  created_at: 0, last_opened_at: time,
})
const projects = [project('first'), project('recent', 'a', 2), project('other', 'b')]
const store = create(() => ({ projects, sshConnections: [connection('a'), connection('b')], pushToast: mocks.toast }))
const ui = create(() => ({ serverUpdateRootUri: null as string | null }))
vi.mock('../store/projectStore', () => ({ useProjectStore: store }))
vi.mock('../store/uiStore', () => ({ useUIStore: ui }))
vi.mock('../lib/runtimeCapabilities', () => ({ hasBackend: mocks.backend }))
vi.mock('../lib/windowSession', () => ({ shouldRestoreWorkspace: mocks.restore }))
vi.mock('../lib/workspaceTrust', () => ({ createProjectTrustChecker: () => mocks.trusted, isProjectTrusted: mocks.trusted }))
vi.mock('../lib/sshWorkspace', () => ({
  ensureSshWorkspaceConnected: mocks.connect, prepareSshWorkspace: mocks.prepare,
  isSshBackgroundSuspended: mocks.suspended, sshConnectionIdFromUri: (path: string) => path.match(/^ssh:\/\/([^/]+)/)?.[1],
  SSH_SERVER_UPDATED_EVENT: 'server-updated',
}))
const { useStartupServerUpdates, startupServerTargets } = await import('./useStartupServerUpdates')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.backend.mockReturnValue(true)
  mocks.restore.mockReturnValue(true)
  mocks.trusted.mockReturnValue(true)
  mocks.suspended.mockReturnValue(false)
  mocks.connect.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue(undefined)
  store.setState({ projects, sshConnections: [connection('a'), connection('b')] })
  ui.setState({ serverUpdateRootUri: null })
})
afterEach(cleanup)

describe('startup Server maintenance', () => {
  it('selects one recent trusted root per direct connection, including hidden projects', () => {
    const hidden = { ...project('hidden', 'a', 3), hidden: 1 as const }
    const selected = startupServerTargets([...projects, hidden, project('plain', 'ssh'), project('denied', 'c')],
      [connection('a'), connection('b'), connection('ssh', false), connection('c')], p => p.id !== 'denied')
    expect(selected.map(p => p.id)).toEqual(['hidden', 'other'])
  })

  it('runs at startup after projects load with no dialog or project switch, once in StrictMode', async () => {
    const view = renderHook(({ ready }) => useStartupServerUpdates(ready), { initialProps: { ready: false }, wrapper: StrictMode })
    await act(async () => {})
    expect(mocks.connect).not.toHaveBeenCalled()
    view.rerender({ ready: true })
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2))
    expect(mocks.connect).toHaveBeenCalledWith(projects[1], expect.objectContaining({ background: true }))
    expect(mocks.prepare).toHaveBeenCalledWith(projects[1].path, expect.any(AbortSignal), expect.any(Function), { project: projects[1], background: true })
    view.rerender({ ready: true })
    await act(async () => {})
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(ui.getState().serverUpdateRootUri).toBeNull()
  })

  it('checks connections sequentially and continues after an unreachable host', async () => {
    let fail!: (error: Error) => void
    mocks.connect.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    renderHook(() => useStartupServerUpdates(true))
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    expect(mocks.prepare).not.toHaveBeenCalled()
    await act(async () => { fail(new Error('unreachable')) })
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1))
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(ui.getState().serverUpdateRootUri).toBeNull()
  })

  it('skips untrusted or explicitly disconnected connections and rechecks trust after registration', async () => {
    mocks.suspended.mockImplementation(id => id === 'b')
    mocks.connect.mockImplementation(async () => { mocks.trusted.mockReturnValue(false) })
    renderHook(() => useStartupServerUpdates(true))
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it.each(['fresh', 'browser'])('does not scan in a %s window', async mode => {
    if (mode === 'fresh') mocks.restore.mockReturnValue(false)
    else mocks.backend.mockReturnValue(false)
    renderHook(() => useStartupServerUpdates(true))
    await act(async () => {})
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('reports a completed restore-time update before the startup scan is ready and closes only its own recovery dialog', async () => {
    const view = renderHook(() => useStartupServerUpdates(false))
    ui.setState({ serverUpdateRootUri: projects[0].path })
    act(() => window.dispatchEvent(new CustomEvent('server-updated', { detail: { rootUri: projects[0].path, name: 'Host A' } })))
    expect(mocks.toast).toHaveBeenCalledWith('success', '已自动更新 Host A 的远端服务')
    expect(ui.getState().serverUpdateRootUri).toBeNull()
    ui.setState({ serverUpdateRootUri: projects[1].path })
    act(() => window.dispatchEvent(new CustomEvent('server-updated', { detail: { rootUri: projects[0].path, name: 'Host A' } })))
    expect(ui.getState().serverUpdateRootUri).toBe(projects[1].path)
    view.unmount()
    window.dispatchEvent(new CustomEvent('server-updated', { detail: { rootUri: projects[0].path, name: 'Host A' } }))
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })

  it('cancels registration before service preparation when the app coordinator unmounts', async () => {
    let finish!: () => void
    mocks.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const view = renderHook(() => useStartupServerUpdates(true))
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => { finish() })
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.connect).toHaveBeenCalledTimes(1)
  })
})
