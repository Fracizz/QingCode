import { describe, expect, it } from 'vitest'
import {
  CARET_VERTEX_DEG,
  isoscelesCaretHeight,
  isoscelesChevronPath,
} from './isoscelesArrowGeometry'

describe('isoscelesArrowGeometry', () => {
  it('uses H = (W/2) / tan(30°) for a 60° tip', () => {
    const w = 10
    const h = isoscelesCaretHeight(w, CARET_VERTEX_DEG)
    expect(h).toBeCloseTo((w * Math.sqrt(3)) / 2, 6)
    const legFromHorizontal = Math.atan(h / (w / 2)) * (180 / Math.PI)
    expect(legFromHorizontal).toBeCloseTo(60, 3)
  })

  it('builds hollow chevron paths without fill or top base segment', () => {
    const w = 10
    const h = isoscelesCaretHeight(w)
    const path = isoscelesChevronPath(w, h, 'down')
    expect(path).toBe(`M 0 0 L ${w / 2} ${h} L ${w} 0`)
    expect(path).not.toMatch(/[QCASZ]/i)
    expect(path).not.toMatch(/\bH\b/)
  })
})
