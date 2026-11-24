import type { Project } from '../../types'
import { sshConnectionIdFromUri } from '../sshWorkspace'
import { createProjectTrustChecker } from '../workspaceTrust'
import { isPrewarmCli } from './localCodexPrewarm'
import { connectionPrewarmEnabled, notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, profilesForConnection, type TerminalProfile } from './terminalProfiles'

export const CONNECTION_PREWARM_PREFIX = 'qingcode:connection-cli-prewarm:'

/** 每条连接常驻的 CLI 预热数量上限（与后端 MAX_PROFILE_COUNT 一致），每个都是完整的 CLI 进程。 */
export const CONNECTION_PREWARM_MAX_COUNT = 4

function readSaved(connectionId: string): { id?: unknown; shell?: unknown; command?: unknown; count?: unknown } | null {
  try {
    return JSON.parse(localStorage.getItem(CONNECTION_PREWARM_PREFIX + connectionId) ?? 'null')
  } catch {
    return null
  }
}

function parseCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CONNECTION_PREWARM_MAX_COUNT ? value : 1
}

/** Explicit local opt-in, bound to the exact command and shell approved for this connection. */
export function saveConnectionPrewarmProfile(connectionId: string, profile: TerminalProfile | null) {
  const key = CONNECTION_PREWARM_PREFIX + connectionId
  // 换 CLI 时沿用该连接已设置的数量。
  const count = connectionPrewarmCount(connectionId)
  if (profile) localStorage.setItem(key, JSON.stringify({ id: profile.id, shell: profile.shell, command: profile.command, count }))
  else localStorage.removeItem(key)
  notifyShellPrewarmChanged()
}

/** 该连接同时保持就绪的 CLI 数量（1–4，默认 1）；连续新建多个同配置终端时每个都能领到预热的 CLI。 */
export function connectionPrewarmCount(connectionId: string) {
  return parseCount(readSaved(connectionId)?.count)
}

export function saveConnectionPrewarmCount(connectionId: string, count: number) {
  const saved = readSaved(connectionId)
  if (!saved?.id) return
  localStorage.setItem(CONNECTION_PREWARM_PREFIX + connectionId, JSON.stringify({ ...saved, count: parseCount(count) }))
  notifyShellPrewarmChanged()
}

export function connectionPrewarmProfile(connectionId: string) {
  const saved = readSaved(connectionId)
  if (!saved) return
  return profilesForConnection(loadTerminalProfileSettings(), connectionId).find(p => p.id === saved.id &&
    p.shell === saved.shell && p.command === saved.command && isPrewarmCli(p.command) && isTerminalProfileTrusted(p))
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
    if (!connection || connection === activeConnection || p.ephemeral || !trusted(p) || !connectionPrewarmEnabled(connection)) continue
    const prev = latest.get(connection)
    if (!prev || p.last_opened_at > prev.last_opened_at) latest.set(connection, p)
  }
  const anchors = []
  for (const [connection, project] of latest) {
    const profile = connectionPrewarmProfile(connection)
    if (profile) anchors.push({ cwd: project.path, profileId: profile.id, shell: profile.shell,
      command: profile.command.trim(), count: connectionPrewarmCount(connection) })
  }
  return anchors
}
