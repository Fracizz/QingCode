import { loadGlobalSettings, saveGlobalSettings } from '../projectSettings'
import { isTauri, safeInvoke } from '../tauri'
import { detectTerminalHostPlatform } from './terminalShell'

export const SHELL_PREWARM_COUNT_KEY = 'terminal.integrated.shellPrewarmCount'
export const SHELL_PREWARM_CHANGED_EVENT = 'qingcode:shell-prewarm-changed'
export type ShellPrewarmCount = 'auto' | number

export function parseShellPrewarmCount(value: unknown): ShellPrewarmCount {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 8
    ? value : 'auto'
}
export async function loadShellPrewarmCount(): Promise<ShellPrewarmCount> {
  return parseShellPrewarmCount((await loadGlobalSettings())[SHELL_PREWARM_COUNT_KEY])
}
export async function saveShellPrewarmCount(value: ShellPrewarmCount): Promise<void> {
  const settings = await loadGlobalSettings()
  settings[SHELL_PREWARM_COUNT_KEY] = parseShellPrewarmCount(value)
  await saveGlobalSettings(settings)
  notifyShellPrewarmChanged()
}
export function notifyShellPrewarmChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHELL_PREWARM_CHANGED_EVENT))
}

/** 用预先分配的身份创建标签；未命中/功能不可用时立即走正常新建。 */
export type ShellReservation = { id: string } | { reason: string }

export async function reservePrewarmedShell(cwd: string, shell: string, hasStartup = false): Promise<ShellReservation> {
  if (!isTauri() || (!cwd.startsWith('ssh://') && detectTerminalHostPlatform() !== 'win')) {
    return { reason: 'unsupported_host' }
  }
  return safeInvoke<ShellReservation>('领取预热 Shell', 'reserve_prewarmed_shell', { cwd, shell, hasStartup })
    .catch(() => ({ reason: 'reserve_unavailable' }))
}
