import type { Project } from '../../types'
import { sshConnectionIdFromUri } from '../sshWorkspace'
import { createProjectTrustChecker } from '../workspaceTrust'
import { cachedCliTrust, cliHasDirectoryTrust, loadCliTrust, prewarmCliAgent } from './cliTrust'
import { isPrewarmCli } from './localCodexPrewarm'
import { notifyShellPrewarmChanged } from './shellPrewarmSettings'
import { isTerminalProfileTrusted } from './terminalProfileTrust'
import { loadTerminalProfileSettings, type TerminalProfile } from './terminalProfiles'

export const CONNECTION_PREWARM_PREFIX = 'qingcode:connection-cli-prewarm:'

export interface ConnectionPrewarmOptions {
  /** 用户固定的启动目录；为空表示自动。 */
  anchor?: string
  /** 用户授权只读读取远端 CLI 自身的信任配置，默认关闭。 */
  readCliConfig?: boolean
}

/** Explicit local opt-in, bound to the exact command and shell approved for this connection. */
export function saveConnectionPrewarmProfile(connectionId: string, profile: TerminalProfile | null, options: ConnectionPrewarmOptions = {}) {
  const key = CONNECTION_PREWARM_PREFIX + connectionId
  if (profile) {
    localStorage.setItem(key, JSON.stringify({
      id: profile.id, shell: profile.shell, command: profile.command,
      ...(options.anchor && { anchor: options.anchor }), ...(options.readCliConfig && { readCliConfig: true }),
    }))
  } else localStorage.removeItem(key)
  notifyShellPrewarmChanged()
}

function readSaved(connectionId: string) {
  try {
    const raw = localStorage.getItem(CONNECTION_PREWARM_PREFIX + connectionId)
    if (!raw) return
    const saved = JSON.parse(raw)
    const profile = loadTerminalProfileSettings().profiles.find(p => p.id === saved?.id &&
      p.shell === saved.shell && p.command === saved.command && isPrewarmCli(p.command) && isTerminalProfileTrusted(p))
    if (profile) return { profile, anchor: typeof saved.anchor === 'string' ? saved.anchor : undefined, readCliConfig: saved.readCliConfig === true }
  } catch {
    return undefined
  }
}

export function connectionPrewarmProfile(connectionId: string) {
  return readSaved(connectionId)?.profile
}

export function connectionPrewarmOptions(connectionId: string): ConnectionPrewarmOptions {
  const saved = readSaved(connectionId)
  return { anchor: saved?.anchor, readCliConfig: saved?.readCliConfig }
}

type Candidate = Pick<Project, 'id' | 'path' | 'last_opened_at' | 'ephemeral'>

/** 此连接上可作为 CLI 启动目录的项目：已注册、非临时、已信任，按最近打开排序。 */
export function connectionPrewarmCandidates<P extends Candidate>(projects: readonly P[], connectionId: string, trusted = createProjectTrustChecker()) {
  return projects
    .filter(p => sshConnectionIdFromUri(p.path) === connectionId && !p.ephemeral && trusted(p))
    .sort((a, b) => b.last_opened_at - a.last_opened_at)
}

/**
 * fixed：用户固定；cli：从 CLI 配置读到的已信任项目；auto：OpenCode 无目录信任，取最近打开。
 * Claude / Codex 未开启读取或读不到时返回 undefined，由用户自己选。
 */
export type PrewarmAnchorSource = 'fixed' | 'cli' | 'auto'

export function resolveConnectionPrewarmAnchor(connectionId: string, candidates: readonly Candidate[], options: {
  cliTrusted?: readonly string[]
  activePath?: string | null
} = {}): { path: string; source: PrewarmAnchorSource } | undefined {
  const saved = readSaved(connectionId)
  const pinned = saved?.anchor ? candidates.find(p => p.path === saved.anchor) : undefined
  if (pinned) return { path: pinned.path, source: 'fixed' }
  const agent = saved && prewarmCliAgent(saved.profile.command)
  if (!cliHasDirectoryTrust(agent)) return candidates[0] && { path: candidates[0].path, source: 'auto' }
  if (!saved?.readCliConfig || !options.cliTrusted) return
  const trusted = new Set(options.cliTrusted)
  const match = candidates.find(p => p.path === options.activePath && trusted.has(p.path)) ?? candidates.find(p => trusted.has(p.path))
  return match && { path: match.path, source: 'cli' }
}

function prewarmConnections(projects: readonly Candidate[]) {
  return new Set(projects.map(p => sshConnectionIdFromUri(p.path)).filter((c): c is string => !!c))
}

/** 开启了读取 CLI 配置的连接先读一次（有缓存），供后续同步计算启动目录。 */
export async function preloadConnectionCliTrust(projects: readonly Candidate[]) {
  const trusted = createProjectTrustChecker()
  await Promise.all([...prewarmConnections(projects)].map(connection => {
    const saved = readSaved(connection)
    const agent = saved && prewarmCliAgent(saved.profile.command)
    if (!saved?.readCliConfig || !cliHasDirectoryTrust(agent)) return
    const paths = connectionPrewarmCandidates(projects, connection, trusted).map(p => p.path)
    return paths.length ? loadCliTrust(connection, agent, paths) : undefined
  }))
}

/**
 * 发给后端的跨项目预热目录。OpenCode 自动模式下当前项目所在连接交给 active profile；
 * 固定目录与 CLI 已信任目录始终优先（CLI 未信任的当前项目会停在信任确认）。
 */
export function connectionPrewarmAnchors(projects: readonly Candidate[], activeConnection?: string | null, activePath?: string | null) {
  const trusted = createProjectTrustChecker()
  const anchors = []
  for (const connection of prewarmConnections(projects)) {
    const saved = readSaved(connection)
    if (!saved) continue
    const candidates = connectionPrewarmCandidates(projects, connection, trusted)
    const agent = prewarmCliAgent(saved.profile.command)
    const cliTrusted = saved.readCliConfig && cliHasDirectoryTrust(agent)
      ? cachedCliTrust(connection, agent, candidates.map(p => p.path))?.roots : undefined
    const anchor = resolveConnectionPrewarmAnchor(connection, candidates, { cliTrusted, activePath })
    if (!anchor || (anchor.source === 'auto' && connection === activeConnection)) continue
    const { profile } = saved
    anchors.push({ cwd: anchor.path, profileId: profile.id, shell: profile.shell, command: profile.command.trim() })
  }
  return anchors
}
