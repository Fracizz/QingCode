import { describe, expect, it } from 'vitest'
import {
  INTERFACE_FONT_OPTIONS,
  primaryFontFamilyNameFromStack,
  withCurrentFontOption,
} from './fontSettings'

describe('primaryFontFamilyNameFromStack', () => {
  it('reads quoted family at start of stack', () => {
    expect(primaryFontFamilyNameFromStack('"Microsoft YaHei", sans-serif')).toBe('Microsoft YaHei')
  })

  it('returns null for empty input', () => {
    expect(primaryFontFamilyNameFromStack('   ')).toBeNull()
  })
})

describe('withCurrentFontOption', () => {
  it('uses family name instead of generic custom label', () => {
    // Must not match any INTERFACE_FONT_OPTIONS preset value.
    const value = '"Noto Sans SC", "Segoe UI", sans-serif'
    const next = withCurrentFontOption(INTERFACE_FONT_OPTIONS, value)
    expect(next[0]).toEqual({ label: 'Noto Sans SC', value })
  })

  it('does not duplicate when value is already a preset', () => {
    const preset = INTERFACE_FONT_OPTIONS[0]
    expect(withCurrentFontOption(INTERFACE_FONT_OPTIONS, preset.value)).toBe(INTERFACE_FONT_OPTIONS)
  })
})
