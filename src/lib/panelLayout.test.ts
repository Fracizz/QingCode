import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBuiltinLocaleLoaded, translateFor, useLocaleStore } from './i18n'
import {
  clampTerminalWidth,
  getDefaultSideTerminalWidth,
  getSideTerminalEditorBandWidth,
  getTerminalMaxHeight,
  getTerminalMaxWidth,
  sidebarResizerHint,
  TERMINAL_MAX_HEIGHT_RATIO,
  TERMINAL_MAX_WIDTH_RATIO,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
  terminalResizerHint,
  terminalWidthResizerHint,
} from './panelLayout'
import {
  ACTIVITY_BAR_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarLayout'

beforeEach(async () => {
  vi.stubGlobal('window', { innerWidth: 1400, innerHeight: 900 })
  useLocaleStore.setState({ language: 'zh-CN' })
  await ensureBuiltinLocaleLoaded('en')
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

describe('getDefaultSideTerminalWidth', () => {
  it('splits the terminal|editor band evenly after activity bar and sidebar', () => {
    const band = getSideTerminalEditorBandWidth({ sidebarVisible: true })
    expect(getDefaultSideTerminalWidth({ sidebarVisible: true })).toBe(Math.round(band / 2))
    expect(getDefaultSideTerminalWidth({ sidebarVisible: true, sidebarWidth: 260 })).toBe(
      clampTerminalWidth(Math.round((window.innerWidth - ACTIVITY_BAR_WIDTH - 260) / 2)),
    )
  })

  it('ignores sidebar width when the sidebar slot is hidden', () => {
    const band = getSideTerminalEditorBandWidth({ sidebarVisible: false })
    expect(getDefaultSideTerminalWidth({ sidebarVisible: false })).toBe(Math.round(band / 2))
  })
})

describe('getTerminalMaxHeight', () => {
  it('allows the terminal to use 90% of the window after reserved chrome', () => {
    expect(TERMINAL_MAX_HEIGHT_RATIO).toBe(0.9)
    expect(getTerminalMaxHeight()).toBe(706)
  })
})

describe('getTerminalMaxWidth', () => {
  it('allows the side terminal to use up to 90% of the window, capped by reserved chrome', () => {
    expect(TERMINAL_MAX_WIDTH_RATIO).toBe(0.9)
    // 1400 - activity(48) - sidebarMin(180) - editorMin(320) = 852 < 1400 * 0.9
    expect(getTerminalMaxWidth()).toBe(852)
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
