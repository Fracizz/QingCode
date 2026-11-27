import { describe, expect, it } from 'vitest'
import { ARCHIVE_ACTION_WIDTH, threadSwipeAxis, threadSwipeOffset } from './threadSwipe'

describe('会话滑动', () => {
  it('忽略轻微移动，区分水平手势和竖向滚动', () => {
    expect(threadSwipeAxis(-7, 4)).toBeNull()
    expect(threadSwipeAxis(-10, 16)).toBe('vertical')
    expect(threadSwipeAxis(-18, 10)).toBe('horizontal')
    expect(threadSwipeAxis(18, 10)).toBe('horizontal')
  })

  it('左滑最多露出整个操作区，右滑可合回', () => {
    expect(threadSwipeOffset(false, -20)).toBe(-20)
    expect(threadSwipeOffset(false, -200)).toBe(-ARCHIVE_ACTION_WIDTH)
    expect(threadSwipeOffset(false, 20)).toBe(0)
    expect(threadSwipeOffset(true, 20)).toBe(20 - ARCHIVE_ACTION_WIDTH)
    expect(threadSwipeOffset(true, 200)).toBe(0)
  })
})
