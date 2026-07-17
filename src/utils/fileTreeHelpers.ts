/** Shared file-tree node shape used by the project store and sidebar. */
export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
  loaded?: boolean
}

/** Immutable patch: replace children of the node at `targetPath`. */
export function patchTree(
  nodes: FileNode[],
  targetPath: string,
  updater: (existing: FileNode[] | undefined) => FileNode[],
): FileNode[] {
  return nodes.map(n => {
    if (n.path === targetPath) {
      const children = updater(n.children)
      return { ...n, children, loaded: true }
    }
    if (n.children) {
      return { ...n, children: patchTree(n.children, targetPath, updater) }
    }
    return n
  })
}

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function baseName(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}
