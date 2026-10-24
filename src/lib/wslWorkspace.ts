import type { Project, SshConnection } from '../types'
import { sshConnectionIdFromUri } from './sshWorkspace'

/**
 * Checks whether a path string represents a WSL path.
 *
 * Supported formats:
 * - Windows UNC paths:
 *   \\wsl$\<distro>\...
 *   \\wsl.localhost\<distro>\...
 *   //wsl$/<distro>/...
 *   //wsl.localhost/<distro>/...
 * - Custom URI scheme:
 *   wsl://<distro>/...
 */
export function isWslPath(path: string | null | undefined): boolean {
  if (!path) return false
  const trimmed = path.trim()
  if (/^[/\\]{1,2}(?:wsl\$|wsl\.localhost)(?:[/\\]|$)/i.test(trimmed)) return true
  if (/^wsl:\/\//i.test(trimmed)) return true
  return false
}

/**
 * Checks whether a project is a WSL project.
 *
 * A project is considered WSL if:
 * - `project.kind === 'wsl'`, or
 * - `project.path` matches a WSL path, or
 * - it is an SSH project whose connection name is 'WSL' (case-insensitive) or connection_id is 'wsl'.
 */
export function isWslProject(
  project:
    | (Pick<Project, 'kind' | 'path'> & Partial<Pick<Project, 'connection_id'>>)
    | null
    | undefined,
  connections?: ReadonlyArray<Pick<SshConnection, 'id' | 'name'>>
): boolean {
  if (!project) return false
  if (project.kind === 'wsl') return true
  if (isWslPath(project.path)) return true

  const connectionId = project.connection_id || (project.path ? sshConnectionIdFromUri(project.path) : undefined)
  if (connectionId) {
    if (connectionId.toLowerCase() === 'wsl') return true
    if (connections) {
      const conn = connections.find(c => c.id === connectionId)
      if (conn && conn.name.trim().toLowerCase() === 'wsl') {
        return true
      }
    }
  }

  return false
}

/**
 * Extracts the WSL distribution name from a WSL path if present.
 * Example: `\\wsl$\Ubuntu\home\user` -> `'Ubuntu'`
 * Example: `\\wsl.localhost\Debian\root` -> `'Debian'`
 * Example: `wsl://Ubuntu/home/user` -> `'Ubuntu'`
 */
export function wslDistroNameFromPath(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const match = path.trim().match(/^[/\\]{1,2}(?:wsl\$|wsl\.localhost)[/\\]([^/\\]+)/i)
  if (match) return match[1]
  const uriMatch = path.trim().match(/^wsl:\/\/([^/\\]+)/i)
  return uriMatch?.[1] || undefined
}

/**
 * Extracts the POSIX path inside the WSL distribution from a WSL path.
 * Example: `\\wsl$\Ubuntu\home\code\app` -> `'/home/code/app'`
 * Example: `\\wsl.localhost\Ubuntu\etc\hosts` -> `'/etc/hosts'`
 * Example: `wsl://Ubuntu/home/code/app` -> `'/home/code/app'`
 */
export function wslDistroPathFromPath(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const match = path.trim().match(/^[/\\]{1,2}(?:wsl\$|wsl\.localhost)[/\\][^/\\]+([/\\]?.*)$/i)
  if (match) {
    const rest = match[1].replace(/\\/g, '/')
    return rest.startsWith('/') ? rest : `/${rest}`
  }
  const uriMatch = path.trim().match(/^wsl:\/\/[^/\\]+([/\\]?.*)$/i)
  if (uriMatch) {
    const rest = uriMatch[1].replace(/\\/g, '/')
    return rest.startsWith('/') ? rest : `/${rest}`
  }
  return undefined
}
