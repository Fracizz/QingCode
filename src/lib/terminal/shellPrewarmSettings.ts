import { loadGlobalSettings, saveGlobalSettings } from '../projectSettings'
import { isTauri, safeInvoke } from '../tauri'
import { detectTerminalHostPlatform } from './terminalShell'

export const SHELL_PREWARM_COUNT_KEY = 'terminal.integrated.shellPrewarmCount'
export const SHELL_PREWARM_CHANGED_EVENT = 'qingcode:shell-prewarm-changed'
export type ShellPrewarmCount = 'auto' | number

/** 本机 Windows 普通 Shell 的预热数量；远程连接各自在「远程连接」中设置。 */
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
export type ShellPrewarmChangeSource = 'settings' | 'project-switch'

export function notifyShellPrewarmChanged(source: ShellPrewarmChangeSource = 'settings') {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHELL_PREWARM_CHANGED_EVENT, { detail: source }))
  }
}

/** 用预先分配的身份创建标签；未命中/功能不可用时立即走正常新建。 */
export type ShellReservation = { id: string; profileHit?: boolean } | { reason: string }

export async function reservePrewarmedShell(
  cwd: string,
  shell: string | null,
  hasStartup = false,
  /** 重启已有标签时传原 id：预留项改按该 id 领取，标签 id 保持不变。 */
  id?: string,
  profile?: { profileId: string; command: string },
): Promise<ShellReservation> {
  if (!isTauri() || (!cwd.startsWith('ssh://') && detectTerminalHostPlatform() !== 'win')) {
    return { reason: 'unsupported_host' }
  }
  return safeInvoke<ShellReservation>('领取预热 Shell', 'reserve_prewarmed_shell', { cwd, shell, hasStartup, id: id ?? null, ...(profile && { profile }) })
    .catch(() => ({ reason: 'reserve_unavailable' }))
}

/** 本机与每条远程连接各自的预热开关（默认开启），关闭后该处的普通 Shell 和 CLI 都不预热。 */
export const LOCAL_PREWARM_DISABLED_KEY = 'qingcode:local-prewarm-disabled'
export const CONNECTION_PREWARM_DISABLED_PREFIX = 'qingcode:connection-prewarm-disabled:'

function setFlag(key: string, disabled: boolean) {
  if (disabled) localStorage.setItem(key, '1')
  else localStorage.removeItem(key)
  notifyShellPrewarmChanged()
}

export function localPrewarmEnabled() {
  return localStorage.getItem(LOCAL_PREWARM_DISABLED_KEY) !== '1'
}
export function setLocalPrewarmEnabled(enabled: boolean) {
  setFlag(LOCAL_PREWARM_DISABLED_KEY, !enabled)
}
export function connectionPrewarmEnabled(connectionId: string) {
  return localStorage.getItem(CONNECTION_PREWARM_DISABLED_PREFIX + connectionId) !== '1'
}
export function setConnectionPrewarmEnabled(connectionId: string, enabled: boolean) {
  setFlag(CONNECTION_PREWARM_DISABLED_PREFIX + connectionId, !enabled)
}
/**
 * 每条远程连接的普通 Shell 预热数量（默认自动 = 1 个），在「远程连接」中按连接设置；
 * 与本机的 `terminal.integrated.shellPrewarmCount` 相互独立。0 只停普通 Shell，CLI 预热不受影响。
 */
export const CONNECTION_SHELL_COUNT_PREFIX = 'qingcode:connection-shell-prewarm-count:'

export function connectionShellPrewarmCount(connectionId: string): ShellPrewarmCount {
  const raw = localStorage.getItem(CONNECTION_SHELL_COUNT_PREFIX + connectionId)
  return raw === null ? 'auto' : parseShellPrewarmCount(Number(raw))
}
export function setConnectionShellPrewarmCount(connectionId: string, value: ShellPrewarmCount) {
  const key = CONNECTION_SHELL_COUNT_PREFIX + connectionId
  const parsed = parseShellPrewarmCount(value)
  if (parsed === 'auto') localStorage.removeItem(key)
  else localStorage.setItem(key, String(parsed))
  notifyShellPrewarmChanged()
}
/** 单独设置过数量的连接（自动的不列出，原生池按 1 个处理）。 */
export function connectionShellPrewarmCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(CONNECTION_SHELL_COUNT_PREFIX)) continue
    const id = key.slice(CONNECTION_SHELL_COUNT_PREFIX.length)
    const count = connectionShellPrewarmCount(id)
    if (count !== 'auto') counts[id] = count
  }
  return counts
}

/** 已关闭预热的连接 id，交给原生池跳过这些连接。 */
export function disabledPrewarmConnections() {
  const ids: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(CONNECTION_PREWARM_DISABLED_PREFIX) && localStorage.getItem(key) === '1') {
      ids.push(key.slice(CONNECTION_PREWARM_DISABLED_PREFIX.length))
    }
  }
  return ids.sort()
}
