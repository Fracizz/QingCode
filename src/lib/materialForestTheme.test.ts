import { describe, expect, it } from 'vitest'
import { MATERIAL_FOREST as forest } from './materialForestTheme'

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map(channel =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('Material Forest palette', () => {
  it('keeps editor and gutter text readable', () => {
    expect(contrast(forest.syntax.variables, forest.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(forest.syntax.comments, forest.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(forest.text, forest.contrast)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the warm focus accent visible on editor surfaces', () => {
    for (const background of [forest.background, forest.contrast, forest.highlight]) {
      expect(contrast(forest.accent, background)).toBeGreaterThanOrEqual(3)
    }
  })
})
