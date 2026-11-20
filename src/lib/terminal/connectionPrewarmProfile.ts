import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, type TerminalProfile } from './terminalProfiles'

export const CONNECTION_PREWARM_PREFIX = 'qingcode:connection-prewarm-profile:'

/** Explicit local opt-in, bound to the exact command and shell approved for this connection. */
export function saveConnectionPrewarmProfile(connectionId: string, profile: TerminalProfile | null) {
  const key = CONNECTION_PREWARM_PREFIX + connectionId
  if (profile) localStorage.setItem(key, JSON.stringify({ id: profile.id, shell: profile.shell, command: profile.command }))
  else localStorage.removeItem(key)
  notifyShellPrewarmChanged()
}

export function connectionPrewarmProfile(connectionId: string): TerminalProfile | undefined {
  try {
    const raw = localStorage.getItem(CONNECTION_PREWARM_PREFIX + connectionId)
    if (!raw) return
    const saved = JSON.parse(raw)
    return loadTerminalProfileSettings().profiles.find(p => p.id === saved?.id &&
      p.shell === saved.shell && p.command === saved.command && p.command.trim() && isTerminalProfileTrusted(p))
  } catch {
    return undefined
  }
}
