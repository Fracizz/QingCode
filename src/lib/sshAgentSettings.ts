import type { Project } from '@/types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
} from '@/lib/projectSettings'
import { mergeSettings } from '@/lib/autoSaveSettings'
import { isTauri, safeInvoke } from '@/lib/tauri'

/**
 * ssh.agent.enabled：是否在 SSH 工作区部署远端代理（qingcode-agent）。
 * 关闭后完全回退纯 SFTP/exec 直连（远端零足迹），代价是失去文件树自动刷新、
 * 内嵌内容搜索与快速目录扫描。默认开启。
 */
export const SSH_AGENT_ENABLED_KEY = 'ssh.agent.enabled'

/**
 * ssh.agent.autoDownload：本机缺失 agent 二进制时是否自动从 GitHub Release
 * （agent-v<版本> 标签）下载并做 sha256 校验。安装包不附带二进制，未设置时默认开启。
 * 离线使用时把 agents 目录放在 QingCode.exe 旁边，查找顺序在下载之前。
 */
export const SSH_AGENT_AUTO_DOWNLOAD_KEY = 'ssh.agent.autoDownload'

/**
 * ssh.agent.offlineDir：手动选择的本机离线代理目录。空字符串表示不指定，
 * 继续使用程序旁边的 agents 目录和在线下载。非空时优先于自动查找。
 */
export const SSH_AGENT_OFFLINE_DIR_KEY = 'ssh.agent.offlineDir'

export function parseSshAgentEnabled(value: unknown): boolean {
  return value !== false
}

export function parseSshAgentAutoDownload(value: unknown): boolean {
  if (value == null) return true
  return value === true
}

export function readSshAgentEnabled(settings: Record<string, unknown>): boolean {
  return parseSshAgentEnabled(settings[SSH_AGENT_ENABLED_KEY])
}

export function readSshAgentAutoDownload(settings: Record<string, unknown>): boolean {
  return parseSshAgentAutoDownload(settings[SSH_AGENT_AUTO_DOWNLOAD_KEY])
}

export function parseSshAgentOfflineDir(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0') || trimmed.includes('ssh://')) {
    return ''
  }
  return trimmed
}

export function readSshAgentOfflineDir(settings: Record<string, unknown>): string {
  return parseSshAgentOfflineDir(settings[SSH_AGENT_OFFLINE_DIR_KEY])
}

let cachedSshAgentEnabled = parseSshAgentEnabled(DEFAULT_GLOBAL_SETTINGS[SSH_AGENT_ENABLED_KEY])
let cachedSshAgentAutoDownload = parseSshAgentAutoDownload(
  DEFAULT_GLOBAL_SETTINGS[SSH_AGENT_AUTO_DOWNLOAD_KEY],
)
let cachedSshAgentOfflineDir = parseSshAgentOfflineDir(
  DEFAULT_GLOBAL_SETTINGS[SSH_AGENT_OFFLINE_DIR_KEY],
)

export function getSshAgentEnabled(): boolean {
  return cachedSshAgentEnabled
}

export function getSshAgentAutoDownload(): boolean {
  return cachedSshAgentAutoDownload
}

export function getSshAgentOfflineDir(): string {
  return cachedSshAgentOfflineDir
}

export function notifySshAgentEnabledChanged(enabled: boolean) {
  cachedSshAgentEnabled = enabled !== false
}

export async function loadEffectiveSshAgentEnabled(
  project?: Project | null,
): Promise<boolean> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const merged = mergeSettings(global, workspace)
  const next = readSshAgentEnabled(merged)
  cachedSshAgentAutoDownload = readSshAgentAutoDownload(merged)
  cachedSshAgentOfflineDir = readSshAgentOfflineDir(merged)
  notifySshAgentEnabledChanged(next)
  return next
}

export async function loadScopedSshAgentEnabled(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  const next =
    scope === 'project' && project
      ? readSshAgentEnabled(await loadProjectSettings(project))
      : readSshAgentEnabled(await loadGlobalSettings())
  notifySshAgentEnabledChanged(next)
  return next
}

export async function saveScopedSshAgentEnabled(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_AGENT_ENABLED_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_AGENT_ENABLED_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshAgentEnabled(project)
  await pushSshAgentEnabledToNative()
}

export async function loadScopedSshAgentAutoDownload(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  const next =
    scope === 'project' && project
      ? readSshAgentAutoDownload(await loadProjectSettings(project))
      : readSshAgentAutoDownload(await loadGlobalSettings())
  cachedSshAgentAutoDownload = next
  return next
}

export async function saveScopedSshAgentAutoDownload(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_AGENT_AUTO_DOWNLOAD_KEY] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_AGENT_AUTO_DOWNLOAD_KEY] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshAgentEnabled(project)
  await pushSshAgentEnabledToNative()
}

export async function loadScopedSshAgentOfflineDir(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<string> {
  const next =
    scope === 'project' && project
      ? readSshAgentOfflineDir(await loadProjectSettings(project))
      : readSshAgentOfflineDir(await loadGlobalSettings())
  cachedSshAgentOfflineDir = next
  return next
}

export async function saveScopedSshAgentOfflineDir(
  scope: 'global' | 'project',
  dir: string,
  project?: Project | null,
): Promise<void> {
  const value = parseSshAgentOfflineDir(dir)
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current[SSH_AGENT_OFFLINE_DIR_KEY] = value
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current[SSH_AGENT_OFFLINE_DIR_KEY] = value
    await saveGlobalSettings(current)
  }
  await loadEffectiveSshAgentEnabled(project)
  await pushSshAgentEnabledToNative()
}

/** 后端是常驻进程：开关变化时即时同步，避免重启应用才生效。 */
export async function pushSshAgentEnabledToNative(): Promise<void> {
  if (!isTauri()) return
  try {
    await safeInvoke('配置 SSH 远端代理', 'ssh_set_agent_enabled', {
      enabled: getSshAgentEnabled(),
    })
    await safeInvoke('配置 SSH 远端代理下载', 'ssh_set_agent_auto_download', {
      enabled: getSshAgentAutoDownload(),
    })
    await safeInvoke('配置 SSH 离线代理目录', 'ssh_set_agent_offline_dir', {
      dir: getSshAgentOfflineDir(),
    })
  } catch (e) {
    console.error('ssh_set_agent_enabled failed:', e)
  }
}
