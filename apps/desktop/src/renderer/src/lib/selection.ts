type Box = { top: number; left: number; width: number; height: number }

export type SelectionSnapshot = {
  text: string
  itemId?: string
  range: Range
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

/** 选区可能延伸到视口之外，工具条应靠近仍可见的部分。 */
export function visibleSelectionBox(rects: Iterable<Box>, viewport: Box): Box | null {
  for (const rect of rects) {
    const top = Math.max(rect.top, viewport.top)
    const left = Math.max(rect.left, viewport.left)
    const bottom = Math.min(rect.top + rect.height, viewport.top + viewport.height)
    const right = Math.min(rect.left + rect.width, viewport.left + viewport.width)
    if (bottom > top && right > left) {
      return { top: top - viewport.top, left: left - viewport.left, height: bottom - top, width: right - left }
    }
  }
  return null
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
  const first = visibleSelectionBox(range.getClientRects(), {
    top: base.top + root.clientTop,
    left: base.left + root.clientLeft,
    width: root.clientWidth,
    height: root.clientHeight,
  })
  if (!first) return null
  const position = toolbarPosition(first, root.clientWidth)
  position.top += root.scrollTop
  position.left += root.scrollLeft

  const common = range.commonAncestorContainer
  const element = common.nodeType === 1 ? common as Element : common.parentElement
  const itemId = element?.closest<HTMLElement>('[data-chat-item]')?.dataset.chatItem
  return { text, itemId, range: range.cloneRange(), position }
}
