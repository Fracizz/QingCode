import type { Project, SshConnection, TerminalTab } from '@/types'
import { planTerminalRestore } from './terminalRestorePlan'
import { isSshProject, resolveSshConnectionMode, sshConnectionIdFromUri } from '../sshWorkspace'

/** 本机项目（含本机托管终端）共用的分组键。 */
export const LOCAL_REATTACH_LANE = '__local__'

type PendingTab = Pick<
  TerminalTab,
  'projectId' | 'persistent' | 'ptyId' | 'connectionId' | 'cwd' | 'awaitingRestoreSpawn'
>

/** 项目里是否有等待接回、且原进程可能仍在运行的标签（需要新建的不算）。 */
export function hasPendingReattach(projectId: string, terminals: readonly PendingTab[]): boolean {
  return terminals.some(tab => tab.projectId === projectId && planTerminalRestore(tab).mode === 'attach')
}

/**
 * 启动后要在后台自动接回的项目，按连接分组：不同连接并发，同一连接内按最近打开顺序串行。
 * 远端只处理 Server 模式（兼容模式没有持久终端）且主机指纹已确认、未被用户主动断开的连接；
 * 需要输入密码的连接在建立连接时自行失败，同样不打扰用户。
 */
export function autoReattachLanes(
  projects: readonly Project[],
  connections: readonly SshConnection[],
  terminals: readonly PendingTab[],
  options: {
    serverEnabled: boolean
    trusted: (project: Project) => boolean
    suspended: (connectionId: string) => boolean
  },
): Project[][] {
  const hosts = new Map(connections.map(connection => [connection.id, connection]))
  const lanes = new Map<string, Project[]>()
  const sorted = [...projects].sort((a, b) => b.last_opened_at - a.last_opened_at)
  for (const project of sorted) {
    if (project.ephemeral || !options.trusted(project)) continue
    if (!hasPendingReattach(project.id, terminals)) continue
    let key = LOCAL_REATTACH_LANE
    if (isSshProject(project)) {
      const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
      const connection = connectionId ? hosts.get(connectionId) : undefined
      if (!connection?.host_key_fingerprint) continue
      if (resolveSshConnectionMode(connection, options.serverEnabled) !== 'server') continue
      if (options.suspended(connection.id)) continue
      key = connection.id
    }
    lanes.set(key, [...(lanes.get(key) ?? []), project])
  }
  return [...lanes.values()]
}
