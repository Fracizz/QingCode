import { describe, expect, it } from 'vitest'
import {
  MAX_SELECTION_LENGTH,
  normalizeSelectionText,
  toolbarPosition,
  visibleSelectionBox,
} from './selection'

const rect = (top: number, left: number, width: number, height: number) => ({ top, left, width, height })

describe('选区文本', () => {
  it('去掉首尾空白、统一换行、限制长度', () => {
    expect(normalizeSelectionText('  a\r\nb  ')).toBe('a\nb')
    expect(normalizeSelectionText('   \n ')).toBe('')
    const long = normalizeSelectionText('x'.repeat(MAX_SELECTION_LENGTH + 20))
    expect(long).toHaveLength(MAX_SELECTION_LENGTH + 1)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('选区坐标与浮层位置', () => {
  it('选用首个仍可见的片段，并裁掉超出视口的范围', () => {
    expect(
      visibleSelectionBox(
        [rect(70, 30, 80, 18), rect(100, 30, 0, 18), rect(95, 10, 900, 18), rect(115, 30, 50, 18)],
        rect(100, 20, 600, 400),
      ),
    ).toEqual({ top: 0, left: 0, width: 600, height: 13 })
    expect(visibleSelectionBox([rect(500, 40, 80, 18)], rect(100, 20, 600, 400))).toBeNull()
  })

  it('浮层在选区上方居中，且不越出容器左右边界', () => {
    expect(toolbarPosition({ top: 200, left: 300, width: 60, height: 18 }, 800, 200, 30))
      .toEqual({ top: 192, left: 230, above: true })
    expect(toolbarPosition({ top: 10, left: 2, width: 20, height: 18 }, 300, 200, 30))
      .toEqual({ top: 36, left: 8, above: false })
    expect(toolbarPosition({ top: 200, left: 290, width: 20, height: 18 }, 300, 200, 30))
      .toEqual({ top: 192, left: 92, above: true })
  })
})
