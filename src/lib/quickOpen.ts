import type { FileNode } from './fileTreeCache'
import { fuzzyScore } from './commands'
import { normalizePath } from '../utils/fileReferences'

export type QuickOpenEntry = {
  id: string
  path: string
  label: string
  relativePath: string
  projectName: string
}

function projectRelativePath(projectPath: string, filePath: string) {
  const root = normalizePath(projectPath)
  const file = normalizePath(filePath)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1)
  }
  return file.split('/').pop() || file
}

function walkFiles(
  nodes: FileNode[],
  out: QuickOpenEntry[],
  projectPath: string,
  projectName: string,
) {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) walkFiles(node.children, out, projectPath, projectName)
      continue
    }
    out.push({
      id: node.path,
      path: node.path,
      label: node.name,
      relativePath: projectRelativePath(projectPath, node.path),
      projectName,
    })
  }
}

export function collectQuickOpenFiles(
  projects: Array<{ id: string; name: string; path: string }>,
  projectTrees: Record<string, FileNode[]>,
): QuickOpenEntry[] {
  const out: QuickOpenEntry[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    const tree = projectTrees[project.id]
    if (!tree) continue
    walkFiles(tree, out, project.path, project.name)
  }
  return out.filter(entry => {
    const key = entry.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function filterQuickOpenFiles(
  entries: QuickOpenEntry[],
  query: string,
  limit = 12,
): Array<QuickOpenEntry & { score: number }> {
  const trimmed = query.trim()
  if (!trimmed) {
    return entries.slice(0, limit).map(entry => ({ ...entry, score: 1 }))
  }
  const ranked = entries
    .map(entry => {
      const haystack = `${entry.label} ${entry.relativePath} ${entry.projectName}`
      const score = fuzzyScore(query, haystack)
      return score > 0 ? { ...entry, score } : null
    })
    .filter((entry): entry is QuickOpenEntry & { score: number } => entry !== null)
  ranked.sort(
    (a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath, 'zh-CN'),
  )
  return ranked.slice(0, limit)
}
