type GitSyncKind = 'fetch' | 'pull' | 'push'

type GitSyncTimes = Partial<Record<`${GitSyncKind}At`, number>> & {
  fetchAuthFailed?: boolean
  /** 最近一次自动检查更新的发起时间（成败均记录），只用于节流，不作为“检查更新”时间展示。 */
  autoFetchAttemptAt?: number
}

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

export function readAutoFetchAttemptAt(projectPath: string): number | null {
  const at = readLocalGitSyncTimes(projectPath).autoFetchAttemptAt
  return typeof at === 'number' && at > 0 ? at : null
}

export function markAutoFetchAttempt(projectPath: string, at = Date.now()): void {
  try {
    const current = readLocalGitSyncTimes(projectPath)
    sessionStorage.setItem(
      storageKey(projectPath),
      JSON.stringify({ ...current, autoFetchAttemptAt: at }),
    )
  } catch {
    // sessionStorage may be unavailable in tests or restricted contexts.
  }
}

export function readFetchAuthFailed(projectPath: string): boolean {
  return Boolean(readLocalGitSyncTimes(projectPath).fetchAuthFailed)
}

export function markFetchAuthFailed(projectPath: string): void {
  try {
    const current = readLocalGitSyncTimes(projectPath)
    sessionStorage.setItem(
      storageKey(projectPath),
      JSON.stringify({ ...current, fetchAuthFailed: true }),
    )
  } catch {
    // sessionStorage may be unavailable in tests or restricted contexts.
  }
}

export function clearFetchAuthFailed(projectPath: string): void {
  try {
    const current = readLocalGitSyncTimes(projectPath)
    sessionStorage.setItem(
      storageKey(projectPath),
      JSON.stringify({ ...current, fetchAuthFailed: false }),
    )
  } catch {
    // sessionStorage may be unavailable in tests or restricted contexts.
  }
}
