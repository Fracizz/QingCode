type Box = { top: number; left: number; width: number; height: number }

export type SelectionSnapshot = {
  text: string
  itemId?: string
  range: Range
  rangeText: string
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

function selectionRange(root: HTMLElement): Range | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  return root.contains(range.startContainer) && root.contains(range.endContainer) ? range : null
}

export function clearDomSelection(root: HTMLElement): void {
  if (selectionRange(root)) root.ownerDocument.getSelection()?.removeAllRanges()
}

function rangeElement(range: Range): Element | null {
  const common = range.commonAncestorContainer
  return common.nodeType === 1 ? common as Element : common.parentElement
}

export function captureSelection(root: HTMLElement): SelectionSnapshot | null {
  const range = selectionRange(root)
  if (!range) return null
  const text = normalizeSelectionText(root.ownerDocument.getSelection()?.toString() ?? '')
  if (!text) return null
  const itemId = rangeElement(range)?.closest<HTMLElement>('[data-chat-item]')?.dataset.chatItem
  return { text, itemId, range: range.cloneRange(), rangeText: range.toString() }
}

function clientBox(element: Element): Box {
  const rect = element.getBoundingClientRect()
  return {
    top: rect.top + element.clientTop,
    left: rect.left + element.clientLeft,
    width: element.clientWidth,
    height: element.clientHeight,
  }
}

export function selectionPosition(root: HTMLElement, snapshot: SelectionSnapshot, commenting: boolean): ToolbarPosition | null {
  const { range, rangeText } = snapshot
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)
    || range.toString() !== rangeText) return null
  if (!commenting) {
    const current = selectionRange(root)
    if (!current || current.startContainer !== range.startContainer || current.endContainer !== range.endContainer
      || current.startOffset !== range.startOffset || current.endOffset !== range.endOffset) return null
  }

  const base = clientBox(root)
  let viewport = base
  // 命令输出和代码块也有自己的滚动区，选区被裁掉时工具条应一起消失。
  for (let element = rangeElement(range); element && element !== root; element = element.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(element)
    if (overflowX === 'visible' && overflowY === 'visible') continue
    const clip = clientBox(element)
    const top = overflowY === 'visible' ? viewport.top : Math.max(viewport.top, clip.top)
    const left = overflowX === 'visible' ? viewport.left : Math.max(viewport.left, clip.left)
    const right = overflowX === 'visible' ? viewport.left + viewport.width : Math.min(viewport.left + viewport.width, clip.left + clip.width)
    const bottom = overflowY === 'visible' ? viewport.top + viewport.height : Math.min(viewport.top + viewport.height, clip.top + clip.height)
    viewport = { top, left, width: right - left, height: bottom - top }
  }
  const first = visibleSelectionBox(range.getClientRects(), viewport)
  if (!first) return null
  const position = toolbarPosition({
    ...first, top: first.top + viewport.top - base.top, left: first.left + viewport.left - base.left,
  }, root.clientWidth)
  return { ...position, top: position.top + root.scrollTop, left: position.left + root.scrollLeft }
}
