import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  centeredOffset,
  clampOffset,
  fitScaleFor,
  imageTransform,
  nextZoomLevel,
  prevZoomLevel,
  rotatedSize,
  wheelZoomFactor,
  zoomOffsetAt,
} from './imageViewTransform'

describe('imageViewTransform', () => {
  it('steps through zoom levels and snaps from in-between scales', () => {
    expect(nextZoomLevel(1)).toBe(1.25)
    expect(prevZoomLevel(1)).toBe(0.75)
    expect(nextZoomLevel(0.9)).toBe(1)
    expect(prevZoomLevel(1.1)).toBe(1)
    expect(nextZoomLevel(MAX_SCALE)).toBe(MAX_SCALE)
    expect(prevZoomLevel(MIN_SCALE)).toBe(MIN_SCALE)
  })

  it('maps wheel deltas to a bounded exponential factor', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1.2)
    expect(wheelZoomFactor(100, 0)).toBeLessThan(0.83)
    // 行模式按 16px/行折算，与像素模式等价。
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0))
    expect(wheelZoomFactor(-10000, 0)).toBe(2)
    expect(wheelZoomFactor(10000, 0)).toBe(0.5)
  })

  it('swaps the bounding box for odd quarter turns, including negative ones', () => {
    const natural = { width: 400, height: 100 }
    expect(rotatedSize(natural, 0)).toEqual(natural)
    expect(rotatedSize(natural, 1)).toEqual({ width: 100, height: 400 })
    expect(rotatedSize(natural, -1)).toEqual({ width: 100, height: 400 })
    expect(rotatedSize(natural, 2)).toEqual(natural)
  })

  it('fits and centers the box inside the padded viewport', () => {
    const box = { width: 2000, height: 1000 }
    const viewport = { width: 1024, height: 1024 }
    const scale = fitScaleFor(box, viewport, 24)
    expect(scale).toBeCloseTo(0.5)
    expect(centeredOffset(box, scale, viewport)).toEqual({ x: 12, y: 262 })
  })

  it('keeps the content point under the anchor fixed while zooming', () => {
    const offset = { x: 10, y: 20 }
    const anchor = { x: 110, y: 220 }
    const next = zoomOffsetAt(offset, 1, 2, anchor)
    // 锚点下的内容坐标 (100, 200) 缩放后仍落在锚点上。
    expect(next.x + 100 * 2).toBe(anchor.x)
    expect(next.y + 200 * 2).toBe(anchor.y)
  })

  it('clamps panning so part of the image stays visible', () => {
    const box = { width: 1000, height: 1000 }
    const viewport = { width: 500, height: 500 }
    expect(clampOffset({ x: 5000, y: -5000 }, box, 1, viewport)).toEqual({ x: 436, y: -936 })
    // 视口内的合法位置保持不变。
    expect(clampOffset({ x: -100, y: -200 }, box, 1, viewport)).toEqual({ x: -100, y: -200 })
  })

  it('builds a rotation transform around the bitmap center', () => {
    expect(imageTransform({ x: 1, y: 2 }, 2, { width: 40, height: 10 }, 1)).toBe(
      'translate(1px, 2px) scale(2) translate(5px, 20px) rotate(90deg) translate(-20px, -5px)',
    )
  })
})
