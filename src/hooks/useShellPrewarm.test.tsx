// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  localCodex: vi.fn(() => undefined as { id: string; shell: string; command: string } | undefined),
  preset: vi.fn((_connection: string) => undefined as { id: string; command: string; shell: string } | undefined),
  onFocusChanged: vi.fn(async (_listener: (event: { payload: boolean }) => void) => () => {}),
  invoke: vi.fn(async (..._args: unknown[]) => 0), count: vi.fn(async () => 'auto' as 'auto' | number),
  persist: vi.fn(async () => true), trusted: vi.fn(() => true), platform: vi.fn(() => 'win'),
}))
vi.mock('../lib/terminal/localCodexPrewarm', () => ({
  LOCAL_CODEX_PREWARM_KEY: 'local-codex', localCodexPrewarm: mocks.localCodex,
}))
vi.mock('../lib/terminal/connectionPrewarmProfile', () => ({
  connectionPrewarmAnchors: () => [], CONNECTION_PREWARM_PREFIX: 'profile:', connectionPrewarmProfile: mocks.preset,
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: mocks.onFocusChanged, listen: () => Promise.resolve(() => {}) }) }))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, safeInvoke: mocks.invoke }))
vi.mock('../lib/workspaceTrust', () => ({ isProjectTrusted: mocks.trusted, WORKSPACE_TRUST_CHANGED_EVENT: 'trust-changed', WORKSPACE_TRUST_SYNCED_EVENT: 'trust-synced' }))
vi.mock('../lib/terminal/shellPrewarmSettings', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/terminal/shellPrewarmSettings')>(),
  loadShellPrewarmCount: mocks.count,
}))
vi.mock('../lib/terminal/terminalPersistLocalSettings', () => ({ loadEffectiveTerminalPersistLocalSessions: mocks.persist }))
vi.mock('../lib/terminal/terminalProfiles', () => ({ getPrewarmShell: () => 'auto', TERMINAL_PROFILES_KEY: 'profiles' }))
vi.mock('../lib/terminal/terminalShell', () => ({ detectTerminalHostPlatform: mocks.platform }))
import { notifyShellPrewarmChanged, SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import { useShellPrewarm } from './useShellPrewarm'
const project: Project = { id: 'one', name: 'One', path: 'D:/work/one' }
const configuredPaths = () => mocks.invoke.mock.calls.map(call => (call[2] as { cwd: string | null }).cwd)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.preset.mockReset()
  mocks.localCodex.mockReset()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  mocks.count.mockResolvedValue('auto')
  mocks.persist.mockResolvedValue(true)
  mocks.trusted.mockReturnValue(true)
  mocks.platform.mockReturnValue('win')
})

describe('Windows prewarm coordinator', () => {
  it('prepares the trusted project and invalidates it on trust revocation and hosting opt-out', async () => {
    const hook = renderHook(() => useShellPrewarm(project))
    await waitFor(() => expect(configuredPaths()).toContain(project.path))
    mocks.trusted.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('trust-changed')))
    await waitFor(() => expect(configuredPaths().at(-1)).toBeNull())
    mocks.trusted.mockReturnValue(true)
    mocks.persist.mockResolvedValue(false)
    act(() => notifyShellPrewarmChanged())
    await act(async () => {})
    expect(configuredPaths().filter(path => path === project.path)).toHaveLength(1)
    hook.unmount()
    await act(async () => {})
  })

  it('keeps the local Codex profile across project changes, including a window with no project', async () => {
    mocks.localCodex.mockReturnValue({ id: 'ai', shell: 'pwsh', command: 'codex' })
    const hook = renderHook(({ value }: { value: Project | null }) => useShellPrewarm(value), { initialProps: { value: null as Project | null } })
    const profile = { profileId: 'ai', shell: 'pwsh', command: 'codex' }
    await waitFor(() => expect(mocks.invoke.mock.lastCall?.[2]).toMatchObject({ cwd: null, localProfile: profile }))
    hook.rerender({ value: project })
    await waitFor(() => expect(mocks.invoke.mock.lastCall?.[2]).toMatchObject({ cwd: project.path, localProfile: profile }))
    mocks.persist.mockResolvedValue(false)
    act(() => notifyShellPrewarmChanged())
    await waitFor(() => expect(mocks.invoke.mock.lastCall?.[2]).not.toHaveProperty('localProfile'))
    hook.unmount()
  })

  it('discards late settings from a previous project without clearing the new pool', async () => {
    let resolve!: (value: 'auto' | number) => void
    mocks.count.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const hook = renderHook(({ value }) => useShellPrewarm(value), { initialProps: { value: project } })
    await waitFor(() => expect(resolve).toBeDefined())
    const next = { ...project, id: 'two', path: 'D:/work/two' }
    hook.rerender({ value: next })
    await waitFor(() => expect(configuredPaths()).toContain(next.path))
    await act(async () => resolve(8))
    expect(configuredPaths()).not.toContain(project.path)
    expect(configuredPaths().at(-1)).toBe(next.path)
    hook.unmount()
    await act(async () => {})
  })

  it('switching projects reconfigures without clearing, so same-host ready shells survive', async () => {
    const hook = renderHook(({ value }) => useShellPrewarm(value), { initialProps: { value: project } })
    await waitFor(() => expect(configuredPaths()).toContain(project.path))
    mocks.invoke.mockClear()
    const next = { ...project, id: 'two', path: 'D:/work/two' }
    hook.rerender({ value: next })
    await waitFor(() => expect(configuredPaths()).toEqual([next.path]))
    // 临时项目自动信任，同样预热。
    mocks.invoke.mockClear()
    mocks.trusted.mockReturnValue(false)
    const scratch = { ...next, id: 'tmp', path: 'D:/temp/qingcode-empty-1', ephemeral: true }
    hook.rerender({ value: scratch })
    await waitFor(() => expect(configuredPaths()).toEqual([scratch.path]))
    // 切到不预热的项目（未信任）才清空。
    mocks.invoke.mockClear()
    hook.rerender({ value: { ...next, id: 'three', path: 'D:/work/three' } })
    await waitFor(() => expect(configuredPaths()).toEqual([null]))
    hook.unmount()
    await act(async () => {})
  })

  it('prestarts the selected profile only for the active trusted connection and project', async () => {
    mocks.preset.mockImplementation(connection => connection === 'win'
      ? { id: 'agent', shell: 'powershell', command: 'claude' } : undefined)
    const active = { ...project, path: 'ssh://win/D:/code/a' }
    const hook = renderHook(({ value }) => useShellPrewarm(value), { initialProps: { value: active } })
    const args = () => mocks.invoke.mock.lastCall?.[2]
    await waitFor(() => expect(args()).toMatchObject({ profile: {
      cwd: active.path, profileId: 'agent', shell: 'powershell', command: 'claude',
    } }))
    const other = { ...active, path: 'ssh://other/D:/code/a' }
    hook.rerender({ value: other })
    await waitFor(() => expect(args()).not.toHaveProperty('profile'))
    mocks.trusted.mockReturnValue(false)
    hook.rerender({ value: active })
    await act(async () => {})
    expect(args()).not.toHaveProperty('profile')
    hook.unmount()
    await act(async () => {})
  })

  it('retains the local target while WinDev is active and settings reload', async () => {
    const remote = { ...project, path: 'ssh://windev/D:/code/qingcode' }
    const hook = renderHook(({ value }) => useShellPrewarm(value), { initialProps: { value: remote } })
    try {
      await waitFor(() => expect(configuredPaths()).toEqual([null]))
      mocks.invoke.mockClear()
      hook.rerender({ value: project })
      await waitFor(() => expect(configuredPaths()).toEqual([project.path]))
      act(() => notifyShellPrewarmChanged('project-switch'))
      await waitFor(() => expect(configuredPaths()).toEqual([project.path, project.path]))
      hook.rerender({ value: remote })
      await waitFor(() => expect(configuredPaths()).toEqual([project.path, project.path, project.path]))
      expect(configuredPaths()).not.toContain(null)
    } finally {
      hook.unmount()
      await act(async () => {})
    }
  })

  it('re-enables the WinDev pool after a background settings import without waiting for focus', async () => {
    const remote = { ...project, path: 'ssh://windev/D:/code/qingcode' }
    const hook = renderHook(() => useShellPrewarm(remote))
    await waitFor(() => expect(configuredPaths()).toEqual([null]))
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    mocks.count.mockResolvedValue(0)
    act(() => notifyShellPrewarmChanged())
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith(
      '配置 Shell 预热', 'configure_shell_prewarm', { cwd: null, shell: 'auto', count: 0 },
    ))
    mocks.count.mockResolvedValue(2)
    act(() => notifyShellPrewarmChanged())
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith(
      '配置 Shell 预热', 'configure_shell_prewarm', { cwd: null, shell: 'auto', count: 2 },
    ))
    hook.unmount()
    await act(async () => {})
  })

  it('rechecks settings imported by another window while the coordinator is in the background', async () => {
    const hook = renderHook(() => useShellPrewarm(project))
    const otherWindow = new BroadcastChannel(SHELL_PREWARM_CHANGED_EVENT)
    try {
      await waitFor(() => expect(configuredPaths()).toContain(project.path))
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      mocks.count.mockResolvedValue(2)
      otherWindow.postMessage(null)
      await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith(
        '配置 Shell 预热', 'configure_shell_prewarm', { cwd: project.path, shell: 'auto', count: 2 },
      ))
    } finally {
      otherWindow.close()
      hook.unmount()
      await act(async () => {})
    }
  })

  it('keeps ready shells when the same window regains focus', async () => {
    const hook = renderHook(() => useShellPrewarm(project))
    await waitFor(() => expect(configuredPaths()).toContain(project.path))
    mocks.invoke.mockClear()
    act(() => mocks.onFocusChanged.mock.calls.at(-1)![0]({ payload: true }))
    await waitFor(() => expect(configuredPaths()).toEqual([project.path]))
    hook.unmount()
    await act(async () => {})
  })

  it('keeps ready shells on native trust sync (mobile requests) and clears only when trust is gone', async () => {
    const hook = renderHook(() => useShellPrewarm(project))
    await waitFor(() => expect(configuredPaths()).toContain(project.path))
    mocks.invoke.mockClear()
    act(() => window.dispatchEvent(new Event('trust-synced')))
    await waitFor(() => expect(configuredPaths()).toEqual([project.path]))
    // 后台（如人在用手机）窗口未聚焦时同步不得清池。
    mocks.invoke.mockClear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('trust-synced')))
    await act(async () => {})
    expect(configuredPaths()).toEqual([])
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mocks.trusted.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('trust-synced')))
    await waitFor(() => expect(configuredPaths().at(-1)).toBeNull())
    hook.unmount()
    await act(async () => {})
  })

  it('syncs the remote budget from a non-Windows client without a local hosting opt-in', async () => {
    const remote = { ...project, path: 'ssh://c1/C:/work/app' }
    mocks.persist.mockResolvedValue(false)
    mocks.platform.mockReturnValue('mac')
    const hook = renderHook(() => useShellPrewarm(remote))
    await waitFor(() => expect(configuredPaths()).toEqual([null]))
    expect(mocks.persist).not.toHaveBeenCalled()
    mocks.trusted.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('trust-changed')))
    await waitFor(() => expect(configuredPaths().at(-1)).toBeNull())
    hook.unmount()
    await act(async () => {})
  })

  it('sends the per-connection budget even when there is no foreground project', async () => {
    mocks.count.mockResolvedValue(2)
    const hook = renderHook(() => useShellPrewarm(null))
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith(
      '配置 Shell 预热', 'configure_shell_prewarm', { cwd: null, shell: 'auto', count: 2 },
    ))
    expect(mocks.persist).not.toHaveBeenCalled()
    hook.unmount()
    await act(async () => {})
  })

  it('does not prewarm local projects on non-Windows clients', async () => {
    mocks.platform.mockReturnValue('unix')
    const hook = renderHook(() => useShellPrewarm(project))
    await act(async () => {})
    expect(configuredPaths().every(path => path === null)).toBe(true)
    hook.unmount()
    await act(async () => {})
  })
})
