/**
 * 多端共享时电脑跟随其他端的网格：对方整屏放不下时按字号缩小（平板横屏的宽网格放进窄窗格），
 * 放得下时保持设置字号、不放大（列数见 followTerminalGrid）。
 * 不用 CSS transform / zoom：WebGL 画布会被拉糊，鼠标选字的坐标也会错位。
 */
import type { Terminal } from '@xterm/xterm'

export interface TerminalCellSize {
  width: number
  height: number
}

export interface TerminalArea {
  width: number
  height: number
}

export interface TerminalGrid {
  cols: number
  rows: number
}

/** 跟随时字号上限：60x25 的手机网格放到大屏上不至于大到失去阅读感。 */
export const FOLLOW_FONT_MAX = 40
/** 跟随时字号下限：再小就看不清，宁可让画面超出窗口。 */
export const FOLLOW_FONT_MIN = 6

/** 与 FitAddon.proposeDimensions 相同的取整规则（最少 2 列 1 行）。 */
export function gridForCell(area: TerminalArea, cell: TerminalCellSize): TerminalGrid | undefined {
  if (!(cell.width > 0 && cell.height > 0) || !(area.width > 0 && area.height > 0)) return undefined
  return {
    cols: Math.max(2, Math.floor(area.width / cell.width)),
    rows: Math.max(1, Math.floor(area.height / cell.height)),
  }
}

/**
 * 跟随其他端网格时电脑 xterm 的行列：行数跟随对方，列数不小于电脑自己的列数。
 * xterm 改列数时总会回流已有内容：若缩到手机的窄列数，期间按窄宽度画出的折行，
 * 在恢复宽列数时会被重新拼接，Claude Code 等只输出一次的历史就错位成每词一格。
 * 列数保持电脑宽度，对方的内容只占左侧，恢复电脑网格时不再改列数。
 */
export function followTerminalGrid(remote: TerminalGrid, natural: TerminalGrid | undefined): TerminalGrid {
  return { cols: Math.max(remote.cols, natural?.cols ?? 0), rows: remote.rows }
}

/**
 * 跟随其他端网格时的字号。`cell` 是 `fontSize` 字号下的字格；`baseFontSize` 是设置里的字号。
 * 字格宽度按设备像素取整、不严格与字号成比例，调用方改字号后应按新字格再算一两次：
 * 已放得下且余量不到 5% 时保持不动，靠这个阈值收敛，不会在相邻两档之间来回跳。
 */
export function followFitFontSize({
  area,
  grid,
  cell,
  fontSize,
  baseFontSize,
  maxFont = FOLLOW_FONT_MAX,
  minFont = FOLLOW_FONT_MIN,
}: {
  area: TerminalArea
  grid: TerminalGrid
  cell: TerminalCellSize
  fontSize: number
  baseFontSize: number
  maxFont?: number
  minFont?: number
}): number {
  const values = [area.width, area.height, grid.cols, grid.rows, cell.width, cell.height, fontSize]
  if (!values.every(value => Number.isFinite(value) && value > 0)) return fontSize
  const ratio = Math.min(area.width / (grid.cols * cell.width), area.height / (grid.rows * cell.height))
  if (ratio >= 1 && ratio < 1.05) return fontSize
  // 留 2% 余量吸收字格取整；放大取整数字号，缩小保留一位小数。
  const target = fontSize * ratio * 0.98
  const font = target >= baseFontSize ? Math.floor(target) : Math.floor(target * 10) / 10
  return Math.max(minFont, Math.min(Math.max(maxFont, baseFontSize), font))
}

/** 当前字号下的字格（CSS 像素）；与 FitAddon 一样读取渲染服务的私有尺寸。 */
export function readTerminalCell(term: Terminal): TerminalCellSize | undefined {
  const core = (term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: TerminalCellSize } } } }
  })._core
  const cell = core?._renderService?.dimensions?.css?.cell
  return cell && cell.width > 0 && cell.height > 0 ? { width: cell.width, height: cell.height } : undefined
}

/** 终端可用的排版区域，扣除方式与 FitAddon.proposeDimensions 相同（父元素尺寸 - 内边距 - 滚动条）。 */
export function readTerminalArea(term: Terminal): TerminalArea | undefined {
  const element = term.element
  const parent = element?.parentElement
  if (!element || !parent) return undefined
  const parentStyle = window.getComputedStyle(parent)
  const style = window.getComputedStyle(element)
  const px = (value: string) => parseInt(value) || 0
  const scrollbar = term.options.scrollback === 0 ? 0 : (term.options.overviewRuler?.width || 14)
  const width = Math.max(0, px(parentStyle.width)) - px(style.paddingLeft) - px(style.paddingRight) - scrollbar
  const height = px(parentStyle.height) - px(style.paddingTop) - px(style.paddingBottom)
  return width > 0 && height > 0 ? { width, height } : undefined
}
