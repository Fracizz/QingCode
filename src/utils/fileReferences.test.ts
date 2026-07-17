import { describe, expect, it } from 'vitest'
import {
  collectAncestorDirs,
  findProjectForPath,
  formatFileReference,
  isDescendantOf,
  normalizePath,
  parentPath,
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
