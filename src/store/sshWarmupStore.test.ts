// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import { SSH_WARMUP_DELAY_MS } from '../lib/sshWarmupQueue'

const mocks = vi.hoisted(() => ({
  connected: vi.fn(),
  prepare: vi.fn(),
  tree: vi.fn(),
  trusted: vi.fn(),
  suspended: vi.fn(),
}))
vi.mock('../lib/fileTreeCache', () => ({ loadWarmupRootTree: mocks.tree }))
vi.mock('../lib/workspaceTrust', () => ({ isProjectTrusted: mocks.trusted }))
vi.mock('../lib/sshWorkspace', () => ({
  ensureSshWorkspaceConnected: mocks.connected,
  prepareSshWorkspace: mocks.prepare,
  isSshBackgroundSuspended: mocks.suspended,
}))
import {
  startSshWarmupQueue,
  stopSshWarmupQueue,
  takeSshWarmup,
  useSshWarmupStore,
} from './sshWarmupStore'
const project: Project = { id: 'a', name: 'a', path: 'ssh://c/a', created_at: 1, last_opened_at: 1 }
let queue: ReturnType<typeof startSshWarmupQueue>
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mocks.trusted.mockReturnValue(true)
  mocks.suspended.mockReturnValue(false)
  mocks.tree.mockResolvedValue([])
  queue = startSshWarmupQueue()
})
afterEach(() => {
  stopSshWarmupQueue(queue)
  vi.useRealTimers()
})

describe('passive SSH preparation', () => {
  it('uses passive registration, preparation and a bounded root read without activating editor sessions', async () => {
    queue.update([{ project, connectionId: 'c', version: 'v1' }])
    await vi.runAllTimersAsync()
    expect(mocks.connected).toHaveBeenCalledWith(project, {
      background: true,
      signal: expect.any(AbortSignal),
    })
    expect(mocks.prepare).toHaveBeenCalledWith(
      project.path,
      expect.any(AbortSignal),
      expect.any(Function),
      { project, background: true }
    )
    expect(mocks.tree).toHaveBeenCalledWith(project)
    expect(await takeSshWarmup(project.path)).toEqual([])
    expect(useSshWarmupStore.getState().statuses.get(project.path)?.phase).toBe('ready')
  })

  it('stops before deployment when trust is revoked during authentication', async () => {
    let finish!: () => void
    mocks.connected.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    queue.update([{ project, connectionId: 'c', version: 'v1' }])
    await vi.advanceTimersByTimeAsync(SSH_WARMUP_DELAY_MS)
    mocks.trusted.mockReturnValue(false)
    finish()
    await vi.runAllTimersAsync()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.tree).not.toHaveBeenCalled()
  })

  it('does not reconnect a deliberately disconnected host', async () => {
    mocks.suspended.mockReturnValue(true)
    queue.update([{ project, connectionId: 'c', version: 'v1' }])
    await vi.runAllTimersAsync()
    expect(mocks.connected).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
