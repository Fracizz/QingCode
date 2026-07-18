/** Shared file-tree node shape used by the project store and sidebar. */
export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
  loaded?: boolean
}

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function pathsMatch(a: string, b: string) {
  return normalizeProjectPath(a) === normalizeProjectPath(b)
}

/** Find a node by path (separator/case insensitive). */
export function findNodeByPath(nodes: FileNode[], targetPath: string): FileNode | null {
  for (const node of nodes) {
    if (pathsMatch(node.path, targetPath)) return node
    if (node.children) {
      const found = findNodeByPath(node.children, targetPath)
      if (found) return found
    }
  }
  return null
}

/** Immutable patch: replace children of the node at `targetPath`. */
export function patchTree(
  nodes: FileNode[],
  targetPath: string,
  updater: (existing: FileNode[] | undefined) => FileNode[],
): FileNode[] {
  return nodes.map(n => {
    if (pathsMatch(n.path, targetPath)) {
      const children = updater(n.children)
      return { ...n, children, loaded: true }
    }
    if (n.children) {
      return { ...n, children: patchTree(n.children, targetPath, updater) }
    }
    return n
  })
}

export function baseName(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}
