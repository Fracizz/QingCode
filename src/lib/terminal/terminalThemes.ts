// xterm 终端配色：深色 / 浅色 / 烟墨 / 护眼绿主题，按当前解析后的应用主题选择。从 Terminal.tsx 拆出。
import { MATERIAL_FOREST as M } from '../materialForestTheme'
import { getResolvedTheme } from '../themeSettings'

// 背景须与 theme.css 深色的 --color-bg-terminal 一致，否则终端四周内边距会露出一圈色差。
export const DARK_THEME = {
  background: '#181818',
  foreground: '#d4d4d4',
  cursor: '#aeafad',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  scrollbarSliderBackground: 'rgba(212, 212, 212, 0.28)',
  scrollbarSliderHoverBackground: 'rgba(212, 212, 212, 0.45)',
  scrollbarSliderActiveBackground: 'rgba(212, 212, 212, 0.6)',
  black: '#000000',
  red: '#f48771',
  green: '#89d185',
  yellow: '#e2c08d',
  blue: '#75aaf0',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d4d4d4',
  brightBlack: '#6b6b6b',
  brightRed: '#f48771',
  brightGreen: '#89d185',
  brightYellow: '#e2c08d',
  brightBlue: '#75aaf0',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

export const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#b9d6f5',
  scrollbarSliderBackground: 'rgba(31, 31, 31, 0.25)',
  scrollbarSliderHoverBackground: 'rgba(31, 31, 31, 0.42)',
  scrollbarSliderActiveBackground: 'rgba(31, 31, 31, 0.55)',
  black: '#000000',
  red: '#c43b32',
  green: '#107c10',
  yellow: '#9a6a00',
  blue: '#005fb8',
  magenta: '#9b1b9b',
  cyan: '#0b7a85',
  white: '#1a1a1a',
  brightBlack: '#5a5a5a',
  brightRed: '#a3261e',
  brightGreen: '#0b6a0b',
  brightYellow: '#7a5400',
  brightBlue: '#004488',
  brightMagenta: '#7a1488',
  brightCyan: '#055a63',
  brightWhite: '#000000',
}

const FOREST_SCROLLBAR = {
  idle: `${M.foreground}47`,
  hover: `${M.foreground}73`,
  active: `${M.foreground}99`,
}

// 护眼绿终端底色跟随 theme.css 的内容区 --color-bg，避免画布与内边距的色差；ANSI 颜色取同一套低饱和色板，
// bright 系列单独提亮一档。
const OLIVE_CONTENT_BG = '#1c241f'

export const FOREST_THEME = {
  background: OLIVE_CONTENT_BG,
  foreground: M.foreground,
  cursor: M.accent,
  cursorAccent: OLIVE_CONTENT_BG,
  selectionBackground: M.selectionBg,
  scrollbarSliderBackground: FOREST_SCROLLBAR.idle,
  scrollbarSliderHoverBackground: FOREST_SCROLLBAR.hover,
  scrollbarSliderActiveBackground: FOREST_SCROLLBAR.active,
  black: M.contrast,
  red: M.syntax.red,
  green: M.syntax.green,
  yellow: M.syntax.yellow,
  blue: M.syntax.blue,
  magenta: M.syntax.purple,
  cyan: M.syntax.cyan,
  white: M.syntax.white,
  brightBlack: M.bright.black,
  brightRed: M.bright.red,
  brightGreen: M.bright.green,
  brightYellow: M.bright.yellow,
  brightBlue: M.bright.blue,
  brightMagenta: M.bright.magenta,
  brightCyan: M.bright.cyan,
  brightWhite: M.bright.white,
}

// 烟墨终端沿用深色 ANSI 配色，仅底色跟随 theme.css 烟墨的内容区 --color-bg。
const INK_CONTENT_BG = '#161616'

export const INK_THEME = {
  ...DARK_THEME,
  background: INK_CONTENT_BG,
  cursorAccent: INK_CONTENT_BG,
}

export function terminalTheme() {
  const resolved = getResolvedTheme()
  if (resolved === 'olive' || (resolved as string) === 'forest') return FOREST_THEME
  if (resolved === 'ink') return INK_THEME
  if (resolved === 'dark') return DARK_THEME
  return LIGHT_THEME
}
