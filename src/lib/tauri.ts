import { invoke as rawInvoke, isTauri as coreIsTauri } from '@tauri-apps/api/core'
import { recordTauriCommandDuration } from './performanceDiagnostics'

/** Whether the app is running inside the Tauri desktop runtime. */
export function isTauri(): boolean {
  return coreIsTauri()
}

export class NotInTauriError extends Error {
  constructor(action: string) {
    super(
      `「${action}」需要 Tauri 桌面环境，当前在浏览器中预览不可用。请使用 \`pnpm tauri dev\` 启动后再试。`
    )
    this.name = 'NotInTauriError'
  }
}

/**
 * invoke() wrapper that fails with a friendly, actionable error when the
 * app is not running inside Tauri, instead of crashing on undefined access.
 */
export async function safeInvoke<T = unknown>(
  action: string,
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isTauri()) throw new NotInTauriError(action)
  const started = performance.now()
  let succeeded = false
  try {
    const result = await rawInvoke<T>(cmd, args)
    succeeded = true
    return result
  } finally {
    recordTauriCommandDuration(cmd, performance.now() - started, succeeded)
  }
}

/** Throws a friendly error if called outside the Tauri runtime. */
export async function requireTauri(action: string): Promise<void> {
  if (!isTauri()) throw new NotInTauriError(action)
}

/** Native fallback for WebView2 mouse events that omit the physical Ctrl state. */
export async function isPrimaryModifierPressed(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await rawInvoke<boolean>('primary_modifier_pressed')
  } catch {
    return false
  }
}
