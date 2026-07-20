import { describe, expect, it } from 'vitest'
import {
  absoluteGitPath,
  buildStatusMap,
  changesFromWorkdirEntries,
  dirGitStatus,
  dirHasGitChanges,
  gitChangePathLooksLikeDirectory,
  gitStatusColorClass,
  gitStatusFromWorkdirEntries,
  gitStatusGlyph,
  gitStatusKey,
  gitStatusMayBeDirectory,
  normalizeGitChangePath,
} from './gitStatus'

describe('gitStatus helpers', () => {
  it('normalizes path keys', () => {
    expect(gitStatusKey('D:\\Repo\\src\\a.ts')).toBe('d:/repo/src/a.ts')
  })

  it('maps glyphs and colors', () => {
    expect(gitStatusGlyph('??')).toBe('U')
    expect(gitStatusGlyph('M')).toBe('M')
    expect(gitStatusGlyph('AM')).toBe('M')
    expect(gitStatusColorClass('??')).toBe('text-ok')
    expect(gitStatusColorClass('D')).toBe('text-danger')
    expect(gitStatusColorClass('M')).toBe('text-warn')
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
        { path: 'D:\\repo\\src\\a.ts', status: 'M' },
        { path: 'D:/repo/new.ts', status: '??' },
      ]),
    ).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'new.ts', status: '??' },
    ])
    expect(
      gitStatusFromWorkdirEntries(
        'D:\\repo',
        [{ path: 'D:\\repo\\src\\a.ts', status: 'M' }],
        'main',
      ),
    ).toEqual({
      is_repository: true,
      branch: 'main',
      changes: [{ path: 'src/a.ts', status: 'M' }],
    })
  })

  it('detects directory-like git change paths', () => {
    expect(normalizeGitChangePath('.qingcode/')).toBe('.qingcode')
    expect(normalizeGitChangePath('src\\tmp\\')).toBe('src\\tmp')
    expect(gitChangePathLooksLikeDirectory('.qingcode/')).toBe(true)
    expect(gitChangePathLooksLikeDirectory('.qingcode')).toBe(false)
    expect(gitStatusMayBeDirectory('??')).toBe(true)
    expect(gitStatusMayBeDirectory('M')).toBe(false)
  })
})
