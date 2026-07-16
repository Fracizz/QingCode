import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './tauri'

let devBuild: boolean | null = null

async function resolveDevBuild(): Promise<boolean> {
  if (devBuild !== null) return devBuild
  if (!isTauri()) {
    devBuild = import.meta.env.DEV
    return devBuild
  }
  try {
    devBuild = await invoke<boolean>('is_dev_build')
  } catch {
    devBuild = false
  }
  return devBuild
}

function isDevtoolsHotkey(event: KeyboardEvent, dev: boolean): boolean {
  const key = event.key.toLowerCase()
  if (key === 'f12') return true
  if (event.ctrlKey && event.shiftKey && key === 'i') return true
  if (dev && event.ctrlKey && event.shiftKey && key === 'c') return true
  return false
}

let installed = false

/** Dev-only: Ctrl+Shift+C toggles WebView devtools. Production builds block all devtools hotkeys. */
export function installDeveloperMode() {
  if (installed || typeof document === 'undefined') return
  installed = true
  void resolveDevBuild()

  document.addEventListener(
    'keydown',
    event => {
      void (async () => {
        const dev = await resolveDevBuild()
        if (!isDevtoolsHotkey(event, dev)) return

        if (!dev) {
          event.preventDefault()
          event.stopPropagation()
          return
        }

        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i') {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        try {
          await invoke('plugin:webview|internal_toggle_devtools')
        } catch {
          // Devtools API unavailable outside debug builds.
        }
      })()
    },
    true,
  )
}
