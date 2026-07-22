import { safeInvoke } from './tauri'
import type { Project } from '../types'
import { collectAncestorDirs, findProjectForPath } from '../utils/fileReferences'
import {
  findNodeByPath,
  patchTree,
  removeNodeFromTree,
  type FileNode,
} from '../utils/fileTreeHelpers'
import { loadExcludeSettingsForProject } from './excludeSettings'

export type { FileNode }
export { findNodeByPath, patchTree, removeNodeFromTree }

/** Mark directory nodes as not yet expanded. */
export function withLoadedFlags(nodes: FileNode[]): FileNode[] {
  return nodes.map(n => ({ ...n, loaded: n.is_dir ? false : true }))
}

export async function scanDirectory(
  path: string,
  options?: {
    action?: string
    workspaceRoot?: string
    excludePatterns?: string[]
    excludeGitIgnore?: boolean
  },
): Promise<FileNode[]> {
  const tree = await safeInvoke<FileNode[]>(options?.action ?? '读取目录', 'scan_directory', {
    path,
    workspaceRoot: options?.workspaceRoot ?? path,
    excludePatterns: options?.excludePatterns ?? null,
    excludeGitIgnore: options?.excludeGitIgnore ?? false,
  })
  return withLoadedFlags(tree)
}

export async function loadProjectRootTree(project: Project | string): Promise<FileNode[]> {
  const projectPath = typeof project === 'string' ? project : project.path
  const projectObj = typeof project === 'string' ? null : project
  const excludes = await loadExcludeSettingsForProject(projectObj)
  return scanDirectory(projectPath, {
    action: '读取目录',
    workspaceRoot: projectPath,
    excludePatterns: excludes.filesExclude,
    excludeGitIgnore: excludes.excludeGitIgnore,
  })
}

export async function loadDirChildren(
  path: string,
  workspaceRoot: string,
  project?: Project | null,
): Promise<FileNode[]> {
  const excludes = await loadExcludeSettingsForProject(project ?? null)
  return scanDirectory(path, {
    action: '展开目录',
    workspaceRoot,
    excludePatterns: excludes.filesExclude,
    excludeGitIgnore: excludes.excludeGitIgnore,
  })
}

export function patchDirChildren(
  tree: FileNode[],
  path: string,
  children: FileNode[],
): FileNode[] {
  return patchTree(tree, path, () => children)
}

/**
 * A root scan only contains one level. Keep lazy-loaded descendants when its
 * response lands after a directory expansion, otherwise it can replace an
 * expanded folder with an unloaded copy and leave its visible row empty.
 *
 * Prefer {@link reloadLoadedChildren} for intentional refresh / watcher reloads
 * so expanded folders re-read disk instead of keeping stale children.
 */
export function preserveLoadedChildren(fresh: FileNode[], existing: FileNode[]): FileNode[] {
  return fresh.map(node => {
    const previous = findNodeByPath(existing, node.path)
    if (!node.is_dir || !previous?.is_dir || !previous.loaded) return node
    return {
      ...node,
      children: previous.children,
      loaded: true,
    }
  })
}

/**
 * Re-scan every previously loaded directory under `fresh` so refresh and file
 * watchers pick up adds/deletes/renames inside already-expanded folders.
 */
export async function reloadLoadedChildren(
  fresh: FileNode[],
  existing: FileNode[],
  workspaceRoot: string,
  project?: Project | null,
): Promise<FileNode[]> {
  const result: FileNode[] = []
  for (const node of fresh) {
    if (!node.is_dir) {
      result.push(node)
      continue
    }
    const previous = findNodeByPath(existing, node.path)
    if (!previous?.is_dir || !previous.loaded) {
      result.push(node)
      continue
    }
    try {
      const children = await loadDirChildren(node.path, workspaceRoot, project)
      const nested = await reloadLoadedChildren(
        children,
        previous.children ?? [],
        workspaceRoot,
        project,
      )
      result.push({ ...node, children: nested, loaded: true })
    } catch {
      // Directory became unavailable — keep the unloaded placeholder from the scan.
      result.push(node)
    }
  }
  return result
}

/** Ancestor directories that must be expanded to reveal `filePath` under `project`. */
export function dirsToReveal(filePath: string, project: Project): string[] {
  return collectAncestorDirs(filePath, project.path)
}

/** Directories under `tree` that still need lazy loading before `filePath` is visible. */
export function dirsNeedingLoad(tree: FileNode[], dirs: string[]): string[] {
  return dirs.filter(dir => !findNodeByPath(tree, dir)?.loaded)
}

/** True when ancestor folders must be loaded before `filePath` can appear in the tree. */
export function revealNeedsTreeLoad(
  tree: FileNode[],
  filePath: string,
  project: Project,
): boolean {
  const dirs = dirsToReveal(filePath, project)
  if (dirsNeedingLoad(tree, dirs).length > 0) return true
  const target = findNodeByPath(tree, filePath)
  return !!(target?.is_dir && !target.loaded)
}

export function findOwningProject(
  projects: Project[],
  filePath: string,
): Project | undefined {
  return findProjectForPath(projects, filePath)
}
