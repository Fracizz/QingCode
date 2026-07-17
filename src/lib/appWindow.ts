import { isTauri } from './tauri'

let revealed = false

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const MIN_SANE_WIDTH = 200
const MIN_SANE_HEIGHT = 200

/** Fallback when the native window is still tiny / hidden after boot. */
export function revealAppWindow() {
  if (!isTauri() || revealed) return
  revealed = true
  void import('@tauri-apps/api/window').then(async ({ getCurrentWindow, LogicalSize }) => {
    const win = getCurrentWindow()
    try {
      const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()])
      const logicalW = size.width / scale
      const logicalH = size.height / scale
      // Recover from the ~14x14 borderless boot glitch on Windows.
      if (logicalW < MIN_SANE_WIDTH || logicalH < MIN_SANE_HEIGHT) {
        try {
          await win.setDecorations(true)
        } catch {
          // optional permission
        }
        await win.setSize(new LogicalSize(DEFAULT_WIDTH, DEFAULT_HEIGHT))
        try {
          await win.setDecorations(false)
        } catch {
          // keep default chrome if toggle fails
        }
        await win.center()
      }
    } catch {
      // Permissions / API failures should not block show().
    }
    const show = () => void win.show()
    requestAnimationFrame(() => requestAnimationFrame(show))
  })
}
