import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBuiltinLocaleLoaded, translateFor, useLocaleStore } from './i18n'
import {
  clampTerminalWidth,
  getDefaultSideTerminalWidth,
  getSideTerminalEditorBandWidth,
  getTerminalMaxHeight,
  getTerminalMaxWidth,
  getTerminalMinWidth,
  sidebarResizerHint,
  SIDE_DUAL_EDITOR_TERMINAL_BAND_RATIO,
  SIDE_TERMINAL_DEFAULT_BAND_RATIO,
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
  it('clamps to ~10%–90% of the terminal|editor band', () => {
    expect(clampTerminalWidth(50)).toBe(getTerminalMinWidth())
    expect(clampTerminalWidth(400)).toBe(400)
    expect(clampTerminalWidth(2000)).toBe(getTerminalMaxWidth())
  })
})

describe('getDefaultSideTerminalWidth', () => {
  it('defaults single terminal|editor to 1:1', () => {
    expect(SIDE_TERMINAL_DEFAULT_BAND_RATIO).toBe(0.5)
    const band = getSideTerminalEditorBandWidth({ sidebarVisible: true })
    expect(getDefaultSideTerminalWidth({ sidebarVisible: true })).toBe(
      clampTerminalWidth(Math.round(band * SIDE_TERMINAL_DEFAULT_BAND_RATIO)),
    )
    expect(getDefaultSideTerminalWidth({ sidebarVisible: true, sidebarWidth: 260 })).toBe(
      clampTerminalWidth(
        Math.round(
          (window.innerWidth - ACTIVITY_BAR_WIDTH - 260) * SIDE_TERMINAL_DEFAULT_BAND_RATIO,
        ),
      ),
    )
  })

  it('defaults dual+editor terminal band to 2/3 for A|B|E ≈ 1:1:1', () => {
    expect(SIDE_DUAL_EDITOR_TERMINAL_BAND_RATIO).toBe(2 / 3)
    const band = getSideTerminalEditorBandWidth({ sidebarVisible: true })
    expect(getDefaultSideTerminalWidth({ sidebarVisible: true, dualTerminal: true })).toBe(
      clampTerminalWidth(Math.round(band * SIDE_DUAL_EDITOR_TERMINAL_BAND_RATIO)),
    )
  })

  it('ignores sidebar width when the sidebar slot is hidden', () => {
    const band = getSideTerminalEditorBandWidth({ sidebarVisible: false })
    expect(getDefaultSideTerminalWidth({ sidebarVisible: false })).toBe(
      clampTerminalWidth(Math.round(band * SIDE_TERMINAL_DEFAULT_BAND_RATIO)),
    )
  })
})

describe('getTerminalMaxHeight', () => {
  it('allows the terminal to use 90% of the window after reserved chrome', () => {
    expect(TERMINAL_MAX_HEIGHT_RATIO).toBe(0.9)
    expect(getTerminalMaxHeight()).toBe(706)
  })
})

describe('getTerminalMaxWidth', () => {
  it('allows either terminal|editor side up to 90% of the band', () => {
    expect(TERMINAL_MAX_WIDTH_RATIO).toBe(0.9)
    // band = 1400 - activity(48) - sidebarMin(180) = 1172
    expect(getTerminalMaxWidth()).toBe(Math.round(1172 * 0.9))
    // 10% band is 117, floored by hard min 120
    expect(getTerminalMinWidth()).toBe(120)
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
      `Drag to resize terminal width · ${getTerminalMinWidth()}–${getTerminalMaxWidth()}px · current 400px`
    )
    expect(sidebarResizerHint(260, tEn)).toBe(
      `Drag to resize sidebar width · ${SIDEBAR_MIN_WIDTH}–${SIDEBAR_MAX_WIDTH}px · current 260px`
    )
  })
})
