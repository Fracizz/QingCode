import { translate } from '../i18n'
import { sshConnectionIdFromUri } from '../sshWorkspace'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'

/** 原生预热池在远端 daemon 过旧、无法启动 CLI 预热时发给所属窗口的事件。 */
export const CLI_PREWARM_SERVER_OUTDATED_EVENT = 'cli-prewarm-server-outdated'

// 每条连接每次运行只提示一次：配置刷新会重建预热池并再次上报。
const notified = new Set<string>()

/** 非阻塞提示：自动消失的 toast，附「远程连接」入口用于升级远端服务。 */
export function notifyCliPrewarmServerOutdated(cwd: unknown) {
  if (typeof cwd !== 'string') return
  const connectionId = sshConnectionIdFromUri(cwd)
  if (!connectionId || notified.has(connectionId)) return
  notified.add(connectionId)
  const name = useProjectStore.getState().sshConnections.find(c => c.id === connectionId)?.name ?? connectionId
  useProjectStore.getState().pushToast(
    'info',
    translate('{name} 的远端服务需升级后 CLI 预热才生效', { name }),
    translate('终端已按普通 Shell 预热照常打开；远端仍有运行中的终端时升级会被推迟。'),
    { label: translate('远程连接'), onAction: () => useUIStore.getState().openRemoteConnections() },
  )
}

export function resetCliPrewarmServerOutdatedNotices() {
  notified.clear()
}
