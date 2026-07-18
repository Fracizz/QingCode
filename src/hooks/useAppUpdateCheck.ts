import { useEffect } from 'react'
import { isTauri, safeInvoke } from '../lib/tauri'
import { checkForAppUpdate } from '../lib/appUpdate'
import { loadUpdateSettings } from '../lib/updateSettings'

const STARTUP_DELAY_MS = 3_000

/**
 * After startup, optionally check for a newer release (release builds only).
 * Controlled by `qingcode.update.checkOnStartup`.
 */
export function useAppUpdateCheck() {
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const isDev = await safeInvoke<boolean>('检查构建类型', 'is_dev_build').catch(
            () => true,
          )
          if (cancelled || isDev) return
          const { checkOnStartup } = await loadUpdateSettings()
          if (cancelled || !checkOnStartup) return
          await checkForAppUpdate({ prompt: true })
        } catch {
          // Silent on auto-check: network blips should not toast on every launch.
        }
      })()
    }, STARTUP_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])
}
