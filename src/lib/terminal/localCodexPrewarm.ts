import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, profilesForConnection, type TerminalProfile } from './terminalProfiles'

export const LOCAL_CODEX_PREWARM_KEY = 'qingcode:local-codex-prewarm'

export function isPrewarmCli(command: string) {
  return ['codex', 'claude', 'opencode', 'pi'].includes(command.trim())
}

export function supportsCodexPrewarm(profile: TerminalProfile) {
  return isPrewarmCli(profile.command) && ['auto', 'pwsh', 'powershell'].includes(profile.shell)
}

/** 同时保持就绪的 CLI 数量上限（与后端 MAX_PROFILE_COUNT 一致），本机与各远程连接共用；每个都是完整的 CLI 进程。 */
export const CLI_PREWARM_MAX_COUNT = 4

function readSaved(): { profileId?: unknown; shell?: unknown; command?: unknown; count?: unknown } | null {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CODEX_PREWARM_KEY) ?? 'null')
  } catch {
    return null
  }
}

function parseCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CLI_PREWARM_MAX_COUNT ? value : 1
}

export function saveLocalCodexPrewarm(profile?: TerminalProfile) {
  // 换 CLI 时沿用已设置的数量。
  localStorage.setItem(LOCAL_CODEX_PREWARM_KEY, JSON.stringify({
    profileId: profile?.id, shell: profile?.shell, command: profile?.command, count: localCodexPrewarmCount(),
  }))
  notifyShellPrewarmChanged()
}

/** 本机同时保持就绪的 CLI 数量（1–4，默认 1）；连续新建多个同配置终端时每个都能领到预热的 CLI。 */
export function localCodexPrewarmCount() {
  return parseCount(readSaved()?.count)
}

export function saveLocalCodexPrewarmCount(count: number) {
  const saved = readSaved()
  if (!saved?.profileId) return
  localStorage.setItem(LOCAL_CODEX_PREWARM_KEY, JSON.stringify({ ...saved, count: parseCount(count) }))
  notifyShellPrewarmChanged()
}

export function localCodexPrewarm() {
  try {
    const saved = readSaved()
    if (!saved?.profileId) return
    const profile = profilesForConnection(loadTerminalProfileSettings(), null).find(p =>
      p.id === saved.profileId && p.shell === saved.shell && p.command === saved.command &&
      supportsCodexPrewarm(p) && isTerminalProfileTrusted(p))
    return profile
  } catch {
    return undefined
  }
}
