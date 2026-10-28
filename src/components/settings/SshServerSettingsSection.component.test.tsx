// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@tauri-apps/plugin-dialog'
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
    vi.mocked(open).mockReset().mockResolvedValue(null)
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

  it.each(['user', 'workspace'] as const)('imports a local ZIP and saves the verified directory in %s scope', async scope => {
    vi.mocked(open).mockResolvedValue('D:/Code/QingCode/release/QingCode-servers.zip')
    invoke.mockImplementation(async (_action, command) =>
      command === 'ssh_import_server_archive' ? 'D:/Cache/servers/offline-verified' : undefined)
    render(<SshServerSettingsSection scope={scope} project={sshProject} settingsRevision={0} />)
    await waitFor(() => expect((screen.getByLabelText('SSH › 服务: 缺失时自动下载') as HTMLSelectElement).value).toBe('off'))
    fireEvent.click(screen.getByLabelText('选择离线 ZIP'))

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('success', '已使用离线服务目录'))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      directory: false,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    }))
    expect(invoke).toHaveBeenCalledWith('导入 SSH 离线服务包', 'ssh_import_server_archive', {
      path: 'D:/Code/QingCode/release/QingCode-servers.zip',
    })
    if (scope === 'user') {
      expect(saveGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
        'ssh.server.offlineDir': 'D:/Cache/servers/offline-verified',
      }))
      expect(saveProjectSettings).not.toHaveBeenCalled()
    } else {
      expect(saveProjectSettings).toHaveBeenCalledWith(sshProject, expect.objectContaining({
        'ssh.server.offlineDir': 'D:/Cache/servers/offline-verified',
      }))
      expect(saveGlobalSettings).not.toHaveBeenCalled()
    }
    expect(screen.getByText('D:/Cache/servers/offline-verified')).toBeTruthy()
  })

  it('does not save a rejected ZIP and allows retrying', async () => {
    vi.mocked(open).mockResolvedValue('D:/broken.zip')
    invoke.mockRejectedValue(new Error('sha256 mismatch'))
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)
    fireEvent.click(screen.getByLabelText('选择离线 ZIP'))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('error', expect.stringContaining('sha256 mismatch')))
    expect(saveGlobalSettings).not.toHaveBeenCalled()
    expect(saveProjectSettings).not.toHaveBeenCalled()
    expect((screen.getByLabelText('选择离线 ZIP') as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancelling ZIP selection preserves the previous setting', async () => {
    render(<SshServerSettingsSection scope="user" project={sshProject} settingsRevision={0} />)
    fireEvent.click(screen.getByLabelText('选择离线 ZIP'))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByLabelText('选择离线 ZIP') as HTMLButtonElement).disabled).toBe(false))
    expect(invoke).not.toHaveBeenCalledWith(expect.anything(), 'ssh_import_server_archive', expect.anything())
    expect(saveGlobalSettings).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalled()
  })
})
