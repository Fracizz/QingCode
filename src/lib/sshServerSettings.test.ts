import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
  safeInvoke,
} = vi.hoisted(() => ({
  loadGlobalSettings: vi.fn(),
  loadProjectSettings: vi.fn(),
  saveGlobalSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
  safeInvoke: vi.fn(),
}))

vi.mock('./projectSettings', async () => {
  const actual = await vi.importActual<typeof import('./projectSettings')>('./projectSettings')
  return {
    ...actual,
    loadGlobalSettings,
    loadProjectSettings,
    saveGlobalSettings,
    saveProjectSettings,
  }
})

vi.mock('./tauri', () => ({
  isTauri: () => true,
  safeInvoke,
}))

import {
  getSshServerAutoDownload,
  getSshServerEnabled,
  getSshServerOfflineDir,
  loadEffectiveSshServerEnabled,
  parseSshServerAutoDownload,
  parseSshServerEnabled,
  parseSshServerOfflineDir,
  readSshServerAutoDownload,
  readSshServerEnabled,
  readSshServerOfflineDir,
  saveScopedSshServerEnabled,
  LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY,
  LEGACY_SSH_AGENT_ENABLED_KEY,
  LEGACY_SSH_AGENT_OFFLINE_DIR_KEY,
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  SSH_SERVER_ENABLED_KEY,
  SSH_SERVER_OFFLINE_DIR_KEY,
} from '@/lib/sshServerSettings'
import type { SettingsFile } from '@/lib/projectSettings'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'

describe('sshServerSettings', () => {
  it('defaults on when unset', () => {
    expect(parseSshServerEnabled(undefined)).toBe(true)
    expect(parseSshServerEnabled(true)).toBe(true)
    expect(parseSshServerEnabled(false)).toBe(false)
    expect(parseSshServerEnabled('false')).toBe(true)
  })

  it('reads ssh.server.enabled', () => {
    expect(readSshServerEnabled(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
    expect(
      readSshServerEnabled({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_SERVER_ENABLED_KEY]: false,
      }),
    ).toBe(false)
  })

  it('autoDownload defaults on and only accepts explicit true', () => {
    expect(parseSshServerAutoDownload(undefined)).toBe(true)
    expect(parseSshServerAutoDownload(null)).toBe(true)
    expect(parseSshServerAutoDownload(false)).toBe(false)
    expect(parseSshServerAutoDownload('true')).toBe(false)
    expect(parseSshServerAutoDownload(true)).toBe(true)
    expect(readSshServerAutoDownload(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
    expect(
      readSshServerAutoDownload({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_SERVER_AUTO_DOWNLOAD_KEY]: true,
      }),
    ).toBe(true)
  })

  it('offlineDir is an empty local path unless explicitly set', () => {
    expect(parseSshServerOfflineDir(undefined)).toBe('')
    expect(parseSshServerOfflineDir('  ')).toBe('')
    expect(parseSshServerOfflineDir('ssh://host/tmp/agents')).toBe('')
    expect(parseSshServerOfflineDir('D:/agents')).toBe('D:/agents')
    expect(readSshServerOfflineDir(DEFAULT_GLOBAL_SETTINGS)).toBe('')
    expect(
      readSshServerOfflineDir({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_SERVER_OFFLINE_DIR_KEY]: '  D:/offline/agents  ',
      }),
    ).toBe('D:/offline/agents')
  })
})



describe('sshServerSettings legacy ssh.agent.* keys', () => {
  const project = { id: 'p1', name: 'P', path: 'D:/p', created_at: 1, last_opened_at: 1 }

  function settingsWith(entries: Record<string, unknown>): SettingsFile {
    return { version: 1, custom: {}, ...entries }
  }

  beforeEach(() => {
    loadGlobalSettings.mockReset().mockResolvedValue(settingsWith({}))
    loadProjectSettings.mockReset().mockResolvedValue(settingsWith({}))
    saveGlobalSettings.mockReset().mockResolvedValue(undefined)
    saveProjectSettings.mockReset().mockResolvedValue(undefined)
    safeInvoke.mockReset().mockResolvedValue(undefined)
  })

  it('falls back to legacy keys when reading merged global and workspace settings', async () => {
    loadGlobalSettings.mockResolvedValue(
      settingsWith({
        [LEGACY_SSH_AGENT_ENABLED_KEY]: false,
        [LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY]: false,
        [LEGACY_SSH_AGENT_OFFLINE_DIR_KEY]: 'D:/legacy-agents',
      }),
    )
    loadProjectSettings.mockResolvedValue(settingsWith({}))

    await expect(loadEffectiveSshServerEnabled(project)).resolves.toBe(false)
    expect(getSshServerEnabled()).toBe(false)
    expect(getSshServerAutoDownload()).toBe(false)
    expect(getSshServerOfflineDir()).toBe('D:/legacy-agents')
  })

  it('prefers global enabled over a workspace override', async () => {
    loadGlobalSettings.mockResolvedValue(
      settingsWith({
        [SSH_SERVER_ENABLED_KEY]: true,
        [LEGACY_SSH_AGENT_ENABLED_KEY]: false,
        [SSH_SERVER_OFFLINE_DIR_KEY]: 'D:/new',
        [LEGACY_SSH_AGENT_OFFLINE_DIR_KEY]: 'D:/legacy',
      }),
    )
    // 模式不再支持项目作用域：工作区覆盖 enabled 也不影响新建连接的默认模式。
    loadProjectSettings.mockResolvedValue(settingsWith({ [SSH_SERVER_ENABLED_KEY]: false }))

    await expect(loadEffectiveSshServerEnabled(project)).resolves.toBe(true)
    expect(getSshServerOfflineDir()).toBe('D:/new')
  })

  it('drops legacy keys when saving the global toggle', async () => {
    loadGlobalSettings.mockResolvedValue(
      settingsWith({
        [LEGACY_SSH_AGENT_ENABLED_KEY]: true,
        [LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY]: false,
        [LEGACY_SSH_AGENT_OFFLINE_DIR_KEY]: 'D:/legacy',
      }),
    )

    await saveScopedSshServerEnabled('global', false, null)

    expect(saveGlobalSettings).toHaveBeenCalledTimes(1)
    const saved = saveGlobalSettings.mock.calls[0][0] as Record<string, unknown>
    expect(saved[SSH_SERVER_ENABLED_KEY]).toBe(false)
    expect(LEGACY_SSH_AGENT_ENABLED_KEY in saved).toBe(false)
    expect(LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY in saved).toBe(false)
    expect(LEGACY_SSH_AGENT_OFFLINE_DIR_KEY in saved).toBe(false)
    // 持久化终端开关已移除，推送时不得再调用旧命令。
    expect(safeInvoke).not.toHaveBeenCalledWith(
      '配置 SSH 持久化终端',
      'ssh_set_persistent_terminals_enabled',
      expect.anything(),
    )
  })

  it('ignores the project scope when saving the default mode', async () => {
    loadProjectSettings.mockResolvedValue(
      settingsWith({ [LEGACY_SSH_AGENT_ENABLED_KEY]: true }),
    )

    await saveScopedSshServerEnabled('project', false, project)

    // 模式只写全局：项目作用域不再持久化该键。
    expect(saveGlobalSettings).toHaveBeenCalledTimes(1)
    expect(saveProjectSettings).not.toHaveBeenCalled()
    const saved = saveGlobalSettings.mock.calls[0][0] as Record<string, unknown>
    expect(saved[SSH_SERVER_ENABLED_KEY]).toBe(false)
    expect(LEGACY_SSH_AGENT_ENABLED_KEY in saved).toBe(false)
  })

  it('never pushes the removed ssh_set_server_enabled command', async () => {
    await saveScopedSshServerEnabled('global', false, null)
    expect(safeInvoke).not.toHaveBeenCalledWith(
      '配置 SSH 远端服务',
      'ssh_set_server_enabled',
      expect.anything(),
    )
    expect(safeInvoke).toHaveBeenCalledWith('配置 SSH 远端服务下载', 'ssh_set_server_auto_download', {
      enabled: true,
    })
  })
})
