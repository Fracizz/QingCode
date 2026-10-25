// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshServerSettingsSection from './SshServerSettingsSection'
import { useProjectStore } from '../../store/projectStore'

const { invoke, loadGlobalSettings, loadProjectSettings, saveGlobalSettings, saveProjectSettings } =
  vi.hoisted(() => ({
    invoke: vi.fn(),
    loadGlobalSettings: vi.fn(),
    loadProjectSettings: vi.fn(),
    saveGlobalSettings: vi.fn(),
    saveProjectSettings: vi.fn(),
  }))

vi.mock('../../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => invoke(...args),
  NotInTauriError: class NotInTauriError extends Error {
    constructor(action: string) {
      super(action)
      this.name = 'NotInTauriError'
    }
  },
}))

vi.mock('../../lib/projectSettings', async () => {
  const actual = await vi.importActual<typeof import('../../lib/projectSettings')>('../../lib/projectSettings')
  return {
    ...actual,
    loadGlobalSettings,
    loadProjectSettings,
    saveGlobalSettings,
    saveProjectSettings,
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))

const sshProject = {
  id: 's1',
  name: 'Remote',
  path: 'ssh://c1/home/app',
  kind: 'ssh',
  created_at: 1,
  last_opened_at: 1,
}

function settingsWith(entries: Record<string, unknown>) {
  return { version: 1, custom: {}, ...entries }
}

describe('SshServerSettingsSection', () => {
  const pushToast = vi.fn()

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    let globalSettings = settingsWith({
      'ssh.agent.enabled': true,
      'ssh.agent.autoDownload': false,
    })
    loadGlobalSettings.mockReset().mockImplementation(async () => globalSettings)
    loadProjectSettings.mockReset().mockResolvedValue(settingsWith({}))
    saveGlobalSettings.mockReset().mockImplementation(async settings => {
      globalSettings = settings
    })
    saveProjectSettings.mockReset().mockResolvedValue(undefined)
    pushToast.mockReset()
    useProjectStore.setState({ pushToast })
  })

  it('turning the server off saves the new key, drops legacy keys, and stops the remote server', async () => {
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    const toggle = screen.getByLabelText('SSH › 服务: 远端服务') as HTMLSelectElement
    expect(toggle.value).toBe('on')
    fireEvent.change(toggle, { target: { value: 'off' } })

    await waitFor(() => expect(saveGlobalSettings).toHaveBeenCalledTimes(1))
    const saved = saveGlobalSettings.mock.calls[0][0] as Record<string, unknown>
    expect(saved['ssh.server.enabled']).toBe(false)
    expect('ssh.agent.enabled' in saved).toBe(false)
    expect('ssh.agent.autoDownload' in saved).toBe(false)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', {
        rootUri: 'ssh://c1/home/app',
      })
    })
    // Success stays quiet — status events refresh the chip instead.
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('does not stop the remote server for a local project', async () => {
    const localProject = { ...sshProject, path: 'D:/local', kind: 'local' }
    render(<SshServerSettingsSection scope="user" project={localProject} settingsRevision={0} />)

    fireEvent.change(screen.getByLabelText('SSH › 服务: 远端服务'), {
      target: { value: 'off' },
    })

    await waitFor(() => expect(saveGlobalSettings).toHaveBeenCalledTimes(1))
    expect(invoke).not.toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', expect.anything())
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('shows the persistent terminal toggle and explains the fallback in a tooltip', async () => {
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    const toggle = screen.getByLabelText('SSH › 服务: 持久化终端') as HTMLSelectElement
    await waitFor(() => expect(toggle.value).toBe('on'))
    fireEvent.mouseEnter(toggle.parentElement as HTMLElement)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '关闭后新开的终端将直连 SSH，断线会结束远端进程；已经打开的持久化终端不受影响。',
    )
  })

  it('saves and pushes the persistent terminal toggle', async () => {
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    const toggle = screen.getByLabelText('SSH › 服务: 持久化终端') as HTMLSelectElement
    await waitFor(() => expect(toggle.value).toBe('on'))
    fireEvent.change(toggle, { target: { value: 'off' } })

    await waitFor(() => expect(saveGlobalSettings).toHaveBeenCalledTimes(1))
    const saved = saveGlobalSettings.mock.calls[0][0] as Record<string, unknown>
    expect(saved['ssh.server.persistentTerminals']).toBe(false)
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        '配置 SSH 持久化终端',
        'ssh_set_persistent_terminals_enabled',
        { enabled: false },
      )
    })
  })

  it('loads and saves a workspace persistent terminal override', async () => {
    let workspaceSettings = settingsWith({ 'ssh.server.persistentTerminals': true })
    loadProjectSettings.mockImplementation(async () => workspaceSettings)
    saveProjectSettings.mockImplementation(async (_project, settings) => {
      workspaceSettings = settings
    })
    render(
      <SshServerSettingsSection scope="workspace" project={sshProject} settingsRevision={0} />,
    )

    const toggle = screen.getByLabelText('SSH › 服务: 持久化终端') as HTMLSelectElement
    await waitFor(() => expect(toggle.value).toBe('on'))
    fireEvent.change(toggle, { target: { value: 'off' } })

    await waitFor(() => expect(saveProjectSettings).toHaveBeenCalledTimes(1))
    expect(workspaceSettings['ssh.server.persistentTerminals']).toBe(false)
  })

  it('toasts when stopping the remote server fails', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_stop') throw new Error('not connected')
      return undefined
    })
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    fireEvent.change(screen.getByLabelText('SSH › 服务: 远端服务'), {
      target: { value: 'off' },
    })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('error', '停止远端服务失败: Error: not connected')
    })
  })

  it('reports save failures with the dedicated toggle message', async () => {
    saveGlobalSettings.mockRejectedValue(new Error('disk full'))
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    fireEvent.change(screen.getByLabelText('SSH › 服务: 远端服务'), {
      target: { value: 'off' },
    })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('error', '保存远端服务开关失败: Error: disk full')
    })
    expect(invoke).not.toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', expect.anything())
  })
})
