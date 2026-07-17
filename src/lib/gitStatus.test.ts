import { describe, expect, it } from 'vitest'
import {
  buildStatusMap,
  dirGitStatus,
  dirHasGitChanges,
  gitStatusColorClass,
  gitStatusGlyph,
  gitStatusKey,
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
})
