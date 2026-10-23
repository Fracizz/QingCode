import type { GitCommitInfo } from './git'
import { normalizedProjectPath } from '../projectIndicators'

/**
 * SCM 首屏历史的短 TTL 缓存。
 *
 * 面板只在 `view === 'sourceControl'` 时挂载（切回编辑器即卸载），重新打开会再跑
 * 一次 `git_log`。这里按项目缓存首屏历史，避免在编辑器 / 源码管理之间来回切时
 * 反复拉同一份提交列表；TTL 很短，外部提交最多滞后这么久。
 */
export const SCM_COMMITS_CACHE_TTL_MS = 30_000

export type ScmCommitsSnapshot = {
  commits: GitCommitInfo[]
  hasMore: boolean
}

type Entry = ScmCommitsSnapshot & { at: number }

const cache = new Map<string, Entry>()

function cacheKey(projectPath: string): string {
  return normalizedProjectPath(projectPath)
}

export function readScmCommitsCache(
  projectPath: string,
  now = Date.now()
): ScmCommitsSnapshot | null {
  const key = cacheKey(projectPath)
  const entry = cache.get(key)
  if (!entry) return null
  if (now - entry.at > SCM_COMMITS_CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return { commits: entry.commits, hasMore: entry.hasMore }
}

export function writeScmCommitsCache(
  projectPath: string,
  snapshot: ScmCommitsSnapshot,
  now = Date.now()
): void {
  cache.set(cacheKey(projectPath), { ...snapshot, at: now })
}

export function clearScmCommitsCache(projectPath?: string): void {
  if (projectPath === undefined) cache.clear()
  else cache.delete(cacheKey(projectPath))
}
