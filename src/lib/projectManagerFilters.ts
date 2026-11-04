import type { Project, SshConnection } from '../types'
import type { ProjectLabel } from './projectLabels'
import {
  isSshProject,
  sshConnectionIdFromUri,
  sshConnectionLabel,
  sshProjectDisplayPath,
} from './sshWorkspace'
import { isWslProject, wslDistroNameFromPath, wslDistroPathFromPath } from './wslWorkspace'

export interface ProjectFilterData {
  kind: 'local' | 'wsl' | 'ssh'
  source: string
  sourceLabel: string
  searchText: string
}

/** Search all source metadata, even when a unique name has no visible source badge. */
export function buildProjectFilterData(
  projects: ReadonlyArray<Project>,
  connections: ReadonlyArray<SshConnection>,
  labels: ReadonlyMap<string, ProjectLabel>,
  localLabel: string
): Map<string, ProjectFilterData> {
  const connectionsById = new Map(connections.map(connection => [connection.id, connection]))
  return new Map(
    projects.map(project => {
      let kind: ProjectFilterData['kind'] = 'local'
      let source = 'local'
      let sourceLabel = localLabel
      const fields = [project.name, project.path, project.root_path, labels.get(project.id)?.text]
      if (isWslProject(project)) {
        kind = 'wsl'
        const distro = wslDistroNameFromPath(project.path)
        source = distro ? `wsl:${distro}` : 'wsl'
        sourceLabel = distro ? `WSL · ${distro}` : 'WSL'
        fields.push(wslDistroPathFromPath(project.path))
      } else if (isSshProject(project)) {
        kind = 'ssh'
        const id = project.connection_id || sshConnectionIdFromUri(project.path) || ''
        const connection = connectionsById.get(id)
        source = `ssh:${id}`
        sourceLabel = connection ? sshConnectionLabel(connection) : 'SSH'
        fields.push(
          sshProjectDisplayPath(project, connection),
          connection?.host,
          connection?.username
        )
      }
      fields.push(kind, sourceLabel)
      return [
        project.id,
        {
          kind,
          source,
          sourceLabel,
          searchText: fields.filter(Boolean).join('\n').toLowerCase(),
        },
      ]
    })
  )
}
