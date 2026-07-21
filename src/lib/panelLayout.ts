import { translate } from './i18n'
import {
  ACTIVITY_BAR_WIDTH,
  SIDEBAR_EDITOR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarLayout'

export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT_RATIO = 0.9

export const TERMINAL_MIN_WIDTH = 200
export const TERMINAL_DEFAULT_WIDTH = 400
export const TERMINAL_MAX_WIDTH_RATIO = 0.5

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

/** Leave room for activity bar, a collapsed-or-min sidebar, and the editor. */
export function getTerminalMaxWidth() {
  const reserved = ACTIVITY_BAR_WIDTH + SIDEBAR_MIN_WIDTH + SIDEBAR_EDITOR_MIN_WIDTH
  const maxByWindow = window.innerWidth - reserved
  const maxByRatio = Math.round(window.innerWidth * TERMINAL_MAX_WIDTH_RATIO)
  const max = Math.min(maxByRatio, maxByWindow)
  return Math.max(TERMINAL_MIN_WIDTH, max)
}

export function clampTerminalWidth(width: number): number {
  const max = getTerminalMaxWidth()
  return Math.min(max, Math.max(TERMINAL_MIN_WIDTH, width))
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
    min: TERMINAL_MIN_WIDTH,
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
