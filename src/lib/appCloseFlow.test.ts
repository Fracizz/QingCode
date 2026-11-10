// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { appExitTerminals, runAppClose, type AppCloseDependencies } from './appCloseFlow'
import type { TerminalTab } from '../types'

vi.mock('./i18n', () => ({ translate: (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? key)),
}))

function tab(id: string, remote = true, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id, name: id, projectId: id, cwd: remote ? `ssh://conn/${id}` : `/tmp/${id}`,
    launchCommand: '', status: 'running', exitCode: null,
    ...(remote ? { persistent: true, ptyId: `pty-${id}`, connectionId: 'conn' } : {}), ...overrides }
}

function fixture(tabs: TerminalTab[], decisions = ['preserve']) {
  const events: string[] = []
  const deps: AppCloseDependencies = {
    pauseSpawns: vi.fn(async () => { events.push('pause') }),
    resumeSpawns: vi.fn(() => { events.push('resume') }),
    terminals: () => tabs,
    transferCount: () => 0,
    choose: vi.fn(async () => decisions.shift() ?? null),
    confirmFiles: vi.fn(async () => { events.push('files'); return true }),
    finishRemote: vi.fn(async (tab, action) => { events.push(`${action}:${tab.id}`) }),
    closeTerminal: vi.fn(async tab => { events.push(`close:${tab.id}`) }),
    markEnded: vi.fn(tab => { events.push(`ended:${tab.id}`); Object.assign(tab, { status: 'exited', endedAt: 123 }) }),
    markDetached: vi.fn(tab => { events.push(`detached:${tab.id}`) }),
    flush: vi.fn(() => { events.push('flush') }),
    destroy: vi.fn(async () => { events.push('destroy') }),
  }
  return { deps, events }
}

describe('app close decisions', () => {
  it('preserves all persistent sessions including idle and unrestored ones, closes local/compat shells', async () => {
    const tabs = [tab('idle'), tab('restore', true, { status: 'exited', awaitingRestoreSpawn: true }),
      tab('local', false), tab('compat', true, { persistent: false, ptyId: undefined })]
    const { deps, events } = fixture(tabs)
    await runAppClose(deps)
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('24 小时'),
      options: expect.arrayContaining([expect.objectContaining({ id: 'preserve', primary: true })]) }))
    expect(deps.finishRemote).toHaveBeenCalledTimes(2)
    expect(deps.finishRemote).toHaveBeenCalledWith(tabs[0], 'preserve')
    expect(deps.finishRemote).toHaveBeenCalledWith(tabs[1], 'preserve')
    expect(events.indexOf('files')).toBeLessThan(events.indexOf('close:local'))
    expect(events.indexOf('flush')).toBeLessThan(events.indexOf('destroy'))
    expect(deps.markEnded).toHaveBeenCalledTimes(2)
  })

  it.each(['cancel', null])('does nothing on dismissal (%s)', async decision => {
    const { deps } = fixture([tab('remote')])
    vi.mocked(deps.choose).mockResolvedValue(decision)
    await runAppClose(deps)
    expect(deps.confirmFiles).not.toHaveBeenCalled()
    expect(deps.finishRemote).not.toHaveBeenCalled()
    expect(deps.destroy).not.toHaveBeenCalled()
    expect(deps.resumeSpawns).toHaveBeenCalledOnce()
  })

  it('does not terminate or detach when the save dialog is cancelled', async () => {
    const { deps } = fixture([tab('remote'), tab('local', false)], ['terminate'])
    vi.mocked(deps.confirmFiles).mockResolvedValue(false)
    await runAppClose(deps)
    expect(deps.finishRemote).not.toHaveBeenCalled()
    expect(deps.closeTerminal).not.toHaveBeenCalled()
    expect(deps.destroy).not.toHaveBeenCalled()
  })

  it('marks confirmed kills ended before persisting, leaving no live PTY to reattach', async () => {
    const tabs = [tab('remote'), tab('other-project')]
    const { deps, events } = fixture(tabs, ['terminate'])
    await runAppClose(deps)
    expect(deps.finishRemote).toHaveBeenCalledTimes(2)
    expect(deps.finishRemote).toHaveBeenCalledWith(tabs[0], 'terminate')
    expect(deps.markDetached).not.toHaveBeenCalled()
    expect(events.indexOf('ended:remote')).toBeLessThan(events.indexOf('flush'))
  })

  it('retries only failures and never repeats acknowledged kills', async () => {
    const tabs = [tab('ok'), tab('offline')]
    const { deps } = fixture(tabs, ['terminate', 'retry'])
    vi.mocked(deps.finishRemote).mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    await runAppClose(deps)
    expect(deps.finishRemote).toHaveBeenCalledTimes(3)
    expect(deps.finishRemote).toHaveBeenNthCalledWith(3, tabs[1], 'terminate')
    expect(deps.choose).toHaveBeenLastCalledWith(expect.objectContaining({ title: '部分终端未确认结束' }))
    expect(deps.destroy).toHaveBeenCalledOnce()
  })

  it('keeps an uncertain PTY recoverable when exiting after failure', async () => {
    const remote = tab('offline')
    const { deps } = fixture([remote], ['terminate', 'exit'])
    vi.mocked(deps.finishRemote).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    await runAppClose(deps)
    expect(deps.markEnded).not.toHaveBeenCalled()
    expect(deps.finishRemote).toHaveBeenLastCalledWith(remote, 'preserve')
    expect(deps.markDetached).toHaveBeenCalledWith(remote)
    expect(remote.ptyId).toBe('pty-offline')
    expect(deps.destroy).toHaveBeenCalledOnce()
  })

  it('cancels after failure without detaching the remaining live process', async () => {
    const { deps } = fixture([tab('offline')], ['terminate', 'cancel'])
    vi.mocked(deps.finishRemote).mockRejectedValue(new Error('offline'))
    await runAppClose(deps)
    expect(deps.markEnded).not.toHaveBeenCalled()
    expect(deps.markDetached).not.toHaveBeenCalled()
    expect(deps.destroy).not.toHaveBeenCalled()
  })

  it('unfreezes after spawn-settle or window-destroy failure', async () => {
    const { deps } = fixture([tab('remote')])
    vi.mocked(deps.pauseSpawns).mockRejectedValueOnce(new Error('still starting'))
    await expect(runAppClose(deps)).rejects.toThrow('still starting')
    expect(deps.choose).not.toHaveBeenCalled()
    expect(deps.resumeSpawns).toHaveBeenCalledOnce()
    vi.mocked(deps.destroy).mockRejectedValueOnce(new Error('window unavailable'))
    await expect(runAppClose(deps)).rejects.toThrow('window unavailable')
    expect(deps.resumeSpawns).toHaveBeenCalledTimes(2)
  })

  it('offers ordinary exit without preserve for local-only windows', async () => {
    const { deps } = fixture([tab('local', false)], ['terminate'])
    await runAppClose(deps)
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({ options: [
      expect.objectContaining({ id: 'cancel' }), expect.objectContaining({ id: 'terminate', label: '退出' }),
    ] }))
  })

  const hosted = (id: string, overrides: Partial<TerminalTab> = {}) =>
    tab(id, false, { persistent: true, ptyId: `pty-${id}`, connectionId: '__local__', ...overrides })

  it('offers to keep locally hosted terminals and detaches them instead of closing', async () => {
    const tabs = [hosted('kept'), tab('plain', false)]
    const { deps, events } = fixture(tabs)
    await runAppClose(deps)
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('1 个本地终端可以保留'),
      options: expect.arrayContaining([
        expect.objectContaining({ id: 'preserve', label: '保留本地终端并退出', primary: true }),
        expect.objectContaining({ id: 'terminate', label: '结束本地终端并退出', danger: true }),
      ]),
    }))
    expect(deps.finishRemote).toHaveBeenCalledExactlyOnceWith(tabs[0], 'preserve')
    expect(deps.markDetached).toHaveBeenCalledExactlyOnceWith(tabs[0])
    expect(events).toContain('close:plain')
    expect(events).not.toContain('close:kept')
  })

  it('confirms termination of locally hosted terminals through the host', async () => {
    const tabs = [hosted('gone')]
    const { deps, events } = fixture(tabs, ['terminate'])
    await runAppClose(deps)
    expect(deps.finishRemote).toHaveBeenCalledWith(tabs[0], 'terminate')
    expect(deps.closeTerminal).not.toHaveBeenCalled()
    expect(events).toContain('ended:gone')
  })

  it('does not promise to keep local terminals whose host ends with the app', async () => {
    const tabs = [tab('remote'), hosted('tied')]
    const { deps, events } = fixture(tabs)
    deps.localHostSurvivesExit = vi.fn(async () => false)
    await runAppClose(deps)
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('1 个本地终端无法保留'),
      options: expect.arrayContaining([expect.objectContaining({ id: 'preserve', label: '保留远程终端并退出' })]),
    }))
    // 宿主里的进程仍经宿主确认结束，下次启动按原配置新建而不是去接回。
    expect(deps.finishRemote).toHaveBeenCalledWith(tabs[1], 'terminate')
    expect(events).toContain('ended:tied')
    expect(deps.finishRemote).toHaveBeenCalledWith(tabs[0], 'preserve')
    expect(deps.markDetached).toHaveBeenCalledExactlyOnceWith(tabs[0])
  })

  it('keeps local terminals when the host lookup fails', async () => {
    const tabs = [hosted('kept')]
    const { deps } = fixture(tabs)
    deps.localHostSurvivesExit = vi.fn(async () => { throw new Error('ipc down') })
    await runAppClose(deps)
    expect(deps.finishRemote).toHaveBeenCalledExactlyOnceWith(tabs[0], 'preserve')
  })

  it('names both kinds when remote and local terminals can be kept', async () => {
    const { deps } = fixture([tab('remote'), hosted('local')])
    await runAppClose(deps)
    expect(deps.choose).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({ id: 'preserve', label: '保留终端并退出' })]),
    }))
  })

  it('ignores ended and not-yet-created tabs, but includes temporarily unavailable persistent PTYs', () => {
    const unrestored = tab('unavailable', true, { status: 'exited', restoreUnavailable: true })
    expect(appExitTerminals([tab('ended', true, { status: 'exited', endedAt: 123 }),
      tab('pending', false, { status: 'starting', ptySpawnPending: true }), unrestored])).toEqual([unrestored])
  })
})
