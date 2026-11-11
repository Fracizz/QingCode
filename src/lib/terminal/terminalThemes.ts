// xterm 终端配色：深色 / 浅色 / 石墨灰 / 护眼绿主题，按当前解析后的应用主题选择。从 Terminal.tsx 拆出。
import { MATERIAL_FOREST as M } from '../materialForestTheme'
import { getResolvedTheme } from '../themeSettings'

// 深色与石墨灰共用的柔和终端配色：正文约 10:1、不用纯白，ANSI 色饱和度约 30–50%（雾面感），选区为中性灰；
// bright 系列比普通色亮一档以便区分。背景须与 theme.css 的 --color-bg-terminal 一致（两主题均为 #181818）。
export const DARK_THEME = {
  background: '#181818',
  foreground: '#c4c4c4',
  cursor: '#aeafad',
  cursorAccent: '#181818',
  selectionBackground: '#3a3d42',
  scrollbarSliderBackground: 'rgba(196, 196, 196, 0.24)',
  scrollbarSliderHoverBackground: 'rgba(196, 196, 196, 0.4)',
  scrollbarSliderActiveBackground: 'rgba(196, 196, 196, 0.55)',
  black: '#000000',
  red: '#d9958a',
  green: '#9cc796',
  yellow: '#d6bf92',
  blue: '#8fb2dc',
  magenta: '#bb9ccf',
  cyan: '#8cbfc4',
  white: '#c4c4c4',
  brightBlack: '#838383',
  brightRed: '#e0aaa1',
  brightGreen: '#b0d6aa',
  brightYellow: '#e0cea6',
  brightBlue: '#a8c2e0',
  brightMagenta: '#cbb3dc',
  brightCyan: '#a3d0d4',
  brightWhite: '#dcdcdc',
}

// 浅色：底色须与编辑器一致保持纯白，但正文与“最深色”不用纯黑；ANSI 色饱和度约 40–65%，白底上均 ≥ 5:1。
export const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#2b2b2b',
  cursor: '#2b2b2b',
  cursorAccent: '#ffffff',
  selectionBackground: '#c9d9ea',
  scrollbarSliderBackground: 'rgba(43, 43, 43, 0.22)',
  scrollbarSliderHoverBackground: 'rgba(43, 43, 43, 0.38)',
  scrollbarSliderActiveBackground: 'rgba(43, 43, 43, 0.5)',
  black: '#262626',
  red: '#b5463e',
  green: '#2f7a34',
  yellow: '#87661c',
  blue: '#2a62a3',
  magenta: '#8c3b8c',
  cyan: '#1f7480',
  white: '#2b2b2b',
  brightBlack: '#5a5a5a',
  brightRed: '#9a3832',
  brightGreen: '#26652b',
  brightYellow: '#6d5216',
  brightBlue: '#204f86',
  brightMagenta: '#733177',
  brightCyan: '#195e68',
  brightWhite: '#262626',
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

// 石墨灰与深色终端底色同为 #181818，直接共用同一套柔和配色。
export const INK_THEME = { ...DARK_THEME }

export function terminalTheme() {
  const resolved = getResolvedTheme()
  if (resolved === 'olive' || (resolved as string) === 'forest') return FOREST_THEME
  if (resolved === 'ink') return INK_THEME
  if (resolved === 'dark') return DARK_THEME
  return LIGHT_THEME
}
