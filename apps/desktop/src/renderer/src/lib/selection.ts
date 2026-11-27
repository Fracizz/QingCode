export type RectLike = {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export type Box = { top: number; left: number; width: number; height: number }

export type SelectionSnapshot = {
  text: string
  boxes: Box[]
  position: ToolbarPosition
}

/** above=true 时 top 是工具条的下沿（渲染时 translateY(-100%)），工具条变高也不会压住选区。 */
export type ToolbarPosition = { top: number; left: number; above: boolean }

export const MAX_SELECTION_LENGTH = 4000
export const TOOLBAR_WIDTH = 268
export const TOOLBAR_HEIGHT = 34

export function normalizeSelectionText(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (text.length <= MAX_SELECTION_LENGTH) return text
  return `${text.slice(0, MAX_SELECTION_LENGTH)}…`
}

/** 视口坐标转成滚动内容坐标，浮层随消息一起滚动。 */
export function relativeBoxes(
  rects: readonly RectLike[],
  base: RectLike,
  scrollTop: number,
  scrollLeft: number,
): Box[] {
  return rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      top: rect.top - base.top + scrollTop,
      left: rect.left - base.left + scrollLeft,
      width: rect.width,
      height: rect.height,
    }))
}

/** 浮层默认在选区上方，空间不足时落到下方，水平方向不超出容器。 */
export function toolbarPosition(
  box: Box,
  viewWidth: number,
  width = TOOLBAR_WIDTH,
  height = TOOLBAR_HEIGHT,
): ToolbarPosition {
  const margin = 8
  const gap = 8
  const maxLeft = Math.max(margin, viewWidth - width - margin)
  const left = Math.round(
    Math.min(Math.max(margin, box.left + box.width / 2 - width / 2), maxLeft),
  )
  if (box.top - height - gap >= margin) return { top: Math.round(box.top - gap), left, above: true }
  return { top: Math.round(box.top + box.height + gap), left, above: false }
}

export function clearDomSelection(): void {
  if (typeof window === 'undefined') return
  window.getSelection()?.removeAllRanges()
}

/** DOM 部分单独收口：纯逻辑（文本、坐标、浮层位置）保持可测。 */
export function captureSelection(root: HTMLElement): SelectionSnapshot | null {
  if (typeof window === 'undefined') return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  if (!selection.anchorNode || !root.contains(selection.anchorNode)) return null
  if (!selection.focusNode || !root.contains(selection.focusNode)) return null
  const range = selection.getRangeAt(0)
  const text = normalizeSelectionText(selection.toString())
  if (!text) return null

  const base = root.getBoundingClientRect()
  const rects = Array.from(range.getClientRects())
  let boxes = relativeBoxes(rects, base, root.scrollTop, root.scrollLeft)
  if (boxes.length === 0) {
    boxes = relativeBoxes(
      [range.getBoundingClientRect()],
      base,
      root.scrollTop,
      root.scrollLeft,
    )
  }
  const first = boxes[0]
  if (!first) return null
  return { text, boxes, position: toolbarPosition(first, root.clientWidth) }
}
