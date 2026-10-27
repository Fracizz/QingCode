import type { Project, SshConnection } from '../types'
import {
  isSshProject,
  sshConnectionIdFromUri,
  sshConnectionTarget,
  sshRemotePathFromUri,
} from './sshWorkspace'
import { isWslProject, wslDistroNameFromPath, wslDistroPathFromPath } from './wslWorkspace'

export interface ProjectLabel {
  name: string
  source: string | null
  text: string
}

function sourceInfo(
  project: Project,
  connections: ReadonlyMap<string, SshConnection>,
  localLabel: string
) {
  if (isWslProject(project)) {
    const distro = wslDistroNameFromPath(project.path)
    return {
      identity: `wsl:${distro ?? ''}`,
      label: 'WSL',
      detail: distro ? `WSL · ${distro}` : 'WSL',
      path: wslDistroPathFromPath(project.path) ?? project.path,
    }
  }
  if (isSshProject(project)) {
    const id = project.connection_id || sshConnectionIdFromUri(project.path) || ''
    const connection = connections.get(id)
    const target = connection ? sshConnectionTarget(connection) : id
    const label = connection?.name.trim() || target || 'SSH'
    return {
      identity: `ssh:${id}`,
      label,
      detail: target && target !== label ? `${label} · ${target}` : label,
      path: project.root_path || sshRemotePathFromUri(project.path),
    }
  }
  return { identity: 'local', label: localLabel, detail: localLabel, path: project.path }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(0, index) || '/'
}

function pathSuffix(path: string, depth: number): string {
  const parts = path.split('/').filter(Boolean)
  return depth > parts.length ? path : parts.slice(-depth).join('/')
}

/** Derived display labels only: include hidden projects so hiding/filtering never changes identity. */
export function buildProjectLabels(
  projects: ReadonlyArray<Project>,
  connections: ReadonlyArray<SshConnection>,
  localLabel: string
): Map<string, ProjectLabel> {
  const result = new Map<string, ProjectLabel>()
  const groups = new Map<string, Project[]>()
  const connectionsById = new Map(connections.map(connection => [connection.id, connection]))
  for (const project of projects) {
    result.set(project.id, { name: project.name, source: null, text: project.name })
    const key = project.name.trim().normalize('NFC').toLowerCase()
    const group = groups.get(key) ?? []
    group.push(project)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const entries = group.map(project => ({
      project,
      info: sourceInfo(project, connectionsById, localLabel),
    }))
    const sources = entries.map(({ info }) =>
      entries.some(
        other => other.info.label === info.label && other.info.identity !== info.identity
      )
        ? info.detail
        : info.label
    )
    entries.forEach(({ project, info }, index) => {
      let source = sources[index]
      const peers = entries.filter(
        (_, peerIndex) => peerIndex !== index && sources[peerIndex] === source
      )
      if (peers.length) {
        const path = normalizePath(info.path)
        const parent = parentPath(path)
        let suffix = path
        for (let depth = 1; depth <= parent.split('/').length; depth++) {
          const candidate = pathSuffix(parent, depth)
          if (
            peers.every(
              peer => pathSuffix(parentPath(normalizePath(peer.info.path)), depth) !== candidate
            )
          ) {
            suffix = candidate
            break
          }
        }
        source = `${source} · ${suffix}`
        // Duplicate records / equivalent connection targets can even share a root.
        if (peers.some(peer => normalizePath(peer.info.path) === path)) source += ` · ${project.id}`
      }
      result.set(project.id, { name: project.name, source, text: `${project.name} [${source}]` })
    })
  }
  return result
}
