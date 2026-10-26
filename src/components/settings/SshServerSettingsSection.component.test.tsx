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

  it('saves the default mode globally, drops legacy keys, and never stops the remote server', async () => {
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    const toggle = screen.getByLabelText('新建连接的默认模式') as HTMLSelectElement
    expect(toggle.value).toBe('server')
    fireEvent.change(toggle, { target: { value: 'ssh' } })

    await waitFor(() => expect(saveGlobalSettings).toHaveBeenCalledTimes(1))
    const saved = saveGlobalSettings.mock.calls[0][0] as Record<string, unknown>
    expect(saved['ssh.server.enabled']).toBe(false)
    expect('ssh.agent.enabled' in saved).toBe(false)
    expect('ssh.agent.autoDownload' in saved).toBe(false)

    // 关闭开关只影响新建连接的默认值，不再停止已有连接的远端服务。
    expect(invoke).not.toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', expect.anything())
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('hides the default-mode toggle in workspace scope', async () => {
    render(<SshServerSettingsSection scope="workspace" project={sshProject} settingsRevision={0} />)

    expect(screen.queryByLabelText('新建连接的默认模式')).toBeNull()
    expect(await screen.findByLabelText('SSH › 服务: 缺失时自动下载')).toBeTruthy()
  })

  it('reports save failures with the dedicated message', async () => {
    saveGlobalSettings.mockRejectedValue(new Error('disk full'))
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    fireEvent.change(screen.getByLabelText('新建连接的默认模式'), {
      target: { value: 'ssh' },
    })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('error', '保存默认连接模式失败: Error: disk full')
    })
    expect(invoke).not.toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', expect.anything())
  })
})
