import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!match) throw new Error(`Theme block not found: ${selector}`)
  return match[1]
}

function themeColor(block: string, token: string): string {
  const match = block.match(new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`Theme color not found: ${token}`)
  return match[1]
}

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

const backgroundTokens = ['bg', 'bg-deep', 'bg-sidebar', 'bg-elevated', 'bg-hover', 'bg-active']

describe('theme contrast', () => {
  for (const [name, selector] of [
    ['dark', '@theme'],
    ['light', 'html[data-theme="light"]'],
    ['forest', 'html[data-theme="forest"]'],
  ] as const) {
    it(`${name} keeps secondary small text readable on application surfaces`, () => {
      const block = themeBlock(selector)
      for (const foreground of ['fg-muted', 'fg-dim', 'tree-fg']) {
        for (const background of backgroundTokens) {
          expect(
            contrast(themeColor(block, foreground), themeColor(block, background)),
            `${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it(`${name} keeps the focus accent visible on application surfaces`, () => {
      const block = themeBlock(selector)
      for (const background of backgroundTokens) {
        expect(
          contrast(themeColor(block, 'accent'), themeColor(block, background)),
          `accent on ${background}`,
        ).toBeGreaterThanOrEqual(3)
      }
    })

    it(`${name} keeps the Qing Rail visible on application surfaces`, () => {
      const block = themeBlock(selector)
      for (const background of backgroundTokens) {
        expect(
          contrast(themeColor(block, 'brand'), themeColor(block, background)),
          `brand on ${background}`,
        ).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
