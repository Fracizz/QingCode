import { hasBackend } from '../../lib/runtimeCapabilities'
import { useEffect, useState } from 'react'
import { open as openLocalDialog } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../lib/i18n'
import { safeInvoke } from '../../lib/tauri'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/projectSettings'
import {
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  getSshServerAutoDownload,
  getSshServerOfflineDir,
  loadScopedSshServerAutoDownload,
  loadScopedSshServerOfflineDir,
  parseSshServerAutoDownload,
  saveScopedSshServerAutoDownload,
  saveScopedSshServerOfflineDir,
} from '../../lib/sshServerSettings'
import { useProjectStore } from '../../store/projectStore'
import type { Project } from '../../types'
import { SettingItem } from '../SettingsLayout'
import Tooltip from '../Tooltip'

type Props = {
  /** 设置页当前作用域：user=全局默认，workspace=当前项目。 */
  scope: 'user' | 'workspace'
  /** 当前激活项目；workspace 作用域必填。 */
  project: Project | null
  /** 设置导入等外部变更的刷新信号。 */
  settingsRevision: number
}

/**
 * SSH 远端服务（qingcode-server）设置分区：自动下载、离线目录。
 * 新建连接统一使用 Server；直连兼容选项仅在连接的高级设置中提供。
 */
export default function SshServerSettingsSection({ scope, project, settingsRevision }: Props) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const [autoDownload, setAutoDownload] = useState(getSshServerAutoDownload)
  const [offlineDir, setOfflineDir] = useState(getSshServerOfflineDir)
  const [offlineBusy, setOfflineBusy] = useState(false)

  useEffect(() => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    void loadScopedSshServerAutoDownload(settingsScope, project).then(setAutoDownload)
    void loadScopedSshServerOfflineDir(settingsScope, project).then(setOfflineDir)
  }, [scope, project, settingsRevision])

  const updateAutoDownload = async (value: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !project) return
    setAutoDownload(value)
    try {
      await saveScopedSshServerAutoDownload(settingsScope, value, project)
    } catch (error) {
      pushToast('error', t('保存自动下载设置失败: {error}', { error: String(error) }))
    }
  }

  const chooseOfflineDir = async (archive = false) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !project) return
    if (!hasBackend()) {
      pushToast('error', t('当前环境无法选择离线目录'))
      return
    }
    setOfflineBusy(true)
    try {
      const selected = await openLocalDialog({
        directory: !archive,
        multiple: false,
        title: archive ? t('选择离线 ZIP') : t('选择离线服务目录'),
        ...(archive ? { filters: [{ name: 'ZIP', extensions: ['zip'] }] } : {}),
      })
      if (typeof selected !== 'string' || !selected) return
      // Rust 校验目录或导入 ZIP，持久化与推送使用同一解析结果。
      const resolved = await safeInvoke<string>(
        archive ? '导入 SSH 离线服务包' : '配置 SSH 离线服务目录',
        archive ? 'ssh_import_server_archive' : 'ssh_set_server_offline_dir',
        archive ? { path: selected } : { dir: selected },
      )
      await saveScopedSshServerOfflineDir(settingsScope, resolved, project)
      setOfflineDir(resolved)
      pushToast('success', t('已使用离线服务目录'))
    } catch (error) {
      pushToast('error', t('保存离线服务目录失败: {error}', { error: String(error) }))
    } finally {
      setOfflineBusy(false)
    }
  }

  const clearOfflineDir = async () => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !project) return
    setOfflineBusy(true)
    try {
      setOfflineDir('')
      await saveScopedSshServerOfflineDir(settingsScope, '', project)
      pushToast('success', t('已清除离线服务目录'))
    } catch (error) {
      pushToast('error', t('保存离线服务目录失败: {error}', { error: String(error) }))
    } finally {
      setOfflineBusy(false)
    }
  }

  return (
    <>
      <SettingItem
        title={t('SSH › 服务: 缺失时自动下载')}
        description={t(
          '安装包不附带远端服务。缺失时由本机从 GitHub Release 下载并校验，再通过 SSH 上传。目标机器无需联网。也可选择下面的离线 ZIP 或目录。默认开启。',
        )}
        modified={
          autoDownload !==
          parseSshServerAutoDownload(DEFAULT_GLOBAL_SETTINGS[SSH_SERVER_AUTO_DOWNLOAD_KEY])
        }
      >
        <select
          value={autoDownload ? 'on' : 'off'}
          onChange={e => void updateAutoDownload(e.target.value === 'on')}
          className="setting-control setting-select"
          aria-label={t('SSH › 服务: 缺失时自动下载')}
        >
          <option value="on">{t('开启')}</option>
          <option value="off">{t('关闭')}</option>
        </select>
      </SettingItem>
      <SettingItem
        title={t('SSH › 服务: 离线目录')}
        description={t(
          '选择 QingCode-servers.zip，本机会解压并校验到缓存目录；也可选择解压后的 servers 目录。部署时通过 SSH 上传，目标机器无需联网。选中后优先于自动查找和下载。清除后恢复自动查找。',
        )}
        modified={offlineDir !== ''}
      >
        <div className="flex flex-wrap items-center gap-1.5 max-w-lg">
          <Tooltip
            label={offlineDir}
            onlyWhenOverflow
            side="top"
            wrapperClassName="min-w-0 basis-full"
          >
            <span className="block truncate text-ui-sm opacity-80">
              {offlineDir || t('未选择离线目录')}
            </span>
          </Tooltip>
          <button
            type="button"
            disabled={offlineBusy}
            className="setting-control shrink-0 px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
            aria-label={t('选择离线 ZIP')}
            onClick={() => void chooseOfflineDir(true)}
          >
            {t('选择离线 ZIP')}
          </button>
          <button
            type="button"
            disabled={offlineBusy}
            className="setting-control shrink-0 px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
            aria-label={t('选择离线目录')}
            onClick={() => void chooseOfflineDir()}
          >
            {t('选择离线目录')}
          </button>
          <button
            type="button"
            disabled={offlineBusy || !offlineDir}
            className="setting-control shrink-0 px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
            aria-label={t('清除离线目录')}
            onClick={() => void clearOfflineDir()}
          >
            {t('清除离线目录')}
          </button>
        </div>
      </SettingItem>
    </>
  )
}
