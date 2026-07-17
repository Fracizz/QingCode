import { safeInvoke, isTauri } from './tauri'

/** Push registered project roots to the native path sandbox. */
export async function syncProjectRoots(roots: string[]): Promise<void> {
  if (!isTauri()) return
  await safeInvoke('同步项目根目录', 'sync_project_roots', { roots })
}

/**
 * Grant native file commands access to paths outside registered project roots
 * (Save As destination, Explorer "Open with", temp empty-project dirs, etc.).
 */
export async function authorizePaths(paths: string[]): Promise<void> {
  if (!isTauri() || paths.length === 0) return
  await safeInvoke('授权路径', 'authorize_paths', { paths })
}

export async function syncRootsFromProjects(
  projects: Array<{ path: string }>,
): Promise<void> {
  await syncProjectRoots(projects.map(p => p.path))
}

/** Push workspace-trusted project roots (write / terminal / run) to the native sandbox. */
export async function syncTrustedRoots(roots: string[]): Promise<void> {
  if (!isTauri()) return
  await safeInvoke('同步受信任项目根目录', 'sync_trusted_roots', { roots })
}
