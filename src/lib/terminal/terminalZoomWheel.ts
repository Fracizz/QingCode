/** 约半个鼠标滚轮刻度；鼠标每格触发一步，触控板捏合的小增量累积后才触发。 */
const STEP_THRESHOLD_PX = 50
const LINE_HEIGHT_PX = 20

type ZoomWheelEvent = Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'DOM_DELTA_LINE' | 'DOM_DELTA_PAGE'>

/** 把滚轮事件换算成字号步进：向上放大（+1），向下缩小（-1），未到阈值为 0。 */
export function createTerminalZoomWheel() {
  let accumulated = 0
  return (event: ZoomWheelEvent): -1 | 0 | 1 => {
    let delta = event.deltaY
    if (event.deltaMode === event.DOM_DELTA_LINE) delta *= LINE_HEIGHT_PX
    else if (event.deltaMode === event.DOM_DELTA_PAGE) delta *= STEP_THRESHOLD_PX
    // 反向时丢弃旧方向的余量，转向立刻生效。
    if (accumulated * delta < 0) accumulated = 0
    accumulated += delta
    if (Math.abs(accumulated) < STEP_THRESHOLD_PX) return 0
    const step = accumulated < 0 ? 1 : -1
    accumulated = 0
    return step
  }
}
