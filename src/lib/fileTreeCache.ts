import { safeInvoke } from './tauri'
import type { Project } from '../types'
import { collectAncestorDirs, findProjectForPath } from '../utils/fileReferences'
import {
  patchTree,
  type FileNode,
} from '../utils/fileTreeHelpers'
import { loadExcludeSettingsForProject } from './excludeSettings'

export type { FileNode }
export { patchTree }

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
