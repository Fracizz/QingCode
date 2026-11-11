import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DARK_THEME, FOREST_THEME, INK_THEME, LIGHT_THEME } from './terminalThemes'

const css = readFileSync(new URL('../../styles/theme.css', import.meta.url), 'utf8')

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}[^\\{]*?\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
}

/** 解析主题块内的颜色 token（含 var() 引用），块内缺省时回落到深色基线。 */
function token(selector: string, name: string): string {
  for (const source of [block(selector), block('@theme')]) {
    const match = source.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6}|var\\(--color-([\\w-]+)\\))`))
    if (match) return match[2] ? token(selector, match[2]) : match[1].toLowerCase()
  }
  throw new Error(`token not found: ${name}`)
}

describe('terminal themes', () => {
  // xterm 画布与外层内边距（--color-bg-terminal）必须同色，否则终端四周露出一圈色差。
  for (const [name, selector, theme] of [
    ['dark', '@theme', DARK_THEME],
    ['light', 'html[data-theme="light"]', LIGHT_THEME],
    ['ink', 'html[data-theme="ink"]', INK_THEME],
    ['olive', 'html[data-theme="olive"]', FOREST_THEME],
  ] as const) {
    it(`${name} xterm background matches --color-bg-terminal`, () => {
      expect(theme.background.toLowerCase()).toBe(token(selector, 'bg-terminal'))
      expect(theme.cursorAccent.toLowerCase()).toBe(theme.background.toLowerCase())
    })
  }

  // 深色/石墨灰终端以柔和为目标：不用纯白，正文对比度控制在可读（≥ 7）但不过亮（≤ 11）。
  it('terminal palettes avoid pure white/black and keep body text soft', () => {
    const luminance = (hex: string) => {
      const linear = [1, 3, 5]
        .map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const theme of [DARK_THEME, INK_THEME]) {
      expect(theme.brightWhite.toLowerCase()).not.toBe('#ffffff')
      const body = contrast(theme.foreground, theme.background)
      expect(body).toBeGreaterThanOrEqual(7)
      expect(body).toBeLessThanOrEqual(11)
    }
    // 浅色：不用纯黑字，正文仍保持高可读；ANSI 色在白底上 ≥ 4.5。
    expect(LIGHT_THEME.foreground.toLowerCase()).not.toBe('#000000')
    expect(LIGHT_THEME.brightWhite.toLowerCase()).not.toBe('#000000')
    expect(contrast(LIGHT_THEME.foreground, LIGHT_THEME.background)).toBeLessThanOrEqual(15)
    for (const key of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      expect(contrast(LIGHT_THEME[key], LIGHT_THEME.background), key).toBeGreaterThanOrEqual(4.5)
    }
  })
})
