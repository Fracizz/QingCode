import type { GitRemote } from '@/lib/git/git'

export type ScmRemoteRow = {
  key: string
  name: string
  url: string
  kind: 'both' | 'fetch' | 'push'
  isCurrent: boolean
}

export function upstreamRemoteName(upstream: string | null | undefined): string | null {
  if (!upstream) return null
  const slash = upstream.indexOf('/')
  if (slash <= 0) return null
  return upstream.slice(0, slash)
}

export function flattenRemoteRows(
  remotes: GitRemote[],
  currentRemote: string | null,
): ScmRemoteRow[] {
  const rows: ScmRemoteRow[] = []
  for (const remote of remotes) {
    const isCurrent = currentRemote === remote.name
    const roles = new Map<string, Set<'fetch' | 'push'>>()
    if (remote.fetch_url) {
      roles.set(remote.fetch_url, new Set(['fetch']))
    }
    for (const url of remote.push_urls) {
      const set = roles.get(url) ?? new Set()
      set.add('push')
      roles.set(url, set)
    }
    let index = 0
    for (const [url, kinds] of roles) {
      const kind: ScmRemoteRow['kind'] =
        kinds.has('fetch') && kinds.has('push')
          ? 'both'
          : kinds.has('fetch')
            ? 'fetch'
            : 'push'
      rows.push({
        key: `${remote.name}:${index}:${url}`,
        name: remote.name,
        url,
        kind,
        isCurrent,
      })
      index += 1
    }
  }
  return rows
}

/** Prefer upstream remote URL, otherwise the first listed remote URL. */
export function primaryRemoteRow(
  remotes: GitRemote[] | null | undefined,
  upstream: string | null | undefined,
): ScmRemoteRow | null {
  if (!remotes || remotes.length === 0) return null
  const rows = flattenRemoteRows(remotes, upstreamRemoteName(upstream))
  if (rows.length === 0) return null
  return rows.find(row => row.isCurrent) ?? rows[0]
}
