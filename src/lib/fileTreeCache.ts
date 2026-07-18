import { safeInvoke } from './tauri'
import type { Project } from '../types'
import { collectAncestorDirs, findProjectForPath } from '../utils/fileReferences'
import {
  findNodeByPath,
  patchTree,
  type FileNode,
} from '../utils/fileTreeHelpers'
import { loadExcludeSettingsForProject } from './excludeSettings'

export type { FileNode }
export { findNodeByPath, patchTree }

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
    excludeGitIgnore: options?.excludeGitIgnore ?? true,
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

/** Ancestor directories that must be expanded to reveal `filePath` under `project`. */
export function dirsToReveal(filePath: string, project: Project): string[] {
  return collectAncestorDirs(filePath, project.path)
}

export function findOwningProject(
  projects: Project[],
  filePath: string,
): Project | undefined {
  return findProjectForPath(projects, filePath)
}
