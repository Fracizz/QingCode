// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), trusted: vi.fn(), ready: vi.fn(), retention: vi.fn(),
  tasks: [] as unknown[],
}))
vi.mock('./tauri', () => ({ isTauri: () => true, safeInvoke: mocks.invoke }))
vi.mock('./workspaceTrust', () => ({ isProjectTrusted: mocks.trusted }))
vi.mock('./sshWorkspace', () => ({
  isSshProject: (project: Project) => project.path.startsWith('ssh://'),
  isSshWorkspaceReady: mocks.ready,
}))
vi.mock('./terminal/terminalPasteCleanupSettings', () => ({
  loadScopedTerminalPasteRetentionDays: mocks.retention,
}))
vi.mock('../store/transferStore', () => ({
  isTransferActive: (status: string) => ['queued', 'running', 'cancelling'].includes(status),
  useTransferStore: { getState: () => ({ tasks: mocks.tasks }) },
}))
vi.mock('../store/projectStore', () => ({ useProjectStore: { getState: vi.fn() } }))
import { cleanupTerminalPaste, scheduleTerminalPasteCleanup } from './terminalPasteCleanup'

const local: Project = { id: 'p', name: 'app', path: '/workspace/app', created_at: 1, last_opened_at: 1 }
const ssh: Project = { ...local, path: 'ssh://c1/home/app', kind: 'ssh', connection_id: 'c1' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.trusted.mockReturnValue(true)
  mocks.ready.mockResolvedValue(true)
  mocks.retention.mockResolvedValue(7)
  mocks.invoke.mockResolvedValue(1)
  mocks.tasks = []
})
afterEach(async () => {
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('paste cleanup on project open', () => {
  it('defers all settings and filesystem work and does not repeat while idle', async () => {
    expect(scheduleTerminalPasteCleanup(local)).toBeUndefined()
    scheduleTerminalPasteCleanup(local)
    expect(mocks.retention).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2999)
    expect(mocks.invoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('清理粘贴文件', 'cleanup_terminal_paste', {
      path: local.path, retentionDays: 7, excludedPaths: [],
    })
    await vi.advanceTimersByTimeAsync(86400000)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    scheduleTerminalPasteCleanup(local)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('does nothing when disabled, untrusted or ephemeral', async () => {
    mocks.retention.mockResolvedValue(0)
    scheduleTerminalPasteCleanup(local)
    await vi.runAllTimersAsync()
    expect(mocks.invoke).not.toHaveBeenCalled()
    mocks.trusted.mockReturnValue(false)
    scheduleTerminalPasteCleanup(local)
    await vi.runAllTimersAsync()
    expect(mocks.retention).toHaveBeenCalledTimes(1)
    scheduleTerminalPasteCleanup({ ...local, ephemeral: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('skips disconnected SSH projects before reading remote settings', async () => {
    mocks.ready.mockResolvedValue(false)
    scheduleTerminalPasteCleanup(ssh)
    await vi.runAllTimersAsync()
    expect(mocks.retention).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('checks trust again after settings load and excludes active uploads', async () => {
    mocks.retention.mockImplementationOnce(async () => {
      mocks.trusted.mockReturnValue(false)
      return 7
    })
    scheduleTerminalPasteCleanup(local)
    await vi.runAllTimersAsync()
    expect(mocks.invoke).not.toHaveBeenCalled()
    mocks.trusted.mockReturnValue(true)
    const destination = `${ssh.path}/.qingcode/terminal-paste/active`
    mocks.tasks = [
      { status: 'running', request: { direction: 'upload', destination } },
      { status: 'completed', request: { direction: 'upload', destination: 'finished' } },
    ]
    await cleanupTerminalPaste(ssh, 7)
    expect(mocks.invoke).toHaveBeenCalledWith('清理粘贴文件', 'cleanup_terminal_paste', {
      path: ssh.path, retentionDays: 7, excludedPaths: [destination],
    })
  })

  it('contains background failures and allows checking on the next open', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.invoke.mockRejectedValueOnce(new Error('connection lost'))
    scheduleTerminalPasteCleanup(local)
    await vi.runAllTimersAsync()
    expect(warning).toHaveBeenCalledTimes(1)
    scheduleTerminalPasteCleanup(local)
    await vi.runAllTimersAsync()
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    warning.mockRestore()
  })
})
