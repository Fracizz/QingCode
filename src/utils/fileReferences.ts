import type { Project } from '../types'
import { isTauri, safeInvoke } from '../lib/tauri'

/**
 * Copy text to the system clipboard.
 * In Tauri, prefer the native write — WebView `navigator.clipboard` often fails
 * for keyboard shortcuts (no transient user activation).
 */
export async function copyToClipboard(text: string) {
  if (isTauri()) {
    await safeInvoke('写入剪贴板', 'clipboard_write_text', { text })
    return
  }
  await navigator.clipboard.writeText(text)
}

export function findProjectForPath(projects: Project[], filePath: string) {
  const normalizedFile = normalizePath(filePath).toLowerCase()
  return projects
    .filter(project => {
      const root = normalizePath(project.path).toLowerCase()
      return normalizedFile === root || normalizedFile.startsWith(`${root}/`)
    })
    .sort((a, b) => b.path.length - a.path.length)[0]
}

export function formatFileReference(
  project: Project,
  filePath: string,
  startLine: number,
  endLine = startLine
) {
  const relative = projectRelativePath(project.path, filePath)
  const lineSuffix = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`
  return `@${project.name}/${relative}${lineSuffix}`
}

const FILE_REFERENCE_LINE_RE = /#L(\d+)(?:-L(\d+))?$/i

export type ParsedFileReference = {
  /** Project display name from `@Name/…`, if present. */
  projectName?: string
  /** Path portion used for fuzzy / exact matching (no `@project/` or `#L…`). */
  fileQuery: string
  line?: number
  endLine?: number
}

/**
 * Inverse of {@link formatFileReference}: parse `@Project/rel#L10` / `rel#L10-L12`.
 * Also accepts a bare relative/absolute path with an optional `#L…` suffix.
 */
export function parseFileReference(input: string): ParsedFileReference {
  const trimmed = input.trim()
  if (!trimmed) return { fileQuery: '' }

  let rest = trimmed
  let line: number | undefined
  let endLine: number | undefined

  const lineMatch = rest.match(FILE_REFERENCE_LINE_RE)
  if (lineMatch && lineMatch.index !== undefined) {
    const start = Number.parseInt(lineMatch[1]!, 10)
    if (Number.isFinite(start) && start >= 1) {
      line = start
      if (lineMatch[2] !== undefined) {
        const end = Number.parseInt(lineMatch[2], 10)
        if (Number.isFinite(end) && end >= 1) endLine = end
      }
      rest = rest.slice(0, lineMatch.index)
    }
  }

  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/')
    if (slash > 1) {
      const projectName = rest.slice(1, slash).trim()
      const fileQuery = rest.slice(slash + 1).replace(/\\/g, '/')
      if (projectName && fileQuery) {
        return { projectName, fileQuery, line, endLine }
      }
    }
  }

  return { fileQuery: rest.replace(/\\/g, '/'), line, endLine }
}

export function projectRelativePath(projectPath: string, filePath: string) {
  const root = normalizePath(projectPath)
  const file = normalizePath(filePath)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1)
  }
  return file.split('/').pop() || file
}

/**
 * Toast detail for a file path: relative path under its project root.
 * Multi-root workspaces prefix the project name (`proj · path/to/file`).
 */
export function formatFileToastDetail(
  projects: Project[],
  filePath: string,
  fallbackName?: string,
): string {
  const project = findProjectForPath(projects, filePath)
  const relative = project
    ? projectRelativePath(project.path, filePath)
    : fallbackName?.trim() || normalizePath(filePath).split('/').pop() || filePath
  if (projects.length > 1 && project) {
    return `${project.name} · ${relative}`
  }
  return relative
}

export function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function parentPath(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 ? path.slice(0, separator) : path
}

export function pathsEqual(a: string, b: string) {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
}

/** True when `paths` already contains an entry equal to `path` (separator/case insensitive). */
export function pathSetHas(paths: Set<string>, path: string) {
  if (paths.has(path)) return true
  for (const entry of paths) {
    if (pathsEqual(entry, path)) return true
  }
  return false
}

/** Add `path` to a set unless an equal path is already present. */
export function addPathToSet(paths: Set<string>, path: string) {
  if (pathSetHas(paths, path)) return paths
  const next = new Set(paths)
  next.add(path)
  return next
}

/** True when `childPath` is the same as or nested under `ancestorPath`. */
export function isDescendantOf(childPath: string, ancestorPath: string) {
  const child = normalizePath(childPath).toLowerCase()
  const ancestor = normalizePath(ancestorPath).toLowerCase()
  return child === ancestor || child.startsWith(`${ancestor}/`)
}

/** Directory paths from project root down to the file's parent (excluding root). */
export function collectAncestorDirs(filePath: string, rootPath: string) {
  if (!isDescendantOf(filePath, rootPath)) return []
  const dirs: string[] = []
  let current = parentPath(filePath)
  while (isDescendantOf(current, rootPath) && !pathsEqual(current, rootPath)) {
    dirs.unshift(current)
    current = parentPath(current)
  }
  return dirs
}
