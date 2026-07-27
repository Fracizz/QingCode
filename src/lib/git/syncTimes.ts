type GitSyncKind = 'fetch' | 'pull' | 'push'

type GitSyncTimes = Partial<Record<`${GitSyncKind}At`, number>>

const KEY_PREFIX = 'qingcode:git-sync:'

function storageKey(projectPath: string): string {
  return `${KEY_PREFIX}${projectPath}`
}

export function readLocalGitSyncTimes(projectPath: string): GitSyncTimes {
  try {
    const raw = sessionStorage.getItem(storageKey(projectPath))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as GitSyncTimes
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function markLocalGitSyncTime(projectPath: string, kind: GitSyncKind, at = Date.now()): void {
  try {
    const current = readLocalGitSyncTimes(projectPath)
    sessionStorage.setItem(
      storageKey(projectPath),
      JSON.stringify({ ...current, [`${kind}At`]: at }),
    )
  } catch {
    // sessionStorage may be unavailable in tests or restricted contexts.
  }
}

export function resolveGitSyncTimestamp(
  projectPath: string | null | undefined,
  kind: GitSyncKind,
  backendAt?: number | null,
): number | null {
  const localAt = projectPath ? readLocalGitSyncTimes(projectPath)[`${kind}At`] : undefined
  const best = Math.max(backendAt ?? 0, localAt ?? 0)
  return best > 0 ? best : null
}
