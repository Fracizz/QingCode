import type { FileNode } from './fileTreeHelpers'
import { collectAncestorDirs, normalizePath, pathSetHas } from './fileReferences'

export type PendingCreate = {
  projectId: string
  parentPath: string
  directory: boolean
  depth: number
}

export type VisibleTreeRow =
  | { kind: 'node'; node: FileNode; depth: number }
  | { kind: 'create'; depth: number; directory: boolean }

export function createTreeDepth(parentPath: string, projectPath: string): number {
  const root = normalizePath(projectPath)
  const parent = normalizePath(parentPath)
  if (parent.toLowerCase() === root.toLowerCase()) return 1
  const rel = parent.slice(root.length).replace(/^\/+/, '')
  return rel.split('/').filter(Boolean).length + 1
}

export function dirsToReveal(parentPath: string, projectPath: string): string[] {
  const root = normalizePath(projectPath)
  const parent = normalizePath(parentPath)
  if (parent.toLowerCase() === root.toLowerCase()) return []
  return collectAncestorDirs(`${parent}/.placeholder`, projectPath)
}

/** Flatten an expanded file tree into virtualized sidebar rows. */
export function flattenVisibleNodes(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  pendingCreate: PendingCreate | null,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = []
  const visit = (node: FileNode, depth: number) => {
    rows.push({ kind: 'node', node, depth })
    if (!node.is_dir || !pathSetHas(expandedPaths, node.path)) return
    if (pendingCreate?.parentPath === node.path) {
      rows.push({ kind: 'create', depth: depth + 1, directory: pendingCreate.directory })
    }
    if (node.loaded) node.children?.forEach(child => visit(child, depth + 1))
  }
  nodes.forEach(node => visit(node, 1))
  return rows
}
