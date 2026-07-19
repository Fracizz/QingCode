import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateFor, useLocaleStore } from './i18n'
import {
  clampTerminalWidth,
  getTerminalMaxHeight,
  getTerminalMaxWidth,
  sidebarResizerHint,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
  terminalResizerHint,
  terminalWidthResizerHint,
} from './panelLayout'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebarLayout'

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1400, innerHeight: 900 })
  useLocaleStore.setState({ language: 'zh-CN' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampTerminalWidth', () => {
  it('clamps to min and max for a typical window', () => {
    expect(clampTerminalWidth(50)).toBe(TERMINAL_MIN_WIDTH)
    expect(clampTerminalWidth(400)).toBe(400)
    expect(clampTerminalWidth(2000)).toBe(getTerminalMaxWidth())
  })
})

describe('resizer hints', () => {
  it('localizes terminal / sidebar drag tooltips', () => {
    const tEn = (source: string, values?: Record<string, string | number>) =>
      translateFor('en', source, values)

    expect(terminalResizerHint(260)).toBe(
      `拖动调整终端高度 · ${TERMINAL_MIN_HEIGHT}–${getTerminalMaxHeight()}px · 当前 260px`
    )
    expect(terminalWidthResizerHint(400, tEn)).toBe(
      `Drag to resize terminal width · ${TERMINAL_MIN_WIDTH}–${getTerminalMaxWidth()}px · current 400px`
    )
    expect(sidebarResizerHint(260, tEn)).toBe(
      `Drag to resize sidebar width · ${SIDEBAR_MIN_WIDTH}–${SIDEBAR_MAX_WIDTH}px · current 260px`
    )
  })
})
