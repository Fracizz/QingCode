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
 * （agent-v<版本> 标签）下载并做 sha256 校验。默认关闭，由用户显式开启。
 */
export const SSH_AGENT_AUTO_DOWNLOAD_KEY = 'ssh.agent.autoDownload'

export function parseSshAgentEnabled(value: unknown): boolean {
  return value !== false
}

export function parseSshAgentAutoDownload(value: unknown): boolean {
  return value === true
}

export function readSshAgentEnabled(settings: Record<string, unknown>): boolean {
  return parseSshAgentEnabled(settings[SSH_AGENT_ENABLED_KEY])
}

export function readSshAgentAutoDownload(settings: Record<string, unknown>): boolean {
  return parseSshAgentAutoDownload(settings[SSH_AGENT_AUTO_DOWNLOAD_KEY])
}

let cachedSshAgentEnabled = parseSshAgentEnabled(DEFAULT_GLOBAL_SETTINGS[SSH_AGENT_ENABLED_KEY])
let cachedSshAgentAutoDownload = parseSshAgentAutoDownload(
  DEFAULT_GLOBAL_SETTINGS[SSH_AGENT_AUTO_DOWNLOAD_KEY],
)

export function getSshAgentEnabled(): boolean {
  return cachedSshAgentEnabled
}

export function getSshAgentAutoDownload(): boolean {
  return cachedSshAgentAutoDownload
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
  } catch (e) {
    console.error('ssh_set_agent_enabled failed:', e)
  }
}
