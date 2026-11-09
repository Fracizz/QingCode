import { describe, expect, it } from 'vitest'
import { nearestVerticalDrop } from './useVerticalPointerReorder'

const items = [
  { id: 'a', top: 0, bottom: 40 },
  { id: 'b', top: 50, bottom: 90 },
]

describe('nearestVerticalDrop', () => {
  it('splits an item at its middle', () => {
    expect(nearestVerticalDrop(items, 10)).toEqual({ id: 'a', position: 'before' })
    expect(nearestVerticalDrop(items, 30)).toEqual({ id: 'a', position: 'after' })
  })

  it('uses the closest item inside the gap between groups', () => {
    expect(nearestVerticalDrop(items, 43)).toEqual({ id: 'a', position: 'after' })
    expect(nearestVerticalDrop(items, 48)).toEqual({ id: 'b', position: 'before' })
  })

  it('clamps above the first and below the last item', () => {
    expect(nearestVerticalDrop(items, -20)).toEqual({ id: 'a', position: 'before' })
    expect(nearestVerticalDrop(items, 200)).toEqual({ id: 'b', position: 'after' })
  })

  it('has no drop for an empty list', () => {
    expect(nearestVerticalDrop([], 10)).toBeNull()
  })
})
