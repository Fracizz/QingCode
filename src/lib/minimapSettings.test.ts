import { describe, expect, it } from 'vitest'
import { parseMinimapEnabled, readMinimapEnabled } from './minimapSettings'

describe('minimapSettings', () => {
  it('defaults missing key to enabled', () => {
    expect(parseMinimapEnabled(undefined)).toBe(true)
    expect(parseMinimapEnabled(null)).toBe(true)
    expect(readMinimapEnabled({})).toBe(true)
  })

  it('reads boolean values', () => {
    expect(parseMinimapEnabled(true)).toBe(true)
    expect(parseMinimapEnabled(false)).toBe(false)
    expect(readMinimapEnabled({ 'editor.minimap.enabled': false })).toBe(false)
  })
})
