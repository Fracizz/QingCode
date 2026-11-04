import { isTauri } from '@tauri-apps/api/core'

/** Compile-time gate: a URL can never enable test IPC in a production build. */
export function isWebTest(): boolean {
  return import.meta.env.DEV && import.meta.env.MODE === 'web-test' && !isTauri()
}
