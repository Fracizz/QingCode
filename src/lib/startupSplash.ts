const SPLASH_ID = 'startup-splash'
const MIN_VISIBLE_MS = 520
const FALLBACK_DISMISS_MS = 8000

let dismissScheduled = false
const shownAt = typeof performance !== 'undefined' ? performance.now() : 0

function removeSplash() {
  const el = document.getElementById(SPLASH_ID)
  if (!el) return
  el.classList.add('startup-splash--hide')
  const cleanup = () => el.remove()
  el.addEventListener('transitionend', cleanup, { once: true })
  window.setTimeout(cleanup, 320)
}

/** Fade out the static startup splash once the app shell has painted. */
export function dismissStartupSplash() {
  const el = document.getElementById(SPLASH_ID)
  if (!el) return
  if (dismissScheduled) return
  dismissScheduled = true

  const elapsed = (typeof performance !== 'undefined' ? performance.now() : 0) - shownAt
  const wait = Math.max(0, MIN_VISIBLE_MS - elapsed)
  window.setTimeout(() => {
    requestAnimationFrame(() => requestAnimationFrame(removeSplash))
  }, wait)
}

/** Ensure splash never blocks the UI if React or Tauri dev CSP fails to boot. */
export function installStartupSplashGuard() {
  dismissStartupSplash()
  window.setTimeout(() => {
    if (document.getElementById(SPLASH_ID)) removeSplash()
  }, FALLBACK_DISMISS_MS)
}
