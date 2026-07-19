import { isPathExcluded, loadExcludeSettingsForProject } from './excludeSettings'
import type { Project } from '../types'
import { normalizePath } from '../utils/fileReferences'

/**
 * Build-output / VCS churn that must not drive explorer expands.
 * Cargo creates ephemeral dirs under target/.../deps that vanish within ms;
 * expanding them after the watcher debounce yields directory-unavailable toasts.
 */
const VOLATILE_SEGMENT_RE =
  /(?:^|\/)(?:target|node_modules|\.git|dist|build|out|coverage|\.turbo|\.next|\.cache)(?:\/|$)/i

/** True when a changed path should not trigger an explorer tree reload. */
export function isVolatileWatcherTreePath(path: string): boolean {
  const norm = normalizePath(path)
  return VOLATILE_SEGMENT_RE.test(norm)
}

/**
 * Skip watcher-driven tree refresh for excluded / volatile paths.
 * Uses project files.exclude when available; always skips well-known build dirs.
 */
export async function shouldSkipWatcherTreeRefresh(
  path: string,
  project: Project,
): Promise<boolean> {
  if (isVolatileWatcherTreePath(path)) return true
  try {
    const excludes = await loadExcludeSettingsForProject(project)
    const root = normalizePath(project.path)
    const full = normalizePath(path)
    if (!full.startsWith(root + '/') && full !== root) return false
    const rel = full === root ? '' : full.slice(root.length + 1)
    if (!rel) return false
    return isPathExcluded(rel, excludes.filesExclude)
  } catch {
    return false
  }
}
