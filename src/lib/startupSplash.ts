const SPLASH_ID = 'startup-splash'
const MIN_VISIBLE_MS = 520

let dismissScheduled = false
const shownAt = typeof performance !== 'undefined' ? performance.now() : 0

/** Fade out the static startup splash once the app shell has painted. */
export function dismissStartupSplash() {
  if (dismissScheduled) return
  dismissScheduled = true

  const remove = () => {
    const el = document.getElementById(SPLASH_ID)
    if (!el) return
    el.classList.add('startup-splash--hide')
    const cleanup = () => el.remove()
    el.addEventListener('transitionend', cleanup, { once: true })
    window.setTimeout(cleanup, 320)
  }

  const elapsed = (typeof performance !== 'undefined' ? performance.now() : 0) - shownAt
  const wait = Math.max(0, MIN_VISIBLE_MS - elapsed)
  window.setTimeout(() => {
    requestAnimationFrame(() => requestAnimationFrame(remove))
  }, wait)
}
