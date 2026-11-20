import type { Project } from '../../types'
import { sshConnectionIdFromUri } from '../sshWorkspace'
import { createProjectTrustChecker } from '../workspaceTrust'
import { isPrewarmCli } from './localCodexPrewarm'
import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, type TerminalProfile } from './terminalProfiles'

export const CONNECTION_PREWARM_PREFIX = 'qingcode:connection-cli-prewarm:'

/** Explicit local opt-in, bound to the exact command and shell approved for this connection. */
export function saveConnectionPrewarmProfile(connectionId: string, profile: TerminalProfile | null) {
  const key = CONNECTION_PREWARM_PREFIX + connectionId
  if (profile) localStorage.setItem(key, JSON.stringify({ id: profile.id, shell: profile.shell, command: profile.command }))
  else localStorage.removeItem(key)
  notifyShellPrewarmChanged()
}

export function connectionPrewarmProfile(connectionId: string) {
  try {
    const raw = localStorage.getItem(CONNECTION_PREWARM_PREFIX + connectionId)
    if (!raw) return
    const saved = JSON.parse(raw)
    return loadTerminalProfileSettings().profiles.find(p => p.id === saved?.id &&
      p.shell === saved.shell && p.command === saved.command && isPrewarmCli(p.command) && isTerminalProfileTrusted(p))
  } catch {
    return undefined
  }
}

type Candidate = Pick<Project, 'id' | 'path' | 'last_opened_at' | 'ephemeral'>

/**
 * 当前项目不在该连接上时，用该连接最近打开的受信任项目授权打开连接。
 * 与本机一致，CLI 本身在 QingCode 的专用空目录（远端 `~/.qingcode/cli-prewarm`）启动，
 * 这里的项目只决定能否连接，不是 CLI 的工作目录；当前项目所在连接由 active profile 覆盖。
 */
export function connectionPrewarmAnchors(projects: readonly Candidate[], activeConnection?: string | null) {
  const trusted = createProjectTrustChecker()
  const latest = new Map<string, Candidate>()
  for (const p of projects) {
    const connection = sshConnectionIdFromUri(p.path)
    if (!connection || connection === activeConnection || p.ephemeral || !trusted(p)) continue
    const prev = latest.get(connection)
    if (!prev || p.last_opened_at > prev.last_opened_at) latest.set(connection, p)
  }
  const anchors = []
  for (const [connection, project] of latest) {
    const profile = connectionPrewarmProfile(connection)
    if (profile) anchors.push({ cwd: project.path, profileId: profile.id, shell: profile.shell, command: profile.command.trim() })
  }
  return anchors
}
