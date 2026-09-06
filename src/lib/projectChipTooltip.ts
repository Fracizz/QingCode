import type { Project, SshConnection } from '../types'
import {
  isSshProject,
  sshConnectionIdFromUri,
  sshConnectionLabel,
  sshRemotePathFromUri,
} from './sshWorkspace'

type Translate = (source: string, values?: Record<string, string | number>) => string

export function projectChipTooltipLabel(
  project: Project,
  connections: ReadonlyArray<SshConnection>,
  t: Translate
): string {
  if (!isSshProject(project)) return project.name

  const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
  const connection = connections.find(item => item.id === connectionId)
  const connectionLabel = connection
    ? sshConnectionLabel(connection)
    : connectionId || t('未知 SSH 连接')
  const remotePath = project.root_path || sshRemotePathFromUri(project.path)

  return [
    `${project.name} · ${t('SSH 远程项目')}`,
    t('SSH 连接：{connection}', { connection: connectionLabel }),
    t('远程路径：{path}', { path: remotePath }),
  ].join('\n')
}
