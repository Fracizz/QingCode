import { describe, expect, it } from 'vitest'
import { flattenRemoteRows, upstreamRemoteName } from './ScmRemotesBar'
import type { GitRemote } from '@/lib/git/git'

describe('ScmRemotesBar helpers', () => {
  it('extracts remote name from upstream ref', () => {
    expect(upstreamRemoteName('origin/main')).toBe('origin')
    expect(upstreamRemoteName('github/feature/x')).toBe('github')
    expect(upstreamRemoteName(null)).toBeNull()
    expect(upstreamRemoteName('main')).toBeNull()
  })

  it('collapses identical fetch and push urls', () => {
    const remotes: GitRemote[] = [
      {
        name: 'origin',
        fetch_url: 'https://example.com/a.git',
        push_urls: ['https://example.com/a.git'],
      },
    ]
    expect(flattenRemoteRows(remotes, 'origin')).toEqual([
      {
        key: 'origin:0:https://example.com/a.git',
        name: 'origin',
        url: 'https://example.com/a.git',
        kind: 'both',
        isCurrent: true,
      },
    ])
  })

  it('lists distinct push urls separately', () => {
    const remotes: GitRemote[] = [
      {
        name: 'origin',
        fetch_url: 'https://gitee.com/a.git',
        push_urls: ['https://gitee.com/a.git', 'https://github.com/a.git'],
      },
    ]
    const rows = flattenRemoteRows(remotes, null)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'both', url: 'https://gitee.com/a.git', isCurrent: false })
    expect(rows[1]).toMatchObject({ kind: 'push', url: 'https://github.com/a.git' })
  })
})
