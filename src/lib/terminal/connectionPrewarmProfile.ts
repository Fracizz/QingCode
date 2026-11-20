import { sshConnectionIdFromUri } from '../sshWorkspace'
import { isPrewarmCli } from './localCodexPrewarm'
import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, type TerminalProfile } from './terminalProfiles'

export const CONNECTION_PREWARM_PREFIX = 'qingcode:connection-cli-prewarm:'

/** Explicit local opt-in, bound to the exact command and shell approved for this connection. */
export function saveConnectionPrewarmProfile(connectionId: string, profile: TerminalProfile | null, anchor?: string) {
  const key = CONNECTION_PREWARM_PREFIX + connectionId
  if (profile) localStorage.setItem(key, JSON.stringify({ id: profile.id, shell: profile.shell, command: profile.command, anchor }))
  else localStorage.removeItem(key)
  notifyShellPrewarmChanged()
}

function trustedSelection(connectionId: string) {
  try {
    const raw = localStorage.getItem(CONNECTION_PREWARM_PREFIX + connectionId)
    if (!raw) return
    const saved = JSON.parse(raw)
    const profile = loadTerminalProfileSettings().profiles.find(p => p.id === saved?.id &&
      p.shell === saved.shell && p.command === saved.command && isPrewarmCli(p.command) && isTerminalProfileTrusted(p))
    if (profile) return { profile, anchor: saved.anchor as unknown }
  } catch {
    return undefined
  }
}

export function connectionPrewarmProfile(connectionId: string) {
  return trustedSelection(connectionId)?.profile
}

export function connectionPrewarmAnchors() {
  const anchors = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(CONNECTION_PREWARM_PREFIX)) continue
    const connection = key.slice(CONNECTION_PREWARM_PREFIX.length)
    const selection = trustedSelection(connection)
    if (!selection || !isPrewarmCli(selection.profile.command)) continue
    const { profile, anchor } = selection
    if (typeof anchor === 'string' && sshConnectionIdFromUri(anchor) === connection) {
      anchors.push({ cwd: anchor, profileId: profile.id, shell: profile.shell, command: profile.command.trim() })
    }
  }
  return anchors
}
