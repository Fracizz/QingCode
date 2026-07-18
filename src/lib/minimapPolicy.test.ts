import { describe, expect, it } from 'vitest'
import {
  MINIMAP_FULL_MAX_BYTES,
  MINIMAP_HIDE_BYTES,
  clampMinimapWidth,
  resolveMinimapByteSize,
  resolveMinimapMode,
} from './minimapPolicy'
import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'

describe('minimapPolicy', () => {
  it('aligns hide threshold with degraded edit band', () => {
    expect(MINIMAP_HIDE_BYTES).toBe(EDIT_DEGRADED_BYTES)
    expect(MINIMAP_HIDE_BYTES).toBe(5 * 1024 * 1024)
  })

  it('prefers fileSize over doc.length', () => {
    expect(resolveMinimapByteSize(2048, 99)).toBe(2048)
    expect(resolveMinimapByteSize(undefined, 99)).toBe(99)
    expect(resolveMinimapByteSize(null, 50)).toBe(50)
    expect(resolveMinimapByteSize(Number.NaN, 50)).toBe(50)
  })

  it('picks render mode by byte size', () => {
    expect(resolveMinimapMode(0)).toBe('full')
    expect(resolveMinimapMode(MINIMAP_FULL_MAX_BYTES)).toBe('full')
    expect(resolveMinimapMode(MINIMAP_FULL_MAX_BYTES + 1)).toBe('density')
    expect(resolveMinimapMode(MINIMAP_HIDE_BYTES)).toBe('density')
    expect(resolveMinimapMode(MINIMAP_HIDE_BYTES + 1)).toBe('hidden')
  })

  it('clamps width into the supported range', () => {
    expect(clampMinimapWidth(96)).toBe(96)
    expect(clampMinimapWidth(10)).toBe(64)
    expect(clampMinimapWidth(999)).toBe(180)
    expect(clampMinimapWidth(Number.NaN)).toBe(96)
  })
})
