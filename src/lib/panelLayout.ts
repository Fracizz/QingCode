import {
  ACTIVITY_BAR_WIDTH,
  SIDEBAR_EDITOR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarLayout'

export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT_RATIO = 0.8

export const TERMINAL_MIN_WIDTH = 200
export const TERMINAL_DEFAULT_WIDTH = 400
export const TERMINAL_MAX_WIDTH_RATIO = 0.5

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

export function terminalResizerHint(height: number) {
  return `拖动调整终端高度 · ${TERMINAL_MIN_HEIGHT}–${getTerminalMaxHeight()}px · 当前 ${Math.round(height)}px`
}

export function terminalWidthResizerHint(width: number) {
  return `拖动调整终端宽度 · ${TERMINAL_MIN_WIDTH}–${getTerminalMaxWidth()}px · 当前 ${Math.round(width)}px`
}

export function sidebarResizerHint(width: number) {
  return `拖动调整侧边栏宽度 · ${SIDEBAR_MIN_WIDTH}–${SIDEBAR_MAX_WIDTH}px · 当前 ${Math.round(width)}px`
}
