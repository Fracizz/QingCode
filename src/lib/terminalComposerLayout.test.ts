import { describe, expect, it } from 'vitest'
import {
  COMPOSER_MIN_HEIGHT,
  clampComposerRect,
  defaultComposerRect,
  parseComposerRect,
} from './terminalComposerLayout'

describe('terminal composer layout', () => {
  it('defaults to a tall centered panel', () => {
    const rect = defaultComposerRect({ width: 1600, height: 1000 })
    expect(rect).toEqual({ x: 380, y: 150, width: 840, height: 700 })
    const small = defaultComposerRect({ width: 900, height: 700 })
    expect(small.height).toBe(490)
    expect(small.x).toBe(Math.round((900 - small.width) / 2))
  })

  it('keeps the title bar reachable when dragged off screen', () => {
    const viewport = { width: 1200, height: 800 }
    const base = { x: 0, y: 0, width: 800, height: 600 }
    expect(clampComposerRect({ ...base, x: -2000, y: -50 }, viewport)).toMatchObject({ x: 160 - 800, y: 0 })
    expect(clampComposerRect({ ...base, x: 5000, y: 5000 }, viewport)).toMatchObject({ x: 1200 - 160, y: 800 - 48 })
    // 允许部分移出视口，方便露出终端
    expect(clampComposerRect({ ...base, x: 900, y: 500 }, viewport)).toMatchObject({ x: 900, y: 500 })
  })

  it('limits size to the viewport and minimums', () => {
    const rect = clampComposerRect({ x: 0, y: 0, width: 3000, height: 10 }, { width: 1000, height: 700 })
    expect(rect.width).toBe(1000 - 16)
    expect(rect.height).toBe(COMPOSER_MIN_HEIGHT)
  })

  it('rejects malformed stored rects', () => {
    expect(parseComposerRect(null)).toBeNull()
    expect(parseComposerRect('{')).toBeNull()
    expect(parseComposerRect('{"x":1,"y":2,"width":"3","height":4}')).toBeNull()
    expect(parseComposerRect('{"x":1,"y":2,"width":3,"height":4}')).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
})
