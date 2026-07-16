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

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}
