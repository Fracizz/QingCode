import type { Project } from '../types'

/** 本机 WSL 发行版的 UNC 根目录，用作文件夹选择器的初始位置。 */
export const WSL_ROOT_PATH = '\\\\wsl.localhost\\'

/** WSL 仅在 Windows 宿主上可用。 */
export function wslSupported(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /windows/i.test(userAgent)
}

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
 * Checks whether a project is a local WSL project.
 *
 * Only the explicit `kind` and the project path decide. SSH connection names are
 * user-defined labels, so an SSH project named "WSL" must stay an SSH project.
 */
export function isWslProject(
  project: Pick<Project, 'kind' | 'path'> | null | undefined
): boolean {
  if (!project) return false
  if (project.kind === 'wsl') return true
  return isWslPath(project.path)
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
