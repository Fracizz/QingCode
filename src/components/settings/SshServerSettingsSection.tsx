import { useEffect, useState } from 'react'
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../lib/i18n'
import { isTauri, safeInvoke } from '../../lib/tauri'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/projectSettings'
import {
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  getSshServerAutoDownload,
  getSshServerEnabled,
  getSshServerOfflineDir,
  loadScopedSshServerAutoDownload,
  loadScopedSshServerEnabled,
  loadScopedSshServerOfflineDir,
  parseSshServerAutoDownload,
  saveScopedSshServerAutoDownload,
  saveScopedSshServerEnabled,
  saveScopedSshServerOfflineDir,
} from '../../lib/sshServerSettings'
import { isSshProject } from '../../lib/sshWorkspace'
import { useProjectStore } from '../../store/projectStore'
import type { Project } from '../../types'
import { SettingItem } from '../SettingsLayout'
import Tooltip from '../Tooltip'

type Props = {
  /** 设置页当前作用域：user=全局默认，workspace=当前项目。 */
  scope: 'user' | 'workspace'
  /** 当前激活项目；workspace 作用域必填，user 作用域用于判断是否停远端服务。 */
  project: Project | null
  /** 设置导入等外部变更的刷新信号。 */
  settingsRevision: number
}

/**
 * SSH 远端服务（qingcode-server）设置分区：总开关、自动下载、离线目录。
 * 从 SettingsEditor 迁出，行为保持不变。
 */
export default function SshServerSettingsSection({ scope, project, settingsRevision }: Props) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const [enabled, setEnabled] = useState(getSshServerEnabled)
  const [autoDownload, setAutoDownload] = useState(getSshServerAutoDownload)
  const [offlineDir, setOfflineDir] = useState(getSshServerOfflineDir)
  const [offlineBusy, setOfflineBusy] = useState(false)

  useEffect(() => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    void loadScopedSshServerEnabled(settingsScope, project).then(setEnabled)
    void loadScopedSshServerAutoDownload(settingsScope, project).then(setAutoDownload)
    void loadScopedSshServerOfflineDir(settingsScope, project).then(setOfflineDir)
  }, [scope, project, settingsRevision])

  const updateEnabled = async (value: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !project) return
    setEnabled(value)
    try {
      await saveScopedSshServerEnabled(settingsScope, value, project)
    } catch (error) {
      pushToast('error', t('保存远端服务开关失败: {error}', { error: String(error) }))
      return
    }
    // 关闭服务且当前激活项目是 SSH 工作区时停掉远端服务（fire-and-forget）；
    // 成功不提示，ssh-server-state 事件会刷新状态芯片。
    if (!value && project && isSshProject(project)) {
      void safeInvoke('停止远端服务', 'ssh_server_stop', { rootUri: project.path }).catch(
        error => {
          pushToast('error', t('停止远端服务失败: {error}', { error: String(error) }))
        },
      )
    }
  }

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

  const chooseOfflineDir = async () => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !project) return
    if (!isTauri()) {
      pushToast('error', t('当前环境无法选择离线目录'))
      return
    }
    const selected = await openDirectoryDialog({
      directory: true,
      multiple: false,
      title: t('选择离线服务目录'),
    })
    if (typeof selected !== 'string' || !selected) return
    setOfflineBusy(true)
    try {
      // 目录校验与解析（如定位 servers 子目录）只在 Rust 的
      // ssh_set_server_offline_dir 里实现：保留这一次 invoke 做即时校验并拿到
      // 解析结果；持久化与推送统一走 saveScopedSshServerOfflineDir（内部以同一
      // 解析结果推送），保证文件与 native 状态单一事实来源。
      const resolved = await safeInvoke<string>(
        '配置 SSH 离线服务目录',
        'ssh_set_server_offline_dir',
        { dir: selected },
      )
      setOfflineDir(resolved)
      await saveScopedSshServerOfflineDir(settingsScope, resolved, project)
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
        title={t('SSH › 服务: 远端服务')}
        description={t(
          '在 SSH 工作区部署远端服务（qingcode-server），提供文件树自动刷新、内嵌内容搜索（无需远端 rg）与快速目录扫描。服务经 SSH 通道接入，只监听远端 127.0.0.1。关闭后完全回退纯 SSH 直连，远端零足迹。默认开启。',
        )}
        modified={!enabled}
      >
        <select
          value={enabled ? 'on' : 'off'}
          onChange={e => void updateEnabled(e.target.value === 'on')}
          className="setting-control setting-select"
          aria-label={t('SSH › 服务: 远端服务')}
        >
          <option value="on">{t('开启')}</option>
          <option value="off">{t('关闭')}</option>
        </select>
      </SettingItem>
      <SettingItem
        title={t('SSH › 服务: 缺失时自动下载')}
        description={t(
          '安装包不附带远端服务。缺失时从 GitHub Release 在线下载并做 sha256 校验。也可以在下面手动选择离线目录。默认开启。',
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
          '手动选择解压后的 servers 目录，或包含 servers 子目录的文件夹。选中后优先于程序旁边的 servers 和在线下载。清除后恢复自动查找。',
        )}
        modified={offlineDir !== ''}
      >
        <div className="flex items-center gap-1.5 max-w-md">
          <Tooltip
            label={offlineDir}
            onlyWhenOverflow
            side="top"
            wrapperClassName="min-w-0 flex-1"
          >
            <span className="block truncate text-ui-sm opacity-80">
              {offlineDir || t('未选择离线目录')}
            </span>
          </Tooltip>
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
