import { describe, expect, it } from 'vitest'
import {
  absoluteGitPath,
  buildStatusMap,
  canCommitStagedChanges,
  changesFromWorkdirEntries,
  dirGitStatus,
  dirHasGitChanges,
  formatScmDisplayPath,
  gitChangePathLooksLikeDirectory,
  gitChangeHasStaged,
  gitChangeHasUnstaged,
  gitIndexStatus,
  gitStatusColorClass,
  gitStatusFromWorkdirEntries,
  gitStatusGlyph,
  gitStatusGlyphForGroup,
  gitStatusKey,
  gitStatusMayBeDirectory,
  gitWorktreeStatus,
  normalizeGitChangePath,
  predictBulkGitStatusAfterAction,
  predictAfterStageChange,
  predictAfterUnstageChange,
  scmRowKey,
  scmStatusBadgeTone,
  splitGitChanges,
} from './gitStatus'

describe('gitStatus helpers', () => {
  it('normalizes path keys', () => {
    expect(gitStatusKey('D:\\Repo\\src\\a.ts')).toBe('d:/repo/src/a.ts')
  })

  it('maps glyphs and colors', () => {
    expect(gitStatusGlyph('??')).toBe('U')
    expect(gitStatusGlyph('M')).toBe('M')
    expect(gitStatusGlyph('AM')).toBe('M')
    expect(gitStatusGlyph('M ')).toBe('M')
    expect(gitStatusGlyph(' M')).toBe('M')
    expect(gitStatusColorClass('??')).toBe('text-ok')
    expect(gitStatusColorClass('D ')).toBe('text-danger')
    expect(gitStatusColorClass('R ')).toBe('text-accent')
    expect(gitStatusColorClass('M')).toBe('text-warn')
  })

  it('keeps index and worktree status columns distinct', () => {
    expect(gitIndexStatus('M ')).toBe('M')
    expect(gitWorktreeStatus('M ')).toBeNull()
    expect(gitIndexStatus(' M')).toBeNull()
    expect(gitWorktreeStatus(' M')).toBe('M')
    expect(gitIndexStatus('AM')).toBe('A')
    expect(gitWorktreeStatus('AM')).toBe('M')
    expect(gitIndexStatus('??')).toBeNull()
    expect(gitWorktreeStatus('??')).toBe('?')
  })

  it('splits dual-state changes into both Source Control groups', () => {
    const stagedOnly = { path: 'staged.ts', status: 'M ' }
    const unstagedOnly = { path: 'unstaged.ts', status: ' M' }
    const both = { path: 'both.ts', status: 'MM' }
    const addedThenModified = { path: 'added.ts', status: 'AM' }
    const untracked = { path: 'new.ts', status: '??' }
    const groups = splitGitChanges([stagedOnly, unstagedOnly, both, addedThenModified, untracked])

    expect(groups.staged).toEqual([stagedOnly, both, addedThenModified])
    expect(groups.unstaged).toEqual([unstagedOnly, both, addedThenModified, untracked])
    expect(gitChangeHasStaged(both)).toBe(true)
    expect(gitChangeHasUnstaged(both)).toBe(true)
    expect(gitStatusGlyphForGroup('AM', 'staged')).toBe('A')
    expect(gitStatusGlyphForGroup('AM', 'unstaged')).toBe('M')
    expect(gitStatusGlyphForGroup('??', 'unstaged')).toBe('U')
  })

  it('enables commit only for a message and staged changes while idle', () => {
    expect(canCommitStagedChanges('feat: ready', 1, false)).toBe(true)
    expect(canCommitStagedChanges('   ', 1, false)).toBe(false)
    expect(canCommitStagedChanges('feat: ready', 0, false)).toBe(false)
    expect(canCommitStagedChanges('feat: ready', 1, true)).toBe(false)
  })

  it('aggregates directory dirty state', () => {
    const map = buildStatusMap([
      { path: 'D:/repo/src/a.ts', status: 'M' },
      { path: 'D:/repo/src/new.ts', status: '??' },
      { path: 'D:/repo/README.md', status: 'A' },
    ])
    expect(dirHasGitChanges(map, 'D:/repo/src')).toBe(true)
    expect(dirHasGitChanges(map, 'D:/repo/lib')).toBe(false)
    expect(dirGitStatus(map, 'D:/repo/src')).toBe('M')
    expect(dirGitStatus(map, 'D:/repo/empty')).toBe(null)
  })

  it('dir with only untracked children shows ??', () => {
    const map = buildStatusMap([{ path: 'D:/repo/tmp/x.txt', status: '??' }])
    expect(dirGitStatus(map, 'D:/repo/tmp')).toBe('??')
  })

  it('converts workdir entries into SCM panel changes', () => {
    expect(absoluteGitPath('D:\\repo', 'src\\a.ts')).toBe('D:/repo/src/a.ts')
    expect(absoluteGitPath('D:\\repo', '.qingcode/')).toBe('D:/repo/.qingcode')
    expect(
      changesFromWorkdirEntries('D:\\repo', [
        { path: 'D:\\repo\\src\\a.ts', status: ' M' },
        { path: 'D:/repo/new.ts', status: '??' },
      ]),
    ).toEqual([
      { path: 'src/a.ts', status: ' M' },
      { path: 'new.ts', status: '??' },
    ])
    expect(
      gitStatusFromWorkdirEntries(
        'D:\\repo',
        [{ path: 'D:\\repo\\src\\a.ts', status: ' M' }],
        'main',
      ),
    ).toEqual({
      is_repository: true,
      branch: 'main',
      changes: [{ path: 'src/a.ts', status: ' M' }],
    })
  })

  it('detects directory-like git change paths', () => {
    expect(normalizeGitChangePath('.qingcode/')).toBe('.qingcode')
    expect(normalizeGitChangePath('src\\tmp\\')).toBe('src\\tmp')
    expect(gitChangePathLooksLikeDirectory('.qingcode/')).toBe(true)
    expect(gitChangePathLooksLikeDirectory('.qingcode')).toBe(false)
    expect(gitStatusMayBeDirectory('??')).toBe(true)
    expect(gitStatusMayBeDirectory(' M')).toBe(false)
  })

  it('formats scm display paths with middle ellipsis', () => {
    expect(scmRowKey('unstaged', 'src/a.ts')).toBe('unstaged:src/a.ts')
    expect(formatScmDisplayPath('short/path.ts')).toBe('short/path.ts')
    const long = 'packages/arm_docker/EMIS-eman/4.2.10/eman/.env.seaweedfs.example'
    expect(formatScmDisplayPath(long, 40)).toMatch(/^packages\/ar.+seaweedfs\.example$/)
    expect(formatScmDisplayPath(long, 40)).toContain('...')
  })

  it('maps scm badge tone', () => {
    expect(scmStatusBadgeTone('??', 'unstaged')).toBe('added')
    expect(scmStatusBadgeTone('D ', 'staged')).toBe('deleted')
    expect(scmStatusBadgeTone('M ', 'unstaged')).toBe('modified')
  })

  it('predicts optimistic bulk stage and unstage snapshots', () => {
    expect(predictAfterStageChange({ path: 'a.ts', status: '??' })).toEqual({
      path: 'a.ts',
      status: 'A ',
    })
    expect(predictAfterStageChange({ path: 'b.ts', status: ' M' })).toEqual({
      path: 'b.ts',
      status: 'M ',
    })
    expect(predictAfterUnstageChange({ path: 'a.ts', status: 'A ' })).toEqual({
      path: 'a.ts',
      status: '??',
    })
    expect(predictAfterUnstageChange({ path: 'b.ts', status: 'MM' })).toEqual({
      path: 'b.ts',
      status: ' M',
    })

    const status = {
      is_repository: true,
      branch: 'main',
      changes: [
        { path: 'a.ts', status: ' M' },
        { path: 'b.ts', status: 'M ' },
      ],
    }
    expect(predictBulkGitStatusAfterAction(status, 'unstaged')).toEqual({
      ...status,
      changes: [
        { path: 'a.ts', status: 'M ' },
        { path: 'b.ts', status: 'M ' },
      ],
    })
    expect(predictBulkGitStatusAfterAction(status, 'staged')).toEqual({
      ...status,
      changes: [
        { path: 'a.ts', status: ' M' },
        { path: 'b.ts', status: ' M' },
      ],
    })
  })
})
