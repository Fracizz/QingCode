import { describe, expect, it } from 'vitest'
import { interfaceMetrics, interfacePixelSize, normalizeInterfaceFontSize } from './interfaceMetrics'

describe('interfaceMetrics', () => {
  it('preserves the compact default layout without a zoom factor', () => {
    expect(interfaceMetrics(13)).toMatchObject({ fontSize: 13, smallFontSize: 12, lineHeight: 20,
      controlHeight: 26, rowHeight: 26, chipHeight: 24, titleHeight: 32, tabHeight: 32 })
  })

  it.each([12, 13, 14, 16, 20, 32])('uses integer CSS pixels at font size %s', size => {
    const metrics = interfaceMetrics(size)
    expect(Object.values(metrics).every(Number.isInteger)).toBe(true)
    expect(metrics.rowHeight).toBeGreaterThanOrEqual(metrics.lineHeight + 6)
    expect(metrics.chipHeight).toBeGreaterThanOrEqual(metrics.lineHeight + 2)
    expect(interfacePixelSize(28, size)).toBe(metrics.scmRowHeight)
  })

  it('bounds corrupt or fractional stored sizes', () => {
    expect(normalizeInterfaceFontSize(NaN)).toBe(13)
    expect(normalizeInterfaceFontSize(Infinity)).toBe(13)
    expect(normalizeInterfaceFontSize(-20)).toBe(10)
    expect(normalizeInterfaceFontSize(200)).toBe(32)
    expect(normalizeInterfaceFontSize(15.6)).toBe(16)
  })
})
