import { describe, expect, it } from 'vitest'
import type { Project } from '../types'
import {
  durableSortOrders,
  reorderVisibleProjects,
  sortVisibleProjects,
} from './projectChipOrder'

function project(over: Partial<Project>): Project {
  return {
    id: 'id',
    name: 'name',
    path: 'D:/p',
    created_at: 1,
    last_opened_at: 1,
    hidden: 0,
    sort_order: 0,
    ...over,
  }
}

describe('sortVisibleProjects', () => {
  it('hides hidden projects and sorts by sort_order then last_opened_at', () => {
    const list = [
      project({ id: 'a', name: 'A', sort_order: 2, last_opened_at: 10, hidden: 0 }),
      project({ id: 'b', name: 'B', sort_order: 1, last_opened_at: 99, hidden: 1 }),
      project({ id: 'c', name: 'C', sort_order: 1, last_opened_at: 50, hidden: 0 }),
      project({ id: 'd', name: 'D', sort_order: 1, last_opened_at: 80, hidden: 0 }),
    ]
    expect(sortVisibleProjects(list).map(p => p.id)).toEqual(['d', 'c', 'a'])
  })
})

describe('reorderVisibleProjects', () => {
  it('moves a visible chip and renumbers sort_order', () => {
    const list = [
      project({ id: 'a', name: 'A', path: 'D:/a', sort_order: 0, last_opened_at: 3 }),
      project({ id: 'b', name: 'B', path: 'D:/b', sort_order: 1, last_opened_at: 2 }),
      project({ id: 'c', name: 'C', path: 'D:/c', sort_order: 2, last_opened_at: 1 }),
      project({ id: 'h', name: 'Hidden', path: 'D:/h', sort_order: 9, hidden: 1 }),
    ]
    const next = reorderVisibleProjects(list, 0, 2)
    expect(next.filter(p => !p.hidden).map(p => p.id)).toEqual(['b', 'c', 'a'])
    expect(next.find(p => p.id === 'a')?.sort_order).toBe(2)
    expect(next.find(p => p.id === 'b')?.sort_order).toBe(0)
    expect(next.find(p => p.id === 'c')?.sort_order).toBe(1)
    expect(next.find(p => p.id === 'h')?.sort_order).toBe(3)
  })

  it('returns the same array when indices are unchanged or invalid', () => {
    const list = [project({ id: 'a' }), project({ id: 'b', path: 'D:/b' })]
    expect(reorderVisibleProjects(list, 0, 0)).toBe(list)
    expect(reorderVisibleProjects(list, -1, 0)).toBe(list)
    expect(reorderVisibleProjects(list, 0, 9)).toBe(list)
  })
})

describe('durableSortOrders', () => {
  it('skips ephemeral projects', () => {
    const list = [
      project({ id: 'a', sort_order: 1 }),
      project({ id: 'tmp', path: 'D:/tmp', ephemeral: true, sort_order: 0 }),
    ]
    expect(durableSortOrders(list)).toEqual([{ id: 'a', sortOrder: 1 }])
  })
})
