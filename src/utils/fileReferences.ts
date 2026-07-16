import type { Project } from '../types'

export async function copyToClipboard(text: string) {
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

function projectRelativePath(projectPath: string, filePath: string) {
  const root = normalizePath(projectPath)
  const file = normalizePath(filePath)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1)
  }
  return file.split('/').pop() || file
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

/** True when `childPath` is the same as or nested under `ancestorPath`. */
export function isDescendantOf(childPath: string, ancestorPath: string) {
  const child = normalizePath(childPath).toLowerCase()
  const ancestor = normalizePath(ancestorPath).toLowerCase()
  return child === ancestor || child.startsWith(`${ancestor}/`)
}

/** Directory paths from project root down to the file's parent (excluding root). */
export function collectAncestorDirs(filePath: string, rootPath: string) {
  const normRoot = normalizePath(rootPath).toLowerCase()
  const dirs: string[] = []
  let current = parentPath(filePath)
  while (normalizePath(current).toLowerCase().length >= normRoot.length) {
    if (normalizePath(current).toLowerCase() === normRoot) break
    dirs.unshift(current)
    current = parentPath(current)
  }
  return dirs
}
