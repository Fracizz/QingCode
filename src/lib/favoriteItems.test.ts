import { describe, expect, it } from 'vitest'
import type { FavoriteItem } from '../types'
import {
  favoriteAbsolutePath,
  favoriteRelativePath,
  moveFavoritePath,
  removeFavoritePath,
  reorderFavoriteItems,
} from './favoriteItems'

function item(relativePath: string, sortOrder: number, kind: FavoriteItem['kind'] = 'file'): FavoriteItem {
  return {
    projectId: 'p1',
    relativePath,
    kind,
    sortOrder,
    createdAt: sortOrder,
    available: true,
  }
}

describe('favorite path helpers', () => {
  it('roundtrips Windows project-relative paths case-insensitively', () => {
    expect(favoriteRelativePath('D:\\Code\\App', 'd:\\code\\app\\src\\main.ts')).toBe('src/main.ts')
    expect(favoriteAbsolutePath('D:\\Code\\App', 'src/main.ts')).toBe('D:\\Code\\App\\src\\main.ts')
  })

  it('rejects the project root and paths outside the project', () => {
    expect(favoriteRelativePath('D:/Code/App', 'D:/Code/App')).toBeNull()
    expect(favoriteRelativePath('D:/Code/App', 'D:/Code/Other/a.ts')).toBeNull()
  })

  it('keeps Unix path casing significant', () => {
    expect(favoriteRelativePath('/work/App', '/work/app/src/main.ts')).toBeNull()
  })

  it('reorders mixed file and directory favorites', () => {
    const items = [item('src', 0, 'directory'), item('README.md', 1), item('tests', 2, 'directory')]
    expect(reorderFavoriteItems(items, 'tests', 'src', 'before').map(entry => entry.relativePath)).toEqual([
      'tests',
      'src',
      'README.md',
    ])
  })

  it('updates a moved directory and all bookmarked descendants', () => {
    const items = [item('src/old', 0, 'directory'), item('src/old/a.ts', 1), item('README.md', 2)]
    expect(moveFavoritePath(items, 'D:/App', 'D:/App/src/old', 'D:/App/src/new').map(entry => entry.relativePath)).toEqual([
      'src/new',
      'src/new/a.ts',
      'README.md',
    ])
  })

  it('removes a deleted directory and bookmarked descendants', () => {
    const items = [item('src/old', 0, 'directory'), item('src/old/a.ts', 1), item('README.md', 2)]
    expect(removeFavoritePath(items, 'D:/App', 'D:/App/src/old').map(entry => entry.relativePath)).toEqual([
      'README.md',
    ])
  })
})
