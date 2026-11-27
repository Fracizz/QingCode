export const DEFAULT_FONT_SIZES = {
  chatFontSize: 14,
  composerFontSize: 14,
  editorFontSize: 12.5,
  terminalFontSize: 13,
  sidebarFontSize: 14,
  projectFontSize: 14,
  sessionFontSize: 13,
} as const

export type FontSizeKey = keyof typeof DEFAULT_FONT_SIZES

export const FONT_SIZES = [10, 11, 12, 12.5, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] as const

export function isFontSize(value: unknown): value is number {
  return FONT_SIZES.some((size) => size === value)
}

export function sanitizeFontSizes(general: Record<string, unknown>): Partial<Record<FontSizeKey, number>> {
  const sizes: Partial<Record<FontSizeKey, number>> = {}
  for (const key of Object.keys(DEFAULT_FONT_SIZES) as FontSizeKey[]) {
    const value = general[key]
    if (isFontSize(value)) sizes[key] = value
  }
  return sizes
}
