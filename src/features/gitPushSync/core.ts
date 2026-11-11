/** 「Git 多端同步」的纯逻辑：配置解析、仓库身份匹配和同步判定。 */
import type { GitRemote, GitStatus } from '@/lib/git/git'

export type SyncAction = 'fast-forward' | 'notify'

export type GitPushSyncConfig = {
  enabled: boolean
  action: SyncAction
  /** 开启自动接收的项目 id。 */
  receivers: string[]
  /** 接收项目最近一次读取到的仓库地址，离线时仍能判断该监听哪些推送来源。 */
  identities: Record<string, string[]>
}

export const DEFAULT_CONFIG: GitPushSyncConfig = {
  enabled: false,
  action: 'fast-forward',
  receivers: [],
  identities: {},
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

export function parseConfig(raw: string | null | undefined): GitPushSyncConfig {
  if (!raw) return { ...DEFAULT_CONFIG }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const identities: Record<string, string[]> = {}
    if (parsed.identities && typeof parsed.identities === 'object') {
      for (const [id, keys] of Object.entries(parsed.identities)) identities[id] = stringArray(keys)
    }
    return {
      enabled: parsed.enabled === true,
      action: parsed.action === 'notify' ? 'notify' : 'fast-forward',
      receivers: stringArray(parsed.receivers),
      identities,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 把 SSH、HTTPS 和 scp 写法归一，使同一仓库的不同克隆地址可以匹配。 */
export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  const clean = (value: string) =>
    value
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname
      path = decodeURIComponent(parsed.pathname)
    } catch {
      return clean(trimmed).toLowerCase()
    }
    if (!host) return clean(path).toLowerCase()
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(trimmed)
    if (!scp) return clean(trimmed).toLowerCase()
    host = scp[1]
    path = scp[2]
  }
  return `${host}/${clean(path).replace(/^\/+/, '')}`.toLowerCase()
}

export function remoteUrlKeys(remote: GitRemote): string[] {
  const urls = [remote.fetch_url, ...remote.push_urls]
  return [...new Set(urls.flatMap(url => (url ? [normalizeRemoteUrl(url)] : [])).filter(Boolean))]
}

export function allRemoteKeys(remotes: GitRemote[]): string[] {
  return [...new Set(remotes.flatMap(remoteUrlKeys))]
}

export function keysOverlap(a: Iterable<string>, b: Iterable<string>): boolean {
  const set = new Set(a)
  for (const key of b) if (set.has(key)) return true
  return false
}

/** 上游名形如 `origin/feat/x`；按最长远程名匹配，兼容含 `/` 的远程。 */
export function parseUpstream(
  upstream: string | null | undefined,
  remotes: GitRemote[],
): { remote: GitRemote; branch: string } | null {
  if (!upstream) return null
  const match = remotes
    .filter(remote => upstream.startsWith(`${remote.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (!match) return null
  const branch = upstream.slice(match.name.length + 1)
  return branch ? { remote: match, branch } : null
}

export type SyncDecision = 'fast-forward' | 'up-to-date' | 'ahead' | 'diverged' | 'no-upstream'

/** 同步判定只需要的字段：完整的 GitStatus 或轻量的跟踪查询结果都满足。 */
export type SyncTracking = Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> & {
  is_repository?: boolean
}

/** 只有纯落后才能快进；detached HEAD（含 rebase 中）没有分支或上游。 */
export function decideSync(status: SyncTracking): SyncDecision {
  if (status.is_repository === false || !status.branch || !status.upstream) return 'no-upstream'
  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0
  if (behind === 0) return ahead > 0 ? 'ahead' : 'up-to-date'
  return ahead > 0 ? 'diverged' : 'fast-forward'
}

export type RepositoryIdentity = { projectId: string; keys: string[] }

/** 只有存在另一个接收项目属于同一仓库时，才需要监听这个项目的推送。 */
export function shouldWatchProject(
  project: RepositoryIdentity,
  receivers: RepositoryIdentity[],
): boolean {
  return receivers.some(
    receiver => receiver.projectId !== project.projectId && keysOverlap(receiver.keys, project.keys),
  )
}
