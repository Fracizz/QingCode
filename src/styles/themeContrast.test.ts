import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}[^\\{]*?\\{([\\s\\S]*?)\\n\\}`))
  if (!match) throw new Error(`Theme block not found: ${selector}`)
  return match[1]
}

function themeColor(block: string, token: string): string {
  const match = block.match(
    new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6}|var\\(--color-([\\w-]+)\\))`),
  )
  if (!match) throw new Error(`Theme color not found: ${token}`)
  return match[2] ? themeColor(block, match[2]) : match[1]
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
    ['ink', 'html[data-theme="ink"]'],
    ['forest', 'html[data-theme="forest"]'],
    ['olive', 'html[data-theme="olive"]'],
  ] as const) {
    it(`${name} keeps button labels readable`, () => {
      const block = themeBlock(selector)
      for (const role of ['action', 'destructive']) {
        expect(contrast(themeColor(block, `on-${role}`), themeColor(block, role)))
          .toBeGreaterThanOrEqual(4.5)
      }
    })
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

    it(`${name} keeps the terminal list text tiers readable and ordered`, () => {
      const block = themeBlock(selector)
      const tiers = ['term-list-active', 'term-list-fg', 'term-list-project', 'term-list-meta']
      // 行可能处于悬停或选中状态，每一级都要在这三种底色上可读。
      for (const foreground of tiers) {
        for (const background of ['bg-sidebar', 'bg-hover', 'bg-active']) {
          expect(
            contrast(themeColor(block, foreground), themeColor(block, background)),
            `${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
      // 层级从强到弱：与侧栏底色的对比度依次不升。
      const sidebar = themeColor(block, 'bg-sidebar')
      const ratios = tiers.map(token => contrast(themeColor(block, token), sidebar))
      for (let index = 1; index < ratios.length; index += 1) {
        expect(ratios[index], `${tiers[index]} should not outrank ${tiers[index - 1]}`)
          .toBeLessThanOrEqual(ratios[index - 1])
      }
    })

    it(`${name} keeps dialog labels and helper text readable across dialog surfaces`, () => {
      const block = themeBlock(selector)
      for (const foreground of ['fg', 'dialog-label', 'fg-muted', 'fg-dim']) {
        for (const background of [
          'dialog', 'dialog-chrome', 'dialog-sidebar', 'dialog-input', 'dialog-active',
        ]) {
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
