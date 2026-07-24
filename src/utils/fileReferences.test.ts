import { describe, expect, it } from 'vitest'
import {
  addPathToSet,
  collectAncestorDirs,
  findProjectForPath,
  formatFileReference,
  isDescendantOf,
  normalizePath,
  parentPath,
  parseFileReference,
  pathSetHas,
  pathsEqual,
} from './fileReferences'
import type { Project } from '../types'

const project = (path: string, name = 'demo'): Project => ({
  id: path,
  name,
  path,
  created_at: 0,
  last_opened_at: 0,
})

describe('normalizePath / parentPath / pathsEqual', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(normalizePath('D:\\Work\\a\\')).toBe('D:/Work/a')
    expect(normalizePath('D:/Work/a/')).toBe('D:/Work/a')
  })

  it('parentPath handles both separators', () => {
    expect(parentPath('D:/Work/a/b.ts')).toBe('D:/Work/a')
    expect(parentPath('D:\\Work\\a\\b.ts')).toBe('D:\\Work\\a')
  })

  it('pathsEqual is case-insensitive', () => {
    expect(pathsEqual('D:/Work/A', 'd:\\work\\a\\')).toBe(true)
  })

  it('pathSetHas / addPathToSet tolerate separator differences', () => {
    const set = new Set(['D:\\proj\\test'])
    expect(pathSetHas(set, 'D:/proj/test')).toBe(true)
    expect(addPathToSet(set, 'D:/proj/test')).toBe(set)
    expect(addPathToSet(set, 'D:/proj/other').has('D:/proj/other')).toBe(true)
  })

  it('pathSetHas does not match path-prefix siblings (eman vs eman-commonmng)', () => {
    const expanded = addPathToSet(new Set(), 'D:/repo/eman-nem/src/main/java/com/eman')
    expect(pathSetHas(expanded, 'D:/repo/eman-commonmng')).toBe(false)
    expect(pathSetHas(expanded, 'D:/repo/eman-nem/src/main/java/com/eman-commonmng')).toBe(false)
    expect(pathSetHas(addPathToSet(new Set(), 'D:/repo/eman'), 'D:/repo/eman-commonmng')).toBe(false)
  })
})

describe('isDescendantOf / collectAncestorDirs / findProjectForPath', () => {
  it('detects descendants', () => {
    expect(isDescendantOf('D:/proj/src/a.ts', 'D:/proj')).toBe(true)
    expect(isDescendantOf('D:/proj', 'D:/proj')).toBe(true)
    expect(isDescendantOf('D:/other/a.ts', 'D:/proj')).toBe(false)
  })

  it('collects ancestor dirs excluding root', () => {
    expect(collectAncestorDirs('D:/proj/src/util/a.ts', 'D:/proj')).toEqual([
      'D:/proj/src',
      'D:/proj/src/util',
    ])
  })

  it('does not treat string-prefix sibling folders as ancestors', () => {
    expect(
      collectAncestorDirs('D:/repo/eman-nem/src/main/java/com/eman/Foo.java', 'D:/repo'),
    ).toEqual([
      'D:/repo/eman-nem',
      'D:/repo/eman-nem/src',
      'D:/repo/eman-nem/src/main',
      'D:/repo/eman-nem/src/main/java',
      'D:/repo/eman-nem/src/main/java/com',
      'D:/repo/eman-nem/src/main/java/com/eman',
    ])
    expect(collectAncestorDirs('D:/repo/eman-commonmng/src/Foo.java', 'D:/repo/eman-nem')).toEqual(
      [],
    )
  })

  it('picks the longest matching project root', () => {
    const projects = [project('D:/work'), project('D:/work/app', 'app')]
    expect(findProjectForPath(projects, 'D:/work/app/src/main.ts')?.name).toBe('app')
    expect(findProjectForPath(projects, 'D:/work/other.ts')?.name).toBe('demo')
    expect(findProjectForPath(projects, 'E:/none.ts')).toBeUndefined()
  })
})

describe('formatFileReference', () => {
  it('formats single and multi-line refs', () => {
    const p = project('D:/work/app', 'App')
    expect(formatFileReference(p, 'D:/work/app/src/a.ts', 10)).toBe('@App/src/a.ts#L10')
    expect(formatFileReference(p, 'D:/work/app/src/a.ts', 10, 12)).toBe('@App/src/a.ts#L10-L12')
  })
})

describe('parseFileReference', () => {
  it('parses Alt+C style @project/path#L refs', () => {
    expect(parseFileReference('@qingcode/.qingcode/run.json#L17')).toEqual({
      projectName: 'qingcode',
      fileQuery: '.qingcode/run.json',
      line: 17,
    })
    expect(parseFileReference('@App/src/a.ts#L10-L12')).toEqual({
      projectName: 'App',
      fileQuery: 'src/a.ts',
      line: 10,
      endLine: 12,
    })
  })

  it('accepts bare path#L without project prefix', () => {
    expect(parseFileReference('.qingcode/run.json#L17')).toEqual({
      fileQuery: '.qingcode/run.json',
      line: 17,
    })
  })

  it('leaves non-reference paths intact', () => {
    expect(parseFileReference('foo.ts:42')).toEqual({ fileQuery: 'foo.ts:42' })
    expect(parseFileReference('@alone')).toEqual({ fileQuery: '@alone' })
  })
})
