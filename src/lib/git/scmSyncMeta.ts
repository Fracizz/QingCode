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
): boolean {
  if (!isRepository) return false
  if (reason === 'manual') return true
  if (lastFetchAuthFailed && reason !== 'push-failed-behind') return false

  const elapsed =
    lastFetchAt == null ? Number.POSITIVE_INFINITY : Date.now() - lastFetchAt

  switch (reason) {
    case 'switch-project':
      return lastFetchAt == null || elapsed >= ENTER_SCM_INTERVAL_MS
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
