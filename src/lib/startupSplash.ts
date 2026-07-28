const SPLASH_ID = 'startup-splash'

/**
 * Minimum splash visibility before fade-out begins.
 * Entrance animations finish at ~380ms (280ms + 100ms delay); 500ms leaves a short
 * stable brand moment without feeling sticky on slow boots (wait shrinks to 0 once elapsed).
 */
export const STARTUP_SPLASH_MIN_VISIBLE_MS = 500
/** Longest entrance animation in index.html: 280ms duration + 100ms delay. */
export const STARTUP_SPLASH_ENTRANCE_MS = 380
export const STARTUP_SPLASH_FADE_MS = 140

const FALLBACK_DISMISS_MS = 6000

declare global {
  interface Window {
    __QINGCODE_SPLASH_SHOWN_AT__?: number
  }
}

let dismissScheduled = false

function splashShownAt(): number {
  if (typeof window !== 'undefined' && typeof window.__QINGCODE_SPLASH_SHOWN_AT__ === 'number') {
    return window.__QINGCODE_SPLASH_SHOWN_AT__
  }
  return typeof performance !== 'undefined' ? performance.now() : 0
}

export function computeSplashDismissWait(
  elapsedMs: number,
  minVisibleMs = STARTUP_SPLASH_MIN_VISIBLE_MS,
): number {
  return Math.max(0, minVisibleMs - elapsedMs)
}

function removeSplash() {
  const el = document.getElementById(SPLASH_ID)
  if (!el) return
  el.classList.add('startup-splash--hide')
  const cleanup = () => el.remove()
  el.addEventListener('transitionend', cleanup, { once: true })
  window.setTimeout(cleanup, STARTUP_SPLASH_FADE_MS + 80)
}

/** Fade out the static startup splash once the app shell has painted. */
export function dismissStartupSplash() {
  const el = document.getElementById(SPLASH_ID)
  if (!el) return
  if (dismissScheduled) return
  dismissScheduled = true

  const elapsed =
    (typeof performance !== 'undefined' ? performance.now() : 0) - splashShownAt()
  const wait = computeSplashDismissWait(elapsed)
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
