import { describe, expect, it } from 'vitest'
import type { GitRemote, GitStatus } from '@/lib/git/git'
import {
  decideSync,
  normalizeRemoteUrl,
  parseConfig,
  parseUpstream,
  remoteUrlKeys,
  shouldWatchProject,
} from './core'

function status(partial: Partial<GitStatus>): GitStatus {
  return { is_repository: true, branch: 'main', upstream: 'origin/main', changes: [], ...partial } as GitStatus
}

describe('normalizeRemoteUrl', () => {
  it('treats scp, ssh and https forms of one repository as equal', () => {
    const expected = 'gitee.com/team/repo'
    expect(normalizeRemoteUrl('git@gitee.com:team/repo.git')).toBe(expected)
    expect(normalizeRemoteUrl('ssh://git@gitee.com:22/team/repo.git')).toBe(expected)
    expect(normalizeRemoteUrl('https://user:token@gitee.com/team/repo/')).toBe(expected)
    expect(normalizeRemoteUrl('https://GITEE.com/Team/Repo.git')).toBe(expected)
  })

  it('keeps different hosts and local paths distinct', () => {
    expect(normalizeRemoteUrl('git@github.com:team/repo.git')).not.toBe(
      normalizeRemoteUrl('git@gitee.com:team/repo.git'),
    )
    expect(normalizeRemoteUrl('C:\\repos\\app.git')).toBe('c:/repos/app')
    expect(normalizeRemoteUrl('/srv/git/app.git')).toBe('/srv/git/app')
  })
})

describe('remoteUrlKeys', () => {
  it('includes every push url so mirrored remotes still match', () => {
    const remote: GitRemote = {
      name: 'origin',
      fetch_url: 'https://gitee.com/a/b.git',
      push_urls: ['git@gitee.com:a/b.git', 'git@github.com:a/b.git'],
    }
    expect(remoteUrlKeys(remote)).toEqual(['gitee.com/a/b', 'github.com/a/b'])
  })
})

describe('parseUpstream', () => {
  const remote = (name: string): GitRemote => ({ name, fetch_url: null, push_urls: [] })

  it('splits branch names containing slashes', () => {
    expect(parseUpstream('origin/feat/x', [remote('origin')])?.branch).toBe('feat/x')
  })

  it('prefers the longest matching remote name', () => {
    const result = parseUpstream('team/fork/main', [remote('team'), remote('team/fork')])
    expect(result?.remote.name).toBe('team/fork')
    expect(result?.branch).toBe('main')
  })

  it('returns null without an upstream or a known remote', () => {
    expect(parseUpstream(null, [remote('origin')])).toBeNull()
    expect(parseUpstream('other/main', [remote('origin')])).toBeNull()
  })
})

describe('decideSync', () => {
  it('fast-forwards only when strictly behind', () => {
    expect(decideSync(status({ behind: 2, ahead: 0 }))).toBe('fast-forward')
    expect(decideSync(status({ behind: 2, ahead: 1 }))).toBe('diverged')
    expect(decideSync(status({ behind: 0, ahead: 1 }))).toBe('ahead')
    expect(decideSync(status({ behind: 0, ahead: 0 }))).toBe('up-to-date')
  })

  it('refuses detached heads and untracked branches', () => {
    expect(decideSync(status({ branch: null, behind: 1 }))).toBe('no-upstream')
    expect(decideSync(status({ upstream: null, behind: 1 }))).toBe('no-upstream')
  })
})

describe('parseConfig', () => {
  it('falls back to safe defaults for missing or corrupt data', () => {
    expect(parseConfig(null).enabled).toBe(false)
    expect(parseConfig('{oops').enabled).toBe(false)
    expect(parseConfig('{"action":"merge"}').action).toBe('fast-forward')
  })

  it('reads a stored configuration', () => {
    const parsed = parseConfig(
      '{"enabled":true,"action":"notify","receivers":["a",1],"identities":{"a":["x"]}}',
    )
    expect(parsed).toEqual({
      enabled: true,
      action: 'notify',
      receivers: ['a'],
      identities: { a: ['x'] },
    })
  })
})

describe('shouldWatchProject', () => {
  const receiver = { projectId: 'b', keys: ['repo'] }

  it('watches another project of the same repository', () => {
    expect(shouldWatchProject({ projectId: 'a', keys: ['repo'] }, [receiver])).toBe(true)
  })

  it('does not watch unrelated projects or a lone receiver', () => {
    expect(shouldWatchProject({ projectId: 'a', keys: ['other'] }, [receiver])).toBe(false)
    expect(shouldWatchProject({ projectId: 'b', keys: ['repo'] }, [receiver])).toBe(false)
  })
})
