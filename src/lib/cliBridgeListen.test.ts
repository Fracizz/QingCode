// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { windowListen, safeInvoke } = vi.hoisted(() => ({
  windowListen: vi.fn(async (_event: string, _handler: (event: { payload: Record<string, string> }) => void) => () => {}),
  safeInvoke: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ listen: windowListen }),
}))

vi.mock('./tauri', async importOriginal => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  isTauri: () => true,
  safeInvoke,
}))

import { listenForCliRequests } from './cliBridge'
import { TERMINAL_PROFILES_KEY } from './terminal/terminalProfiles'
import { trustTerminalProfile } from './terminal/terminalProfileTrust'
import { trustProject } from './workspaceTrust'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import * as prewarm from './terminal/shellPrewarmSettings'

describe('listenForCliRequests', () => {
  beforeEach(() => {
    windowListen.mockClear()
    safeInvoke.mockClear()
  })

  it('subscribes on the current window so other windows never run the request', async () => {
    await listenForCliRequests()
    expect(windowListen).toHaveBeenCalledWith('cli-request', expect.any(Function))
  })

  it('reports readiness only after the subscription exists', async () => {
    const order: string[] = []
    windowListen.mockImplementationOnce(async () => {
      order.push('listen')
      return () => {}
    })
    safeInvoke.mockImplementationOnce(async () => {
      order.push('ready')
      return undefined
    })
    await listenForCliRequests()
    expect(order).toEqual(['listen', 'ready'])
    expect(safeInvoke).toHaveBeenCalledWith(expect.any(String), 'cli_bridge_ready')
  })

  it('lists saved profiles and creates a tab with the selected profile and reserved ID', async () => {
    const project = { id: 'p1', name: 'Fixture', path: 'D:/fixture', created_at: 0, last_opened_at: 0 }
    const profile = { id: 'p-code', name: 'opencode', command: 'opencode', shell: 'auto' }
    localStorage.setItem(TERMINAL_PROFILES_KEY, JSON.stringify({ profiles: [profile] }))
    trustProject(project)
    trustTerminalProfile(profile)
    useProjectStore.setState({ projects: [project], currentProject: project })
    const reserve = vi.spyOn(prewarm, 'reservePrewarmedShellId').mockResolvedValue('warm-tab')
    try {
      await listenForCliRequests()
      const dispatch = windowListen.mock.calls[0][1]
      dispatch({ payload: { id: 'list', op: 'terminal.profiles' } })
      await vi.waitFor(() => expect(safeInvoke).toHaveBeenCalledWith(expect.any(String), 'resolve_cli_request', {
        id: 'list', ok: true, error: null, data: {
          defaultProfileId: 'default', profiles: expect.arrayContaining([
            { id: profile.id, name: profile.name, shell: expect.any(String), trusted: true },
          ]),
        },
      }))
      dispatch({ payload: { id: 'create', op: 'terminal.createProfile', config: 'opencode', project: project.id } })
      await vi.waitFor(() => expect(safeInvoke).toHaveBeenCalledWith(expect.any(String), 'resolve_cli_request',
        expect.objectContaining({ ok: true, data: expect.objectContaining({
          terminal: expect.objectContaining({ id: 'warm-tab', profileId: profile.id }),
        }) })))
      expect(reserve).toHaveBeenCalledWith(project.path, expect.any(String), true)
      expect(useTerminalStore.getState().terminals[0].launchCommand).toBe('opencode')
    } finally {
      await useTerminalStore.getState().closeTerminal('warm-tab')
      reserve.mockRestore()
      localStorage.clear()
      useProjectStore.setState({ projects: [], currentProject: null })
    }
  })
})
