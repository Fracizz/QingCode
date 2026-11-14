type ReadOnlyWheelEvent = Pick<
  WheelEvent,
  'deltaY' | 'deltaMode' | 'altKey' | 'DOM_DELTA_LINE' | 'DOM_DELTA_PAGE'
>

export interface ReadOnlyWheelOptions {
  /** 一行的 CSS 像素高度。 */
  cellHeight: number
  /** 当前网格行数，翻页模式（DOM_DELTA_PAGE）按整屏换算。 */
  rows: number
  /** 与 xterm 的 scrollSensitivity / fastScrollSensitivity 一致。 */
  sensitivity?: number
  fastSensitivity?: number
}

/**
 * 终端只读（其他设备正在使用）时，把滚轮换算成本地滚动行数。
 *
 * 开启鼠标上报的程序（Claude Code、Codex、opencode 等）会让 xterm 把滚轮转成发给程序的输入，
 * 只读状态下这些输入被丢弃，电脑端就完全无法上翻历史；因此只读期间由调用方直接滚动本地缓冲区。
 * 像素增量按行高累积，触控板的小增量不会丢；反向时丢弃旧方向的余量。返回负数表示向上。
 */
export function createReadOnlyTerminalWheel() {
  let accumulated = 0
  return (event: ReadOnlyWheelEvent, options: ReadOnlyWheelOptions): number => {
    const { cellHeight, rows } = options
    if (!event.deltaY || !(cellHeight > 0) || !(rows > 0)) return 0
    let lines = event.deltaY
    if (event.deltaMode === event.DOM_DELTA_PAGE) lines *= rows
    else if (event.deltaMode !== event.DOM_DELTA_LINE) lines /= cellHeight
    lines *= event.altKey ? options.fastSensitivity ?? 5 : options.sensitivity ?? 1
    if (accumulated * lines < 0) accumulated = 0
    accumulated += lines
    // `|| 0` 把 Math.trunc 得到的 -0 规范成 0。
    const whole = Math.trunc(accumulated) || 0
    accumulated -= whole
    return whole
  }
}
