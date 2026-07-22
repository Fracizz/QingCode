import type { GitChange, GitStatus } from './git'
import { normalizePath, projectRelativePath } from '../utils/fileReferences'

export type GitStatusEntry = {
  path: string
  status: string
}

export type GitWorkdirStatus = {
  entries: GitStatusEntry[]
  dirty_count: number
}

export type GitChangeGroup = 'staged' | 'unstaged'

export type GitChangeGroups = {
  staged: GitChange[]
  unstaged: GitChange[]
}

/** Absolute dirty entries → SCM panel relative changes. */
export function changesFromWorkdirEntries(
  projectPath: string,
  entries: GitStatusEntry[],
): GitChange[] {
  return entries.map(entry => ({
    path: projectRelativePath(projectPath, entry.path),
    status: entry.status,
  }))
}

/** Build a SCM snapshot from the lightweight workdir store (instant panel open). */
export function gitStatusFromWorkdirEntries(
  projectPath: string,
  entries: GitStatusEntry[],
  branch: string | null = null,
): GitStatus {
  return {
    is_repository: true,
    branch,
    changes: changesFromWorkdirEntries(projectPath, entries),
  }
}

/** Absolute path for a porcelain relative change (stable `/` keys). */
export function absoluteGitPath(projectPath: string, relativePath: string): string {
  const root = normalizePath(projectPath)
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return rel ? `${root}/${rel}` : root
}

/** Strip trailing separators (legacy untracked-dir lines may use `name/`). */
export function normalizeGitChangePath(path: string): string {
  return path.replace(/[/\\]+$/, '')
}

/** True when porcelain path itself marks a directory (`foo/` / `foo\`). Rare with `-uall`. */
export function gitChangePathLooksLikeDirectory(path: string): boolean {
  return /[/\\]$/.test(path)
}

/**
 * Untracked / ignored entries may still be directories (empty dir, or without trailing slash).
 * SCM uses `--untracked-files=all`, so file paths are usual; keep this for defensive UI.
 * Tracked status codes refer to files (Git does not track empty dirs).
 */
export function gitStatusMayBeDirectory(status: string): boolean {
  return status === '??' || status === '!!'
}

/** Index column from a full porcelain `XY` status. */
export function gitIndexStatus(status: string): string | null {
  if (status === '??' || status === '!!' || status.length < 2) return null
  const code = status[0]
  return code && code !== ' ' ? code : null
}

/** Worktree column from a full porcelain `XY` status. */
export function gitWorktreeStatus(status: string): string | null {
  if (status === '??') return '?'
  if (status === '!!') return '!'
  // Treat legacy one-character cache entries as unstaged. This avoids silently
  // committing a stale status snapshot while the new full XY contract settles.
  if (status.length === 1) return status
  const code = status[1]
  return code && code !== ' ' ? code : null
}

export function gitChangeHasStaged(change: GitChange): boolean {
  return gitIndexStatus(change.status) !== null
}

export function gitChangeHasUnstaged(change: GitChange): boolean {
  return change.status !== '!!' && gitWorktreeStatus(change.status) !== null
}

/** True for unmerged paths from merge/rebase/cherry-pick (`UU`, `AA`, `DU`, …). */
export function gitChangeIsUnmerged(status: string): boolean {
  if (status.length < 2) return false
  const index = status[0]
  const worktree = status[1]
  return index === 'U'
    || worktree === 'U'
    || (index === 'A' && worktree === 'A')
    || (index === 'D' && worktree === 'D')
}

export function collectUnmergedChanges(changes: GitChange[]): GitChange[] {
  return changes.filter(change => gitChangeIsUnmerged(change.status))
}

/** A dual-state file (e.g. MM / AM) intentionally appears in both arrays. */
export function splitGitChanges(changes: GitChange[]): GitChangeGroups {
  return {
    staged: changes.filter(gitChangeHasStaged),
    unstaged: changes.filter(gitChangeHasUnstaged),
  }
}

/** Group-specific letter shown in Source Control rows. */
export function gitStatusGlyphForGroup(status: string, group: GitChangeGroup): string | null {
  const code = group === 'staged' ? gitIndexStatus(status) : gitWorktreeStatus(status)
  if (code === '?') return 'U'
  if (code === '!') return 'I'
  return code
}

export function canCommitStagedChanges(
  message: string,
  stagedCount: number,
  busy: boolean,
): boolean {
  return !busy && stagedCount > 0 && message.trim().length > 0
}

/** Absolute local time for SCM commit rows / detail: `YYYY-MM-DD HH:mm:ss`. */
export function formatAbsoluteCommitTime(isoDate: string): string {
  const parsed = Date.parse(isoDate)
  if (Number.isNaN(parsed)) return isoDate
  const date = new Date(parsed)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
}

/** Predict porcelain after staging one change (optimistic SCM refresh). */
export function predictAfterStageChange(change: GitChange): GitChange {
  if (!gitChangeHasUnstaged(change)) return change
  const wt = gitWorktreeStatus(change.status)
  if (wt === '?') return { ...change, status: 'A ' }
  if (wt === '!' || !wt) return change
  return { ...change, status: `${wt} ` }
}

/** Predict porcelain after unstaging one change (optimistic SCM refresh). */
export function predictAfterUnstageChange(change: GitChange): GitChange {
  if (!gitChangeHasStaged(change)) return change
  const idx = gitIndexStatus(change.status)
  if (!idx) return change
  if (gitChangeHasUnstaged(change)) {
    const wt = gitWorktreeStatus(change.status)
    return { ...change, status: wt ? ` ${wt}` : change.status }
  }
  if (idx === 'A') return { ...change, status: '??' }
  return { ...change, status: ` ${idx}` }
}

function keepVisibleGitChange(change: GitChange): boolean {
  return gitChangeHasStaged(change) || gitChangeHasUnstaged(change)
}

/** Optimistic snapshot after bulk stage/unstage-all in one SCM group. */
export function predictBulkGitStatusAfterAction(
  status: GitStatus,
  group: GitChangeGroup,
): GitStatus {
  const changes = status.changes
    .map(change =>
      group === 'unstaged' ? predictAfterStageChange(change) : predictAfterUnstageChange(change),
    )
    .filter(keepVisibleGitChange)
  return { ...status, changes }
}

/** Normalize path keys for case-insensitive lookup (Windows). */
export function gitStatusKey(path: string): string {
  return normalizePath(path).toLowerCase()
}

/** Stable row id for SCM selection (`staged:src/foo.ts`). */
export function scmRowKey(group: GitChangeGroup, path: string): string {
  return `${group}:${normalizeGitChangePath(path)}`
}

/** Middle-ellipsis path for SCM rows (reference-style long paths). */
export function formatScmDisplayPath(path: string, maxLength = 52): string {
  const normalized = normalizeGitChangePath(path).replace(/\\/g, '/')
  if (normalized.length <= maxLength) return normalized
  const prefixLen = Math.max(8, Math.floor(maxLength * 0.28))
  const suffixLen = Math.max(12, maxLength - prefixLen - 3)
  return `${normalized.slice(0, prefixLen)}...${normalized.slice(-suffixLen)}`
}

/** SCM badge tone from group-specific status glyph. */
export function scmStatusBadgeTone(
  status: string,
  group: GitChangeGroup,
): 'added' | 'deleted' | 'modified' | 'conflict' | 'other' {
  if (gitChangeIsUnmerged(status)) return 'conflict'
  const glyph = gitStatusGlyphForGroup(status, group) ?? status.trim()
  if (glyph === 'U' || glyph === 'A' || glyph === '?') return 'added'
  if (glyph === 'D') return 'deleted'
  if (glyph === 'M' || glyph === 'T' || glyph.includes('M')) return 'modified'
  return 'other'
}

/** Build absolute-path → status map from a workdir snapshot. */
export function buildStatusMap(entries: GitStatusEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of entries) {
    map.set(gitStatusKey(entry.path), entry.status)
  }
  return map
}

/** Letter shown in the tree / tabs (U for untracked). */
export function gitStatusGlyph(status: string | null | undefined): string | null {
  if (!status) return null
  if (status === '??') return 'U'
  if (status === '!!') return 'I'
  if (status.length === 1) return status
  // Prefer worktree / second char when both index+worktree dirty (e.g. AM → M-ish).
  const last = status[status.length - 1]
  if (last && last !== ' ') return last
  return status[0] ?? null
}

/** Tailwind text color class for a git status code. */
export function gitStatusColorClass(status: string | null | undefined): string {
  if (!status) return ''
  const code = status.includes('D') ? 'D' : gitStatusGlyph(status)
  switch (code) {
    case 'U':
    case 'A':
    case '?':
      return 'text-ok'
    case 'D':
      return 'text-danger'
    case 'R':
    case 'C':
      return 'text-accent'
    case 'M':
    case 'T':
    default:
      return 'text-warn'
  }
}

/** True when any dirty path is under `dirPath` (or is the dir itself). */
export function dirHasGitChanges(statusMap: Map<string, string>, dirPath: string): boolean {
  const prefix = `${gitStatusKey(dirPath)}/`
  const exact = gitStatusKey(dirPath)
  for (const key of statusMap.keys()) {
    if (key === exact || key.startsWith(prefix)) return true
  }
  return false
}

/** Aggregate a directory mark when children are dirty. */
export function dirGitStatus(statusMap: Map<string, string>, dirPath: string): string | null {
  if (!dirHasGitChanges(statusMap, dirPath)) return null
  const prefix = `${gitStatusKey(dirPath)}/`
  const exact = gitStatusKey(dirPath)
  const own = statusMap.get(exact)
  if (own) return own
  // Prefer modified over untracked when mixed.
  let sawUntracked = false
  for (const [key, status] of statusMap) {
    if (key === exact || !key.startsWith(prefix)) continue
    if (status === '??') {
      sawUntracked = true
      continue
    }
    return 'M'
  }
  return sawUntracked ? '??' : 'M'
}
