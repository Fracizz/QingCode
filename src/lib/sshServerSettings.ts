import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  SSH_SERVER_PERSISTENT_TERMINALS_KEY as PROJECT_SSH_SERVER_PERSISTENT_TERMINALS_KEY,
  loadGlobalSettings,
  loadProjectSettings,
  parseSshServerPersistentTerminals as parsePersistentTerminals,
  readSshServerPersistentTerminals as readPersistentTerminals,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'
import { isTauri, safeInvoke } from '@/lib/tauri'

/**
 * ssh.server.enabled：是否在 SSH 工作区部署远端服务（qingcode-server）。
 * 关闭后完全回退纯 SFTP/exec 直连（远端零足迹），代价是失去文件树自动刷新、
 * 内嵌内容搜索与快速目录扫描。默认开启。
 */
export const SSH_SERVER_ENABLED_KEY = 'ssh.server.enabled'

/**
 * ssh.server.autoDownload：本机缺失 server 二进制时是否自动从 GitHub Release
 * （server-v<版本> 标签）下载并做 sha256 校验。安装包不附带二进制，未设置时默认开启。
 * 离线使用时把 servers 目录放在 QingCode.exe 旁边，查找顺序在下载之前。
 */
export const SSH_SERVER_AUTO_DOWNLOAD_KEY = 'ssh.server.autoDownload'

/**
 * ssh.server.offlineDir：手动选择的本机离线服务目录。空字符串表示不指定，
 * 继续使用程序旁边的 servers 目录和在线下载。非空时优先于自动查找。
 */
export const SSH_SERVER_OFFLINE_DIR_KEY = 'ssh.server.offlineDir'

/**
 * ssh.server.persistentTerminals：交互式 SSH 终端是否由远端 qingcode-server
 * daemon 托管。缺省或非法类型均按开启处理，只有明确的 false 才关闭。
 */
export const SSH_SERVER_PERSISTENT_TERMINALS_KEY = PROJECT_SSH_SERVER_PERSISTENT_TERMINALS_KEY

/** 旧版键名（改名 server 前写入的配置）：读取时回退，保存时清理。 */
export const LEGACY_SSH_AGENT_ENABLED_KEY = 'ssh.agent.enabled'
export const LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY = 'ssh.agent.autoDownload'
export const LEGACY_SSH_AGENT_OFFLINE_DIR_KEY = 'ssh.agent.offlineDir'

export function parseSshServerEnabled(value: unknown): boolean {
  return value !== false
}

export function parseSshServerAutoDownload(value: unknown): boolean {
  if (value == null) return true
  return value === true
}

export function parseSshServerPersistentTerminals(value: unknown): boolean {
  return parsePersistentTerminals(value)
}

/** 新键缺失时回退旧键（ssh.agent.*），保证升级后旧配置仍然生效。 */
function readWithLegacy(
  settings: Record<string, unknown>,
  key: string,
  legacyKey: string,
): unknown {
  if (settings[key] !== undefined) return settings[key]
  return settings[legacyKey]
}

export function readSshServerEnabled(settings: Record<string, unknown>): boolean {
  return parseSshServerEnabled(
    readWithLegacy(settings, SSH_SERVER_ENABLED_KEY, LEGACY_SSH_AGENT_ENABLED_KEY),
  )
}

export function readSshServerAutoDownload(settings: Record<string, unknown>): boolean {
  return parseSshServerAutoDownload(
    readWithLegacy(settings, SSH_SERVER_AUTO_DOWNLOAD_KEY, LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY),
  )
}

export function readSshServerPersistentTerminals(settings: Record<string, unknown>): boolean {
  return parseSshServerPersistentTerminals(readPersistentTerminals(settings))
}

export function parseSshServerOfflineDir(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0') || trimmed.includes('ssh://')) {
    return ''
  }
  return trimmed
}

export function readSshServerOfflineDir(settings: Record<string, unknown>): string {
  return parseSshServerOfflineDir(
    readWithLegacy(settings, SSH_SERVER_OFFLINE_DIR_KEY, LEGACY_SSH_AGENT_OFFLINE_DIR_KEY),
  )
}

/** 保存前把旧键清掉，避免新旧键并存时语义漂移。 */
function dropLegacyKeys(settings: Record<string, unknown>): void {
  delete settings[LEGACY_SSH_AGENT_ENABLED_KEY]
  delete settings[LEGACY_SSH_AGENT_AUTO_DOWNLOAD_KEY]
  delete settings[LEGACY_SSH_AGENT_OFFLINE_DIR_KEY]
}

let cachedSshServerEnabled = parseSshServerEnabled(DEFAULT_GLOBAL_SETTINGS[SSH_SERVER_ENABLED_KEY])
let cachedSshServerAutoDownload = parseSshServerAutoDownload(
  DEFAULT_GLOBAL_SETTINGS[SSH_SERVER_AUTO_DOWNLOAD_KEY],
)
let cachedSshServerOfflineDir = parseSshServerOfflineDir(
  DEFAULT_GLOBAL_SETTINGS[SSH_SERVER_OFFLINE_DIR_KEY],
)
let cachedSshServerPersistentTerminals = parseSshServerPersistentTerminals(
  DEFAULT_GLOBAL_SETTINGS[SSH_SERVER_PERSISTENT_TERMINALS_KEY],
)

export function getSshServerEnabled(): boolean {
  return cachedSshServerEnabled
}

export function getSshServerAutoDownload(): boolean {
  return cachedSshServerAutoDownload
}

export function getSshServerOfflineDir(): string {
  return cachedSshServerOfflineDir
}

export function getSshServerPersistentTerminals(): boolean {
  return cachedSshServerPersistentTerminals
}

export function notifySshServerEnabledChanged(enabled: boolean) {
  cachedSshServerEnabled = enabled !== false
}

export async function loadEffectiveSshServerEnabled(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const merged = mergeSettings(global, workspace)
  const next = readSshServerEnabled(merged)
  cachedSshServerAutoDownload = readSshServerAutoDownload(merged)
  cachedSshServerOfflineDir = readSshServerOfflineDir(merged)
  cachedSshServerPersistentTerminals = readSshServerPersistentTerminals(merged)
  notifySshServerEnabledChanged(next)
  return next
}

export async function loadScopedSshServerEnabled(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  const next =
    scope === 'project' && project
      ? readSshServerEnabled(await loadProjectSettings(project))
      : readSshServerEnabled(await loadGlobalSettings())
  notifySshServerEnabledChanged(next)
  return next
}

export async function saveScopedSshServerEnabled(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_SERVER_ENABLED_KEY] = enabled
    dropLegacyKeys(current)
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_SERVER_ENABLED_KEY] = enabled
    dropLegacyKeys(current)
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshServerEnabled(project)
  await pushSshServerSettingsToNative()
}

export async function loadScopedSshServerPersistentTerminals(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  const next =
    scope === 'project' && project
      ? readSshServerPersistentTerminals(await loadProjectSettings(project))
      : readSshServerPersistentTerminals(await loadGlobalSettings())
  cachedSshServerPersistentTerminals = next
  return next
}

export async function saveScopedSshServerPersistentTerminals(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_SERVER_PERSISTENT_TERMINALS_KEY] = enabled === true
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_SERVER_PERSISTENT_TERMINALS_KEY] = enabled === true
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshServerEnabled(project)
  await pushSshServerSettingsToNative()
}

export async function loadScopedSshServerAutoDownload(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  const next =
    scope === 'project' && project
      ? readSshServerAutoDownload(await loadProjectSettings(project))
      : readSshServerAutoDownload(await loadGlobalSettings())
  cachedSshServerAutoDownload = next
  return next
}

export async function saveScopedSshServerAutoDownload(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_SERVER_AUTO_DOWNLOAD_KEY] = enabled
    dropLegacyKeys(current)
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_SERVER_AUTO_DOWNLOAD_KEY] = enabled
    dropLegacyKeys(current)
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshServerEnabled(project)
  await pushSshServerSettingsToNative()
}

export async function loadScopedSshServerOfflineDir(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<string> {
  const next =
    scope === 'project' && project
      ? readSshServerOfflineDir(await loadProjectSettings(project))
      : readSshServerOfflineDir(await loadGlobalSettings())
  cachedSshServerOfflineDir = next
  return next
}

export async function saveScopedSshServerOfflineDir(
  scope: 'global' | 'project',
  dir: string,
  project?: Project | null,
): Promise<void> {
  const value = parseSshServerOfflineDir(dir)
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_SERVER_OFFLINE_DIR_KEY] = value
    dropLegacyKeys(current)
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_SERVER_OFFLINE_DIR_KEY] = value
    dropLegacyKeys(current)
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshServerEnabled(project)
  await pushSshServerSettingsToNative()
}

/**
 * 后端是常驻进程：开关变化时即时同步，避免重启应用才生效。
 * 返回是否全部推送成功；调用方应把失败提示给用户而不是只写 console。
 */
export async function pushSshServerSettingsToNative(): Promise<void> {
  if (!isTauri()) return
  try {
    await safeInvoke('配置 SSH 远端服务', 'ssh_set_server_enabled', {
      enabled: getSshServerEnabled(),
    })
    await safeInvoke('配置 SSH 远端服务下载', 'ssh_set_server_auto_download', {
      enabled: getSshServerAutoDownload(),
    })
    await safeInvoke(
      '配置 SSH 持久化终端',
      'ssh_set_persistent_terminals_enabled',
      { enabled: getSshServerPersistentTerminals() },
    )
    await safeInvoke('配置 SSH 离线服务目录', 'ssh_set_server_offline_dir', {
      dir: getSshServerOfflineDir(),
    })
  } catch (e) {
    console.error('pushSshServerSettingsToNative failed:', e)
    throw e
  }
}
