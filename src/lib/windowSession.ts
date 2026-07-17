/**
 * Per-window workspace session.
 *
 * WebView windows share localStorage (same origin) but each has its own
 * sessionStorage and JS heap. File → New Window opens with `?fresh=1`; we
 * record that in sessionStorage so this window skips auto-restoring the last
 * project / workspace while the first window keeps restoring as usual.
 */

const FRESH_QUERY = 'fresh'
const FRESH_SESSION_KEY = 'qingcode:window-fresh'

let initialized = false
let freshWindow = false

/** Call once at boot (before stores hydrate workspace UI). */
export function initWindowSession() {
  if (initialized) return
  initialized = true

  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get(FRESH_QUERY) === '1') {
      sessionStorage.setItem(FRESH_SESSION_KEY, '1')
      url.searchParams.delete(FRESH_QUERY)
      const next = `${url.pathname}${url.search}${url.hash}`
      window.history.replaceState(null, '', next)
    }
    freshWindow = sessionStorage.getItem(FRESH_SESSION_KEY) === '1'
  } catch {
    freshWindow = false
  }
}

/** False for File → New Window (and reloads of that window). */
export function shouldRestoreWorkspace(): boolean {
  if (!initialized) initWindowSession()
  return !freshWindow
}
