// 默认值按 1920×1080、100% 缩放调校。
export const DEFAULT_FONT_SIZES = {
  chatFontSize: 15,
  composerFontSize: 15,
  editorFontSize: 13,
  terminalFontSize: 14,
  sidebarFontSize: 15,
  projectFontSize: 15,
  sessionFontSize: 14,
} as const

export type FontSizeKey = keyof typeof DEFAULT_FONT_SIZES

export const FONT_SIZES = [10, 11, 12, 12.5, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] as const

/** 默认字号每调整一次加 1；设置文件里旧版本的"旧默认值"会被换成新默认值。 */
export const FONT_SIZES_VERSION = 2

// 版本 1 的默认值。保存任意设置都会把完整 general 落盘，旧默认值因此被固化进文件，不迁移就永远看不到新默认。
const LEGACY_DEFAULT_FONT_SIZES: Record<FontSizeKey, number> = {
  chatFontSize: 14,
  composerFontSize: 14,
  editorFontSize: 12.5,
  terminalFontSize: 13,
  // 侧栏三项在版本 1 之后才加入，迁移按它们最初的默认值处理。
  sidebarFontSize: 14,
  projectFontSize: 14,
  sessionFontSize: 13,
}

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

/**
 * 从已保存的 general 还原完整字号设置。
 * 旧版本文件里等于旧默认值的项视为"没改过"，跟随新默认；用户主动选过的其他值原样保留。
 * 代价是当初特意选了旧默认值的人也会被升级一次，可接受。
 */
export function resolveFontSizes(
  general: Record<string, unknown>,
): Record<FontSizeKey, number> & { fontSizesVersion: number } {
  const stored = sanitizeFontSizes(general)
  if (general.fontSizesVersion !== FONT_SIZES_VERSION) {
    for (const key of Object.keys(stored) as FontSizeKey[]) {
      if (stored[key] === LEGACY_DEFAULT_FONT_SIZES[key]) delete stored[key]
    }
  }
  return { ...DEFAULT_FONT_SIZES, ...stored, fontSizesVersion: FONT_SIZES_VERSION }
}
