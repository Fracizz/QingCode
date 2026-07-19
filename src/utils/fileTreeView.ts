import type { FileNode } from './fileTreeHelpers'
import { collectAncestorDirs, isDescendantOf, normalizePath, pathSetHas, pathsEqual } from './fileReferences'

export type PendingCreate = {
  projectId: string
  parentPath: string
  directory: boolean
  depth: number
}

export type PendingRename = {
  path: string
  name: string
  isDir: boolean
  depth: number
}

export type VisibleTreeRow =
  | { kind: 'node'; node: FileNode; depth: number }
  | { kind: 'create'; depth: number; directory: boolean }
  | { kind: 'rename'; node: FileNode; depth: number }

export function createTreeDepth(parentPath: string, projectPath: string): number {
  const root = normalizePath(projectPath)
  const parent = normalizePath(parentPath)
  if (pathsEqual(parent, root)) return 1
  if (!isDescendantOf(parent, projectPath)) return 1
  const rel = parent.slice(root.length).replace(/^\/+/, '')
  return rel.split('/').filter(Boolean).length + 1
}

export function dirsToReveal(parentPath: string, projectPath: string): string[] {
  const root = normalizePath(projectPath)
  const parent = normalizePath(parentPath)
  if (parent.toLowerCase() === root.toLowerCase()) return []
  return collectAncestorDirs(`${parent}/.placeholder`, projectPath)
}

export function findVisibleNodeRowIndex(rows: VisibleTreeRow[], targetPath: string): number {
  return rows.findIndex(
    row =>
      (row.kind === 'node' || row.kind === 'rename') && pathsEqual(row.node.path, targetPath),
  )
}

/** Row index to scroll to when revealing a path; null when the row is not visible yet. */
export function resolveTreeRevealScrollIndex(
  rows: VisibleTreeRow[],
  revealPath: string,
  projectPath: string,
  pendingCreate: PendingCreate | null,
): number | null {
  if (pathsEqual(revealPath, projectPath)) return 0
  if (pendingCreate) {
    const createIndex = rows.findIndex(row => row.kind === 'create')
    if (createIndex >= 0) return createIndex
  }
  const index = findVisibleNodeRowIndex(rows, revealPath)
  return index >= 0 ? index : null
}

export type VisibleNodeMove = 'up' | 'down' | 'home' | 'end'

/** Move keyboard selection among visible node rows (skips inline-create rows). */
export function moveVisibleNodeSelection(
  rows: VisibleTreeRow[],
  currentPath: string | null,
  direction: VisibleNodeMove,
): FileNode | null {
  const nodeRows = rows.filter(
    (row): row is Extract<VisibleTreeRow, { kind: 'node' | 'rename' }> =>
      row.kind === 'node' || row.kind === 'rename',
  )
  if (nodeRows.length === 0) return null

  const currentIndex = currentPath
    ? nodeRows.findIndex(row => pathsEqual(row.node.path, currentPath))
    : -1

  let nextIndex: number
  switch (direction) {
    case 'home':
      nextIndex = 0
      break
    case 'end':
      nextIndex = nodeRows.length - 1
      break
    case 'up':
      nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1
      break
    case 'down':
      nextIndex = currentIndex < 0 ? 0 : Math.min(nodeRows.length - 1, currentIndex + 1)
      break
  }

  return nodeRows[nextIndex]?.node ?? null
}

/** Flatten an expanded file tree into virtualized sidebar rows. */
export function flattenVisibleNodes(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  pendingCreate: PendingCreate | null,
  pendingRename: PendingRename | null = null,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = []
  const visit = (node: FileNode, depth: number) => {
    if (pendingRename && pathsEqual(node.path, pendingRename.path)) {
      rows.push({ kind: 'rename', node, depth })
    } else {
      rows.push({ kind: 'node', node, depth })
    }
    if (!node.is_dir || !pathSetHas(expandedPaths, node.path)) return
    if (pendingCreate?.parentPath === node.path) {
      rows.push({ kind: 'create', depth: depth + 1, directory: pendingCreate.directory })
    }
    if (node.loaded) node.children?.forEach(child => visit(child, depth + 1))
  }
  nodes.forEach(node => visit(node, 1))
  return rows
}
