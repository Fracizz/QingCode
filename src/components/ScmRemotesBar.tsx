import { Copy, Link } from 'lucide-react'
import { useMemo } from 'react'
import type { GitRemote } from '@/lib/git/git'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { copyToClipboard } from '../utils/fileReferences'
import Tooltip from './Tooltip'

export type ScmRemotesBarProps = {
  remotes: GitRemote[] | null
  upstream: string | null | undefined
  loading?: boolean
}

type RemoteRow = {
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
): RemoteRow[] {
  const rows: RemoteRow[] = []
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
      const kind: RemoteRow['kind'] =
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

export default function ScmRemotesBar({ remotes, upstream, loading = false }: ScmRemotesBarProps) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const currentRemote = useMemo(() => upstreamRemoteName(upstream), [upstream])
  const rows = useMemo(
    () => (remotes ? flattenRemoteRows(remotes, currentRemote) : []),
    [remotes, currentRemote],
  )

  const copyUrl = async (url: string) => {
    try {
      await copyToClipboard(url)
      pushToast('success', t('已复制远程地址'))
    } catch (reason) {
      pushToast('error', t('复制失败: {error}', { error: String(reason) }))
    }
  }

  return (
    <div className="shrink-0 border-b border-border/60 bg-bg-sidebar px-3 py-1.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-muted">
        <Link size={12} className="text-brand shrink-0" />
        <span>{t('GIT 地址')}</span>
      </div>
      {loading && remotes === null ? (
        <div className="px-0.5 text-[12px] text-fg-dim">{t('正在读取远程地址…')}</div>
      ) : rows.length === 0 ? (
        <div className="px-0.5 text-[12px] text-fg-dim">{t('暂无远程地址')}</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map(row => (
            <li key={row.key} className="flex min-w-0 items-center gap-1.5 text-[12px]">
              <span className="shrink-0 font-medium text-fg">{row.name}</span>
              {row.isCurrent && (
                <span className="shrink-0 rounded px-1 py-px text-[10px] text-accent bg-accent/10">
                  {t('当前')}
                </span>
              )}
              {row.kind === 'fetch' && (
                <span className="shrink-0 text-[10px] text-fg-dim">{t('拉取')}</span>
              )}
              {row.kind === 'push' && (
                <span className="shrink-0 text-[10px] text-fg-dim">{t('推送')}</span>
              )}
              <Tooltip label={row.url} side="bottom" wrapperClassName="min-w-0 flex-1">
                <span className="block min-w-0 truncate font-mono text-[11px] text-fg-muted">
                  {row.url}
                </span>
              </Tooltip>
              <Tooltip label={t('复制')} side="bottom" wrapperClassName="shrink-0 inline-flex">
                <button
                  type="button"
                  aria-label={t('复制')}
                  className="rounded p-0.5 text-fg-dim hover:bg-bg-hover hover:text-fg transition-colors"
                  onClick={() => void copyUrl(row.url)}
                >
                  <Copy size={12} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
