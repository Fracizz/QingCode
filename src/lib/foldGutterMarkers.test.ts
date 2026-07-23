import { describe, expect, it } from 'vitest'
import {
  FOLD_MARKER_H,
  FOLD_MARKER_W,
  FOLD_MARKER_W_EM,
  foldGutterMarkerPath,
  foldGutterMarkerSize,
} from './foldGutterMarkers'

describe('foldGutterMarkers geometry', () => {
  it('uses a 60° vertex isosceles triangle', () => {
    const halfBase = FOLD_MARKER_W / 2
    const vertexHalfAngle = Math.atan(halfBase / FOLD_MARKER_H) * (180 / Math.PI)
    expect(vertexHalfAngle).toBeCloseTo(30, 4)
    const legFromHorizontal = Math.atan(FOLD_MARKER_H / halfBase) * (180 / Math.PI)
    expect(legFromHorizontal).toBeCloseTo(60, 3)
  })

  it('sizes open vs folded markers from the same W/H constants', () => {
    expect(foldGutterMarkerSize(true)).toEqual({
      width: FOLD_MARKER_W,
      height: FOLD_MARKER_H,
    })
    expect(foldGutterMarkerSize(false)).toEqual({
      width: FOLD_MARKER_H,
      height: FOLD_MARKER_W,
    })
  })

  it('builds inset hollow chevrons for down and right carets', () => {
    expect(foldGutterMarkerPath(true)).toBe(
      `M 0.5 0 L ${FOLD_MARKER_W / 2} ${FOLD_MARKER_H} L ${FOLD_MARKER_W - 0.5} 0`,
    )
    expect(FOLD_MARKER_W).toBe(8)
    expect(FOLD_MARKER_W_EM).toBeCloseTo(8 / 14, 6)
    expect(foldGutterMarkerPath(false)).toContain(`L ${FOLD_MARKER_H} ${FOLD_MARKER_W / 2}`)
    expect(foldGutterMarkerPath(true)).not.toMatch(/\bH\b|Z/i)
  })
})
