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

import type { InfoTipDetails } from './infoTip'

type Translate = (source: string, values?: Record<string, string | number>) => string

/** 顶栏项目标签和终端列表组头共用的悬停卡片内容。 */
export function projectHoverDetails(
  project: Project,
  connections: ReadonlyArray<SshConnection>,
  t: Translate
): InfoTipDetails {
  const folderRow = (value: string) => ({ label: t('项目目录'), value, mono: true })
  if (isWslProject(project)) {
    const distro = wslDistroNameFromPath(project.path)
    return {
      title: project.name,
      rows: [
        { label: t('连接方式'), value: 'WSL' },
        ...(distro ? [{ label: t('发行版'), value: distro }] : []),
        folderRow(wslDistroPathFromPath(project.path) || project.path),
      ],
    }
  }
  if (isSshProject(project)) {
    const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
    const connection = connections.find(item => item.id === connectionId)
    return {
      title: project.name,
      rows: [
        { label: t('连接方式'), value: 'SSH' },
        {
          label: t('地址'),
          value: connection ? sshConnectionLabel(connection) : connectionId || t('未知 SSH 连接'),
        },
        folderRow(project.root_path || sshRemotePathFromUri(project.path)),
      ],
    }
  }
  return {
    title: project.name,
    rows: [{ label: t('连接方式'), value: t('本机') }, folderRow(project.path)],
  }
}

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

  if (!isSshProject(project)) return [project.name, t('路径：{path}', { path: project.path })].join('\n')

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
