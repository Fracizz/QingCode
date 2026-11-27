/** 长按拖动排序的纯逻辑：与 DOM/触摸事件分离，便于单测。 */

export const LONG_PRESS_MS = 450
/** 长按判定前手指移动超过这个距离，视为滚动而不是拖动。 */
export const LONG_PRESS_SLOP = 8

export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

/**
 * 根据被拖项的当前中心位置算出落点序号。
 * slots 为拖动开始时各项的 [top, height]（按顺序）；被拖项的前沿越过相邻项中线即交换，
 * 不必等整行拖过去，手感更跟手。
 */
export function dropIndex(slots: readonly (readonly [number, number])[], from: number, offset: number): number {
  const dragged = slots[from]
  if (!dragged) return from
  const top = dragged[0] + offset
  const bottom = top + dragged[1]
  let index = from
  for (let i = from + 1; i < slots.length; i++) {
    const [slotTop, height] = slots[i]!
    if (bottom > slotTop + height / 2) index = i
    else break
  }
  if (index !== from) return index
  for (let i = from - 1; i >= 0; i--) {
    const [slotTop, height] = slots[i]!
    if (top < slotTop + height / 2) index = i
    else break
  }
  return index
}

/** 拖动过程中其余各项需要让位的位移（被拖项自身由手指位移决定）。 */
export function shiftFor(index: number, from: number, to: number, draggedHeight: number): number {
  if (from < to && index > from && index <= to) return -draggedHeight
  if (from > to && index >= to && index < from) return draggedHeight
  return 0
}
