export type ScmAutoFetchReason =
  | 'enter-scm'
  | 'switch-project'
  | 'window-focus'
  | 'push-failed-behind'
  | 'manual'

const ENTER_SCM_INTERVAL_MS = 2 * 60 * 1000
const WINDOW_FOCUS_INTERVAL_MS = 5 * 60 * 1000

export function isScmFetchAuthError(raw: string): boolean {
  const text = raw.toLowerCase()
  return (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('permission denied') ||
    text.includes('access rights') ||
    text.includes('认证失败') ||
    /\b401\b/.test(text) ||
    /\b403\b/.test(text)
  )
}

export function shouldAutoFetch(
  lastFetchAt: number | null,
  lastFetchAuthFailed: boolean,
  reason: ScmAutoFetchReason,
  isRepository: boolean,
  /** 最近一次自动检查更新的发起时间（无论成败），用于失败后同样节流。 */
  lastAttemptAt: number | null = null,
): boolean {
  if (!isRepository) return false
  if (reason === 'manual') return true
  if (lastFetchAuthFailed && reason !== 'push-failed-behind') return false

  // 成功时间与发起时间取较新者：失败的自动 fetch 也要节流，避免每次进项目都重跑。
  const throttleAt = Math.max(lastFetchAt ?? 0, lastAttemptAt ?? 0)
  const elapsed = throttleAt > 0 ? Date.now() - throttleAt : Number.POSITIVE_INFINITY

  switch (reason) {
    case 'switch-project':
      return elapsed >= ENTER_SCM_INTERVAL_MS
    case 'enter-scm':
      return elapsed >= ENTER_SCM_INTERVAL_MS
    case 'window-focus':
      return elapsed >= WINDOW_FOCUS_INTERVAL_MS
    case 'push-failed-behind':
      return true
    default:
      return false
  }
}
