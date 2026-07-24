import { describe, expect, it } from 'vitest'
import {
  FOLD_MARKER_BOX,
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

  it('uses the same square box for open and folded markers', () => {
    const box = { width: FOLD_MARKER_BOX, height: FOLD_MARKER_BOX }
    expect(foldGutterMarkerSize()).toEqual(box)
    expect(foldGutterMarkerSize()).toEqual(box)
    expect(FOLD_MARKER_BOX).toBe(FOLD_MARKER_W)
  })

  it('builds inset hollow chevrons centered in the square viewBox', () => {
    const pad = (FOLD_MARKER_BOX - FOLD_MARKER_H) / 2
    expect(foldGutterMarkerPath(true)).toBe(
      `M 0.5 ${pad} L ${FOLD_MARKER_W / 2} ${pad + FOLD_MARKER_H} L ${FOLD_MARKER_W - 0.5} ${pad}`,
    )
    expect(FOLD_MARKER_W).toBe(8)
    expect(FOLD_MARKER_W_EM).toBeCloseTo(8 / 14, 6)
    expect(foldGutterMarkerPath(false)).toBe(
      `M ${pad} 0.5 L ${pad + FOLD_MARKER_H} ${FOLD_MARKER_W / 2} L ${pad} ${FOLD_MARKER_W - 0.5}`,
    )
    expect(foldGutterMarkerPath(true)).not.toMatch(/\bH\b|Z/i)
  })
})
