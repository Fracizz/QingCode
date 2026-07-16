import { isTauri } from './tauri'

let revealed = false

/** Fallback when the inline HTML script did not show the window. */
export function revealAppWindow() {
  if (!isTauri() || revealed) return
  revealed = true
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const show = () => void getCurrentWindow().show()
    requestAnimationFrame(() => requestAnimationFrame(show))
  })
}
