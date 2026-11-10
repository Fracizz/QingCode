import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DARK_THEME, FOREST_THEME, LIGHT_THEME } from './terminalThemes'

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
    ['olive', 'html[data-theme="olive"]', FOREST_THEME],
  ] as const) {
    it(`${name} xterm background matches --color-bg-terminal`, () => {
      expect(theme.background.toLowerCase()).toBe(token(selector, 'bg-terminal'))
      expect(theme.cursorAccent.toLowerCase()).toBe(theme.background.toLowerCase())
    })
  }
})
