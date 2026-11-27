import { describe, expect, it } from 'vitest'
import { dropIndex, reorder, shiftFor } from './sortable'

const slots = [[0, 60], [60, 60], [120, 60], [180, 60]] as const

describe('长按拖动排序', () => {
  it('reorder 移动元素且不改原数组，越界或原地不动时原样返回副本', () => {
    const items = ['a', 'b', 'c', 'd']
    expect(reorder(items, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorder(items, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(reorder(items, 1, 1)).toEqual(items)
    expect(reorder(items, 5, 0)).toEqual(items)
    expect(items).toEqual(['a', 'b', 'c', 'd'])
  })

  it('dropIndex 越过相邻项中线才交换', () => {
    expect(dropIndex(slots, 0, 29)).toBe(0)
    expect(dropIndex(slots, 0, 31)).toBe(1)
    expect(dropIndex(slots, 0, 95)).toBe(2)
    expect(dropIndex(slots, 0, 500)).toBe(3)
    expect(dropIndex(slots, 3, -31)).toBe(2)
    expect(dropIndex(slots, 3, -500)).toBe(0)
    expect(dropIndex(slots, 1, 0)).toBe(1)
  })

  it('shiftFor 只让落点区间内的项让位', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 60))).toEqual([0, -60, -60, 0])
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 60))).toEqual([0, 60, 60, 0])
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 1, 1, 60))).toEqual([0, 0, 0, 0])
  })
})
