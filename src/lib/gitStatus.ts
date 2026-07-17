import { normalizePath } from '../utils/fileReferences'

export type GitStatusEntry = {
  path: string
  status: string
}

export type GitWorkdirStatus = {
  entries: GitStatusEntry[]
  dirty_count: number
}

/** Normalize path keys for case-insensitive lookup (Windows). */
export function gitStatusKey(path: string): string {
  return normalizePath(path).toLowerCase()
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
  const code = status === '??' ? 'U' : status.includes('D') ? 'D' : status[status.length - 1] || status[0]
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
