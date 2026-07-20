import { openPath } from '@tauri-apps/plugin-opener'
import { choiceDialog } from '../store/choiceStore'
import { useProjectStore } from '../store/projectStore'
import { isTauri, safeInvoke } from './tauri'
import { translate } from './i18n'
import {
  isVersionSkipped,
  loadUpdateSettings,
  saveSkippedVersion,
} from './updateSettings'

export type AppUpdateInfo = {
  update_available: boolean
  current: string
  latest: string
  notes: string | null
  page_url: string
  download_url: string | null
  source: string
}

export async function fetchAppUpdateInfo(currentVersion: string): Promise<AppUpdateInfo> {
  if (!isTauri()) {
    throw new Error(translate('检查更新需要 Tauri 桌面环境'))
  }
  return safeInvoke<AppUpdateInfo>('检查更新', 'check_app_update', {
    currentVersion,
  })
}

export async function downloadAppUpdate(info: AppUpdateInfo): Promise<string> {
  const url = info.download_url?.trim()
  if (!url) {
    throw new Error(translate('未找到安装包下载地址'))
  }
  return safeInvoke<string>('下载更新', 'download_app_update', { url })
}

export async function runAppUpdateDownload(info: AppUpdateInfo): Promise<void> {
  const pushToast = useProjectStore.getState().pushToast
  pushToast('info', translate('正在下载安装包…'))
  try {
    const savedPath = await downloadAppUpdate(info)
    await openPath(savedPath)
    pushToast('success', translate('安装包已下载，正在打开安装程序'))
  } catch (error) {
    pushToast('error', translate('下载失败: {error}', { error: String(error) }))
    throw error
  }
}

/**
 * Show the update dialog. Returns the chosen action id, or null if dismissed.
 * Actions: `download` | `skip` | `later`
 */
export async function promptAppUpdate(info: AppUpdateInfo): Promise<string | null> {
  const detailParts = [
    translate('当前版本：{current} → 最新版本：{latest}', {
      current: info.current,
      latest: info.latest,
    }),
    info.source ? translate('来源：{source}', { source: info.source }) : null,
    info.notes?.trim() || null,
  ].filter(Boolean)

  const choice = await choiceDialog({
    title: translate('发现新版本'),
    message: translate('QingCode {version} 可用。是否下载安装包？', {
      version: info.latest,
    }),
    detail: detailParts.join('\n\n'),
    detailMarkdown: true,
    options: [
      { id: 'download', label: translate('下载安装包'), primary: true },
      { id: 'skip', label: translate('跳过此版本') },
      { id: 'later', label: translate('稍后') },
    ],
  })

  if (choice === 'download') {
    await runAppUpdateDownload(info)
  } else if (choice === 'skip') {
    await saveSkippedVersion(info.latest)
  }
  return choice
}

/** Manual or automatic check. Returns info when an update is available and not skipped. */
export async function checkForAppUpdate(options?: {
  currentVersion?: string
  /** When true, ignore skippedVersion and always prompt if newer. */
  ignoreSkip?: boolean
  /** When false, do not show the dialog (caller handles UI). Default true. */
  prompt?: boolean
}): Promise<AppUpdateInfo | null> {
  const prompt = options?.prompt ?? true
  let version = options?.currentVersion
  if (!version) {
    const { getVersion } = await import('@tauri-apps/api/app')
    version = await getVersion()
  }
  const info = await fetchAppUpdateInfo(version)
  if (!info.update_available) return null

  if (!options?.ignoreSkip) {
    const { skippedVersion } = await loadUpdateSettings()
    if (isVersionSkipped(info.latest, skippedVersion)) return null
  }

  if (prompt) {
    await promptAppUpdate(info)
  }
  return info
}
