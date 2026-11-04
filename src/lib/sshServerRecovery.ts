import { open } from '@tauri-apps/plugin-dialog'
import type { Project } from '../types'
import { loadProjectSettings, saveProjectSettings, type SettingsFile } from './projectSettings'
import { SSH_SERVER_AUTO_DOWNLOAD_KEY, SSH_SERVER_OFFLINE_DIR_KEY } from './sshServerSettings'
import { safeInvoke } from './tauri'
import { translate } from './i18n'

export interface ServerPackageInfo {
  expectedVersion: string
  packageVersion: string | null
  sourcePath: string | null
  directory: string | null
  problem: string | null
}

export function inspectServerPackage(rootUri: string, dir?: string): Promise<ServerPackageInfo> {
  return safeInvoke('检查远端服务包', 'ssh_server_package_info', { rootUri, ...(dir ? { dir } : {}) })
}

/** All preflight is read-only. Persist only a validated source for the failed
 * project; never overwrite the active project's effective/global settings. */
export async function recoverServerPackage(
  project: Project,
  action: 'choose' | 'download',
  signal: AbortSignal,
  onInfo: (info: ServerPackageInfo) => void,
): Promise<boolean> {
  signal.throwIfAborted()
  let info: ServerPackageInfo
  if (action === 'choose') {
    const selected = await open({ directory: true, multiple: false, title: translate('选择离线服务目录') })
    signal.throwIfAborted()
    if (typeof selected !== 'string' || !selected) return false
    info = await inspectServerPackage(project.path, selected)
  } else {
    info = await safeInvoke<ServerPackageInfo>('下载远端服务包', 'ssh_download_server_package', { rootUri: project.path })
  }
  signal.throwIfAborted()
  onInfo(info)
  if (info.problem) throw new Error(info.problem)
  if (!info.directory) throw new Error(translate('未找到可用的服务目录'))
  const previous = await loadProjectSettings(project)
  signal.throwIfAborted()
  await safeInvoke('清除远端服务失败状态', 'ssh_reset_server_failure', { rootUri: project.path })
  signal.throwIfAborted()
  const next: SettingsFile = { ...previous, [SSH_SERVER_OFFLINE_DIR_KEY]: info.directory }
  if (action === 'download') next[SSH_SERVER_AUTO_DOWNLOAD_KEY] = true
  // Preserve the legacy download value before removing its alias.
  if (next[SSH_SERVER_AUTO_DOWNLOAD_KEY] === undefined && next['ssh.agent.autoDownload'] !== undefined) {
    next[SSH_SERVER_AUTO_DOWNLOAD_KEY] = next['ssh.agent.autoDownload']
  }
  delete next['ssh.agent.offlineDir']
  delete next['ssh.agent.autoDownload']
  await saveProjectSettings(project, next)
  signal.throwIfAborted()
  return true
}
