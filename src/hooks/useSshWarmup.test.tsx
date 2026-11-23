// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { Project, SshConnection } from '../types'

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => []),
  listen: vi.fn(async () => () => {}),
}))
const projects: Project[] = [1, 2].map(index => ({
  id: String(index), name: String(index), path: `ssh://host/p${index}`,
  created_at: 0, last_opened_at: index,
}))
const connection: SshConnection = {
  id: 'host', name: 'host', host: 'host', port: 22, username: 'test',
  auth_kind: 'password', host_key_fingerprint: 'SHA256:test', created_at: 0, updated_at: 0,
}
const store = create(() => ({ projects, sshConnections: [connection], currentProject: projects[0] }))
vi.mock('../store/projectStore', () => ({ useProjectStore: store }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../lib/runtimeCapabilities', () => ({ hasBackend: () => true }))
vi.mock('../lib/windowSession', () => ({ shouldRestoreWorkspace: () => true }))
vi.mock('../lib/workspaceTrust', () => ({
  createProjectTrustChecker: () => () => true,
  isProjectTrusted: () => true,
  WORKSPACE_TRUST_CHANGED_EVENT: 'trust-changed',
}))
vi.mock('../lib/sshWorkspace', () => ({
  ensureSshWorkspaceConnected: vi.fn(),
  prepareSshWorkspace: mocks.run,
  isSshBackgroundSuspended: () => false,
  SSH_CONNECTION_INVALIDATED_EVENT: 'connection-invalidated',
  SSH_SERVER_UPDATED_EVENT: 'server-updated',
}))
vi.mock('../lib/fileTreeCache', () => ({ loadWarmupRootTree: async () => [] }))

const { useSshWarmup } = await import('./useSshWarmup')
const { useSshWarmupStore } = await import('../store/sshWarmupStore')

beforeEach(() => {
  vi.useFakeTimers()
  mocks.run.mockClear()
  store.setState({ projects, currentProject: projects[0] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('keeps both opened and warmed projects ready after switching and reloading the project list', async () => {
  renderHook(() => useSshWarmup(true))
  await act(() => vi.runAllTimersAsync())
  expect(mocks.run).toHaveBeenCalledTimes(1)
  for (const project of [projects[1], projects[0], projects[1]]) {
    act(() => store.setState({ currentProject: project, projects: [...projects] }))
    await act(() => vi.runAllTimersAsync())
    for (const target of projects) {
      expect(useSshWarmupStore.getState().statuses.get(target.path)?.phase).toBe('ready')
    }
  }
  expect(mocks.run).toHaveBeenCalledTimes(1)
})

it('re-prepares a connection right after its server update completes', async () => {
  store.setState({ projects, currentProject: undefined as unknown as Project })
  mocks.run.mockRejectedValueOnce(new Error('gateway restarting'))
  renderHook(() => useSshWarmup(true))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(useSshWarmupStore.getState().statuses.get(projects[1].path)?.phase).toBe('failed')
  act(() => {
    window.dispatchEvent(new CustomEvent('server-updated', { detail: { rootUri: projects[0].path, name: 'host', connectionId: 'host' } }))
  })
  // 不等 10 秒失败退避：同连接项目立即并发重新准备。
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(mocks.run).toHaveBeenCalledTimes(3)
  for (const target of projects) {
    expect(useSshWarmupStore.getState().statuses.get(target.path)?.phase).toBe('ready')
  }
})
