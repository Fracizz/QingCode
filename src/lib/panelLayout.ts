import { translate } from './i18n'
import {
  ACTIVITY_BAR_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarLayout'

export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT_RATIO = 0.9

export const TERMINAL_MIN_WIDTH = 200
export const TERMINAL_MAX_WIDTH_RATIO = 0.9

type TranslateFn = (source: string, values?: Record<string, string | number>) => string

export function getTerminalMaxHeight() {
  const titleBar = 32
  const statusBar = 24
  const chrome = titleBar + statusBar + 48
  return Math.max(
    TERMINAL_MIN_HEIGHT,
    Math.round(window.innerHeight * TERMINAL_MAX_HEIGHT_RATIO - chrome)
  )
}

/**
 * Side terminal|editor band after activity bar + min sidebar.
 * Either side may take up to {@link TERMINAL_MAX_WIDTH_RATIO} (90%).
 */
export function getTerminalEditorBandWidth() {
  return Math.max(0, window.innerWidth - ACTIVITY_BAR_WIDTH - SIDEBAR_MIN_WIDTH)
}

/** Absolute floor so tiny windows stay usable. */
const TERMINAL_WIDTH_HARD_MIN = 120

/** Terminal column max: 90% of the terminal|editor band. */
export function getTerminalMaxWidth() {
  const band = getTerminalEditorBandWidth()
  return Math.max(TERMINAL_WIDTH_HARD_MIN, Math.round(band * TERMINAL_MAX_WIDTH_RATIO))
}

/** Terminal column min: ~10% of the band so the editor side can also reach ~90%. */
export function getTerminalMinWidth() {
  const band = getTerminalEditorBandWidth()
  return Math.max(TERMINAL_WIDTH_HARD_MIN, Math.round(band * (1 - TERMINAL_MAX_WIDTH_RATIO)))
}

export function clampTerminalWidth(width: number): number {
  const max = getTerminalMaxWidth()
  const min = getTerminalMinWidth()
  return Math.min(max, Math.max(min, width))
}

/** Default side-dock width: split the terminal|editor band evenly after chrome. */
export function getSideTerminalEditorBandWidth(options: {
  sidebarVisible: boolean
  sidebarWidth?: number
}): number {
  const sidebar = options.sidebarVisible
    ? (options.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH)
    : 0
  return window.innerWidth - ACTIVITY_BAR_WIDTH - sidebar
}

/** Single terminal | editor equal split (1:1). */
export const SIDE_TERMINAL_DEFAULT_BAND_RATIO = 0.5

/**
 * Dual + editor equal split: terminal band : editor = 2:1
 * so TermA : TermB : Editor ≈ 1:1:1 (with dual panes at 50%).
 */
export const SIDE_DUAL_EDITOR_TERMINAL_BAND_RATIO = 2 / 3

export function getDefaultSideTerminalWidth(options: {
  sidebarVisible: boolean
  sidebarWidth?: number
  /** When true, default to 2/3 of the band for a 1:1:1 dual+editor layout. */
  dualTerminal?: boolean
}): number {
  const band = getSideTerminalEditorBandWidth(options)
  const ratio = options.dualTerminal
    ? SIDE_DUAL_EDITOR_TERMINAL_BAND_RATIO
    : SIDE_TERMINAL_DEFAULT_BAND_RATIO
  return clampTerminalWidth(Math.round(band * ratio))
}

export function terminalResizerHint(height: number, t: TranslateFn = translate) {
  return t('拖动调整终端高度 · {min}–{max}px · 当前 {current}px', {
    min: TERMINAL_MIN_HEIGHT,
    max: getTerminalMaxHeight(),
    current: Math.round(height),
  })
}

export function terminalWidthResizerHint(width: number, t: TranslateFn = translate) {
  return t('拖动调整终端宽度 · {min}–{max}px · 当前 {current}px', {
    min: getTerminalMinWidth(),
    max: getTerminalMaxWidth(),
    current: Math.round(width),
  })
}

export function sidebarResizerHint(width: number, t: TranslateFn = translate) {
  return t('拖动调整侧边栏宽度 · {min}–{max}px · 当前 {current}px', {
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    current: Math.round(width),
  })
}
