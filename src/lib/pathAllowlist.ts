import { hasBackend } from './runtimeCapabilities'
import { safeInvoke } from './tauri'

/** Push registered project roots to the native path sandbox. */
export async function syncProjectRoots(roots: string[]): Promise<void> {
  if (!hasBackend()) return
  await safeInvoke('同步项目根目录', 'sync_project_roots', { roots })
}

/**
 * Grant native file commands access to paths outside registered project roots
 * (Save As destination, Explorer "Open with", temp empty-project dirs, etc.).
 */
export async function authorizePaths(paths: string[]): Promise<void> {
  if (!hasBackend() || paths.length === 0) return
  await safeInvoke('授权路径', 'authorize_paths', { paths })
}

/**
 * 授权项目外的单个已存在普通文件（终端里 Ctrl+点击路径）。目录和不存在的路径不授权，
 * 返回是否授权成功；没有后端时返回 false。
 */
export async function authorizeExistingFile(path: string): Promise<boolean> {
  if (!hasBackend()) return false
  return safeInvoke<boolean>('授权文件', 'authorize_existing_file', { path })
}

export async function syncRootsFromProjects(
  projects: Array<{ path: string }>,
): Promise<void> {
  await syncProjectRoots(projects.map(p => p.path))
}

/** Push workspace-trusted project roots (write / terminal / run) to the native sandbox. */
export async function syncTrustedRoots(roots: string[]): Promise<void> {
  if (!hasBackend()) return
  await safeInvoke('同步受信任项目根目录', 'sync_trusted_roots', { roots })
}
