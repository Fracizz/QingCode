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
      'ssh.agent.enabled': false,
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

  it('keeps only deployment controls and preserves the legacy mode when changing downloads', async () => {
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    expect(screen.queryByLabelText('新建连接的默认模式')).toBeNull()
    const toggle = screen.getByLabelText('SSH › 服务: 缺失时自动下载') as HTMLSelectElement
    await waitFor(() => expect(toggle.value).toBe('off'))
    fireEvent.change(toggle, { target: { value: 'on' } })

    await waitFor(() => expect(saveGlobalSettings).toHaveBeenCalledTimes(1))
    const saved = saveGlobalSettings.mock.calls[0][0] as Record<string, unknown>
    expect(saved['ssh.server.enabled']).toBe(false)
    expect(saved['ssh.server.autoDownload']).toBe(true)
    expect('ssh.agent.enabled' in saved).toBe(false)
    expect('ssh.agent.autoDownload' in saved).toBe(false)

    // 下载策略不改变既有连接，也不停止服务。
    expect(invoke).not.toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', expect.anything())
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('keeps deployment controls in workspace scope without a mode toggle', async () => {
    render(<SshServerSettingsSection scope="workspace" project={sshProject} settingsRevision={0} />)

    expect(screen.queryByLabelText('新建连接的默认模式')).toBeNull()
    expect(await screen.findByLabelText('SSH › 服务: 缺失时自动下载')).toBeTruthy()
  })

  it('reports download setting save failures', async () => {
    saveGlobalSettings.mockRejectedValue(new Error('disk full'))
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)

    const toggle = screen.getByLabelText('SSH › 服务: 缺失时自动下载') as HTMLSelectElement
    await waitFor(() => expect(toggle.value).toBe('off'))
    fireEvent.change(toggle, {
      target: { value: 'on' },
    })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('error', '保存自动下载设置失败: Error: disk full')
    })
    expect(invoke).not.toHaveBeenCalledWith('停止远端服务', 'ssh_server_stop', expect.anything())
  })
})
