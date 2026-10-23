import { describe, expect, it } from 'vitest'
import type { GitCommitInfo } from './git'
import {
  clearScmCommitsCache,
  readScmCommitsCache,
  SCM_COMMITS_CACHE_TTL_MS,
  writeScmCommitsCache,
} from './scmCommitCache'

const commits: GitCommitInfo[] = [
  {
    hash: 'a'.repeat(40),
    short_hash: 'aaaaaaa',
    subject: 'feat: 首屏历史',
    author: 'QingCode',
    date: '2026-10-23T10:00:00+08:00',
    refs: 'HEAD -> main',
  },
]

describe('scmCommitCache', () => {
  it('misses until a snapshot is written', () => {
    clearScmCommitsCache()
    expect(readScmCommitsCache('D:/repo')).toBeNull()
  })

  it('round-trips commits and matches paths across separators and drive case', () => {
    clearScmCommitsCache()
    writeScmCommitsCache('D:\\repo\\', { commits, hasMore: false }, 1_000)

    expect(readScmCommitsCache('d:/repo', 1_000)?.commits).toEqual(commits)
    expect(readScmCommitsCache('D:/repo', 1_000)?.hasMore).toBe(false)
  })

  it('expires after the TTL so external commits cannot stay hidden', () => {
    clearScmCommitsCache()
    writeScmCommitsCache('D:/repo', { commits, hasMore: true }, 1_000)

    expect(readScmCommitsCache('D:/repo', 1_000 + SCM_COMMITS_CACHE_TTL_MS)).not.toBeNull()
    expect(readScmCommitsCache('D:/repo', 1_001 + SCM_COMMITS_CACHE_TTL_MS)).toBeNull()
  })

  it('clears one project or the whole cache', () => {
    clearScmCommitsCache()
    writeScmCommitsCache('D:/a', { commits, hasMore: false })
    writeScmCommitsCache('D:/b', { commits, hasMore: false })

    clearScmCommitsCache('D:/a')
    expect(readScmCommitsCache('D:/a')).toBeNull()
    expect(readScmCommitsCache('D:/b')).not.toBeNull()

    clearScmCommitsCache()
    expect(readScmCommitsCache('D:/b')).toBeNull()
  })
})
