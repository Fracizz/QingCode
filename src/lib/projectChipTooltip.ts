import type { Project, SshConnection } from '../types'
import {
  isSshProject,
  sshConnectionIdFromUri,
  sshConnectionLabel,
  sshRemotePathFromUri,
} from './sshWorkspace'
import {
  isWslProject,
  wslDistroNameFromPath,
  wslDistroPathFromPath,
} from './wslWorkspace'

type Translate = (source: string, values?: Record<string, string | number>) => string

export function projectChipTooltipLabel(
  project: Project,
  connections: ReadonlyArray<SshConnection>,
  t: Translate
): string {
  if (isWslProject(project)) {
    const distro = wslDistroNameFromPath(project.path)
    const posixPath = wslDistroPathFromPath(project.path)
    const title = distro
      ? `${project.name} · ${t('WSL 项目')}（${distro}）`
      : `${project.name} · ${t('WSL 项目')}`
    const pathLine = posixPath
      ? t('WSL 路径：{path}', { path: posixPath })
      : t('路径：{path}', { path: project.path })
    return [title, pathLine].join('\n')
  }

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
