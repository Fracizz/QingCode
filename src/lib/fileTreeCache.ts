import { safeInvoke } from './tauri'
import type { Project } from '../types'
import { collectAncestorDirs, findProjectForPath } from '../utils/fileReferences'
import {
  patchTree,
  type FileNode,
} from '../utils/fileTreeHelpers'

export type { FileNode }
export { patchTree }

/** Mark directory nodes as not yet expanded. */
export function withLoadedFlags(nodes: FileNode[]): FileNode[] {
  return nodes.map(n => ({ ...n, loaded: n.is_dir ? false : true }))
}

export async function scanDirectory(path: string, action = '读取目录'): Promise<FileNode[]> {
  const tree = await safeInvoke<FileNode[]>(action, 'scan_directory', { path })
  return withLoadedFlags(tree)
}

export async function loadProjectRootTree(projectPath: string): Promise<FileNode[]> {
  return scanDirectory(projectPath, '读取目录')
}

export async function loadDirChildren(path: string): Promise<FileNode[]> {
  return scanDirectory(path, '展开目录')
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
