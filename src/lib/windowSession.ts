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
const EXTERNAL_QUERY = 'external'
const EXTERNAL_SESSION_KEY = 'qingcode:window-external-files'

let initialized = false
let freshWindow = false
let externalFileWindow = false

/** Call once at boot (before stores hydrate workspace UI). */
export function initWindowSession() {
  if (initialized) return
  initialized = true

  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get(FRESH_QUERY) === '1') {
      sessionStorage.setItem(FRESH_SESSION_KEY, '1')
      url.searchParams.delete(FRESH_QUERY)
    }
    if (url.searchParams.get(EXTERNAL_QUERY) === '1') {
      sessionStorage.setItem(EXTERNAL_SESSION_KEY, '1')
      url.searchParams.delete(EXTERNAL_QUERY)
    }
    const next = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState(null, '', next)
    freshWindow = sessionStorage.getItem(FRESH_SESSION_KEY) === '1'
    externalFileWindow = sessionStorage.getItem(EXTERNAL_SESSION_KEY) === '1'
  } catch {
    freshWindow = false
    externalFileWindow = false
  }
}

/** False for fresh or standalone-file windows (including their reloads). */
export function shouldRestoreWorkspace(): boolean {
  if (!initialized) initWindowSession()
  return !freshWindow && !externalFileWindow
}

/** True for Explorer / CLI launched project-less file windows. */
export function isExternalFileWindow(): boolean {
  if (!initialized) initWindowSession()
  return externalFileWindow
}
