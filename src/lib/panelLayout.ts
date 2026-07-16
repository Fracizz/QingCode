import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarLayout'

export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT_RATIO = 0.8

export function getTerminalMaxHeight() {
  return Math.round(window.innerHeight * TERMINAL_MAX_HEIGHT_RATIO)
}

export function terminalResizerHint(height: number) {
  return `拖动调整终端高度 · ${TERMINAL_MIN_HEIGHT}–${getTerminalMaxHeight()}px · 当前 ${Math.round(height)}px`
}

export function sidebarResizerHint(width: number) {
  return `拖动调整侧边栏宽度 · ${SIDEBAR_MIN_WIDTH}–${SIDEBAR_MAX_WIDTH}px · 当前 ${Math.round(width)}px`
}
