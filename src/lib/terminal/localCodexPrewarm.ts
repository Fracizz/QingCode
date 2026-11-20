import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, type TerminalProfile } from './terminalProfiles'

export const LOCAL_CODEX_PREWARM_KEY = 'qingcode:local-codex-prewarm'

export function isPrewarmCli(command: string) {
  return ['codex', 'claude', 'opencode'].includes(command.trim())
}

export function supportsCodexPrewarm(profile: TerminalProfile) {
  return isPrewarmCli(profile.command) && ['auto', 'pwsh', 'powershell'].includes(profile.shell)
}

export function saveLocalCodexPrewarm(profile?: TerminalProfile) {
  localStorage.setItem(LOCAL_CODEX_PREWARM_KEY, JSON.stringify({
    profileId: profile?.id, shell: profile?.shell, command: profile?.command,
  }))
  notifyShellPrewarmChanged()
}

export function localCodexPrewarm() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_CODEX_PREWARM_KEY) ?? 'null')
    if (!saved?.profileId) return
    const profile = loadTerminalProfileSettings().profiles.find(p =>
      p.id === saved.profileId && p.shell === saved.shell && p.command === saved.command &&
      supportsCodexPrewarm(p) && isTerminalProfileTrusted(p))
    return profile
  } catch {
    return undefined
  }
}
