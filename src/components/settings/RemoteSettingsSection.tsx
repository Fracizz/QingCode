import { useI18n } from '../../lib/i18n'
import {
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  SSH_SERVER_ENABLED_KEY,
  SSH_SERVER_OFFLINE_DIR_KEY,
} from '../../lib/sshServerSettings'
import { useUIStore } from '../../store/uiStore'
import type { Project } from '../../types'
import { SettingItem } from '../SettingsLayout'
import SshServerSettingsSection from './SshServerSettingsSection'
import type { SettingsMatch, SettingsScope } from './types'

/** SSH 远端服务设置的搜索关键词：分区可见性与行级过滤共用同一份列表。 */
const SSH_SERVER_SEARCH_TERMS: string[] = [
  '远程连接',
  'SSH 连接',
  'SSH 服务',
  '远端服务',
  '自动下载',
  '离线目录',
  SSH_SERVER_ENABLED_KEY,
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  SSH_SERVER_OFFLINE_DIR_KEY,
]

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  scope: SettingsScope
  project: Project | null
  settingsRevision: number
}

/** 远程连接分区：远程连接管理入口与 SSH 远端服务设置。 */
export default function RemoteSettingsSection({
  match,
  workspaceLocked,
  scope,
  project,
  settingsRevision,
}: Props) {
  const { t } = useI18n()

  return (
    <>
      {!workspaceLocked && match('远程连接', 'SSH 连接') && (
        <SettingItem
          title={t('远程连接')}
          description={t(
            '集中管理 SSH 主机：新建、编辑、测试连接、断开，并查看挂在主机下的远程项目与远端服务。',
          )}
        >
          <button
            type="button"
            className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60"
            onClick={() => useUIStore.getState().openRemoteConnections()}
          >
            {t('管理远程连接…')}
          </button>
        </SettingItem>
      )}
      {match(...SSH_SERVER_SEARCH_TERMS) && (
        <SshServerSettingsSection
          scope={scope}
          project={project}
          settingsRevision={settingsRevision}
        />
      )}
    </>
  )
}
