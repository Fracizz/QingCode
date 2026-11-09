import { describe, expect, it } from 'vitest'
import {
  INTERFACE_FONT_OPTIONS,
  MAPLE_MONO_FONT,
  expandSystemFontFamilies,
  normalizeFontFamilyLabel,
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

describe('normalizeFontFamilyLabel', () => {
  it('strips compact weight/style suffixes', () => {
    expect(normalizeFontFamilyLabel('Cascadia Code SemiBold (TrueType)')).toBe('Cascadia Code')
    expect(normalizeFontFamilyLabel('Nirmala UI Semilight')).toBe('Nirmala UI')
  })

  it('collapses letter-spaced style names from the Windows registry', () => {
    expect(normalizeFontFamilyLabel('Maple Mono CN R e g u l a r (TrueType)')).toBe('Maple Mono CN')
    expect(normalizeFontFamilyLabel('Maple Mono CN B o l d (TrueType)')).toBe('Maple Mono CN')
    expect(normalizeFontFamilyLabel('Maple Mono CN S e m i B o l d I t a l i c')).toBe('Maple Mono CN')
  })

  it('keeps real family names that end in a single letter', () => {
    expect(normalizeFontFamilyLabel('Iosevka A')).toBe('Iosevka A')
    expect(normalizeFontFamilyLabel('Maple Mono X y')).toBe('Maple Mono X y')
  })

  it('dedupes every Maple Mono face into one family option', () => {
    expect(expandSystemFontFamilies([
      'Maple Mono CN R e g u l a r (TrueType)',
      'Maple Mono CN B o l d (TrueType)',
      'Maple Mono CN I t a l i c (TrueType)',
    ])).toEqual(['Maple Mono CN'])
  })
})

describe('MAPLE_MONO_FONT', () => {
  it('prefers the CJK face but falls back to the plain family and system mono', () => {
    expect(primaryFontFamilyNameFromStack(MAPLE_MONO_FONT)).toBe('Maple Mono CN')
    expect(MAPLE_MONO_FONT).toContain('"Maple Mono"')
    expect(MAPLE_MONO_FONT.endsWith('monospace')).toBe(true)
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
