// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => 0), count: vi.fn(async () => 'auto' as 'auto' | number),
  persist: vi.fn(async () => true), trusted: vi.fn(() => true), platform: vi.fn(() => 'win'),
}))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, safeInvoke: mocks.invoke }))
vi.mock('../lib/workspaceTrust', () => ({ isProjectTrusted: mocks.trusted, WORKSPACE_TRUST_CHANGED_EVENT: 'trust-changed', WORKSPACE_TRUST_SYNCED_EVENT: 'trust-synced' }))
vi.mock('../lib/terminal/shellPrewarmSettings', () => ({ loadShellPrewarmCount: mocks.count, SHELL_PREWARM_CHANGED_EVENT: 'prewarm-changed' }))
vi.mock('../lib/terminal/terminalPersistLocalSettings', () => ({ loadEffectiveTerminalPersistLocalSessions: mocks.persist }))
vi.mock('../lib/terminal/terminalProfiles', () => ({ loadTerminalProfileSettings: () => ({ defaultShell: 'auto' }), TERMINAL_PROFILES_KEY: 'profiles' }))
vi.mock('../lib/terminal/terminalShell', () => ({ detectTerminalHostPlatform: mocks.platform }))
import { useShellPrewarm } from './useShellPrewarm'
const project: Project = { id: 'one', name: 'One', path: 'D:/work/one' }
const configuredPaths = () => mocks.invoke.mock.calls.map(call => (call[2] as { cwd: string | null }).cwd)

beforeEach(() => {
  vi.clearAllMocks()
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
    act(() => window.dispatchEvent(new Event('prewarm-changed')))
    await act(async () => {})
    expect(configuredPaths().filter(path => path === project.path)).toHaveLength(1)
    hook.unmount()
    await act(async () => {})
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

  it('lets the focused window own the budget and rechecks focus after loading settings', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const hook = renderHook(() => useShellPrewarm(project))
    await act(async () => {})
    expect(configuredPaths().every(path => path === null)).toBe(true)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(configuredPaths()).toContain(project.path))
    hook.unmount()
    await act(async () => {})
  })

  it('keeps ready shells when the same window regains focus', async () => {
    const hook = renderHook(() => useShellPrewarm(project))
    await waitFor(() => expect(configuredPaths()).toContain(project.path))
    mocks.invoke.mockClear()
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(configuredPaths()).toEqual([project.path]))
    hook.unmount()
    await act(async () => {})
  })

  it('hands trusted SSH projects to the backend without the local hosting opt-in, from any client', async () => {
    const remote = { ...project, path: 'ssh://c1/C:/work/app' }
    mocks.persist.mockResolvedValue(false)
    mocks.platform.mockReturnValue('mac')
    const hook = renderHook(() => useShellPrewarm(remote))
    await waitFor(() => expect(configuredPaths()).toContain(remote.path))
    expect(mocks.persist).not.toHaveBeenCalled()
    mocks.trusted.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('trust-changed')))
    await waitFor(() => expect(configuredPaths().at(-1)).toBeNull())
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
