import { describe, expect, it } from 'vitest'
import {
  MAX_OPEN_EDITOR_TABS,
  pickEvictableTabId,
  pickVisibleTabIndices,
} from './editorTabsLayout'

describe('pickVisibleTabIndices', () => {
  it('returns all tabs when they fit', () => {
    expect(pickVisibleTabIndices([40, 40, 40], 1, 200, 32)).toEqual([0, 1, 2])
  })

  it('keeps the active tab visible when overflowing', () => {
    // budget = 200 - 32 = 168 → two 60px tabs (120), third would be 180
    const widths = [60, 60, 60, 60, 60]
    expect(pickVisibleTabIndices(widths, 4, 200, 32)).toEqual([3, 4])
    expect(pickVisibleTabIndices(widths, 0, 200, 32)).toEqual([0, 1])
  })

  it('returns only active when even one tab barely fits', () => {
    expect(pickVisibleTabIndices([400, 40], 0, 100, 32)).toEqual([0])
  })
})

describe('pickEvictableTabId', () => {
  const tabs = [
    { id: 'a', dirty: false, path: '/a' },
    { id: 'b', dirty: true, path: '/b' },
    { id: 'c', dirty: false, path: '/c' },
  ]

  it('evicts least-recent clean tab', () => {
    expect(pickEvictableTabId(tabs, ['a', 'b', 'c'], () => false, 'a')).toBe('c')
  })

  it('skips dirty and pinned tabs', () => {
    expect(
      pickEvictableTabId(tabs, ['a', 'b', 'c'], path => path === '/c', 'a'),
    ).toBeNull()
  })

  it('exposes a positive max open cap', () => {
    expect(MAX_OPEN_EDITOR_TABS).toBeGreaterThan(0)
  })
})
