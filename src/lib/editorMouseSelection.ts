import {
  EditorSelection,
  findClusterBreak,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type SelectionRange,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Multi-click window (matches CodeMirror's IE fallback). */
const MULTI_CLICK_MS = 400
const MULTI_CLICK_PX = 2

let lastMouseDown: MouseEvent | null = null
let lastMouseDownCount = 0
let lastMouseDownTime = 0

/**
 * Reliable click count for mouse selection. Tauri/WebView2 often leaves
 * `event.detail` at 1 after CodeMirror preventDefault's mousedown.
 */
export function reliableClickType(event: MouseEvent): number {
  const now = Date.now()
  if (
    lastMouseDown &&
    now - lastMouseDownTime < MULTI_CLICK_MS &&
    Math.abs(lastMouseDown.clientX - event.clientX) < MULTI_CLICK_PX &&
    Math.abs(lastMouseDown.clientY - event.clientY) < MULTI_CLICK_PX
  ) {
    lastMouseDownCount = (lastMouseDownCount + 1) % 3
  } else {
    lastMouseDownCount = 1
  }
  lastMouseDown = event
  lastMouseDownTime = now
  return lastMouseDownCount === 0 ? 3 : lastMouseDownCount
}

/** Same character-group expansion CodeMirror uses for double-click selection. */
export function selectionGroupAt(state: EditorState, pos: number, bias = 1): SelectionRange {
  const categorize = state.charCategorizer(pos)
  const line = state.doc.lineAt(pos)
  const linePos = pos - line.from
  if (line.length === 0) return EditorSelection.cursor(pos)
  if (linePos === 0) bias = 1
  else if (linePos === line.length) bias = -1
  let from = linePos
  let to = linePos
  if (bias < 0) from = findClusterBreak(line.text, linePos, false)
  else to = findClusterBreak(line.text, linePos)
  const cat = categorize(line.text.slice(from, to))
  while (from > 0) {
    const prev = findClusterBreak(line.text, from, false)
    if (categorize(line.text.slice(prev, from)) !== cat) break
    from = prev
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to)
    if (categorize(line.text.slice(to, next)) !== cat) break
    to = next
  }
  return EditorSelection.range(from + line.from, to + line.from)
}

/** Map click count to the selection range CodeMirror would apply. */
export function selectionForClickType(
  state: EditorState,
  pos: number,
  assoc: -1 | 0 | 1,
  type: number,
): SelectionRange {
  if (type === 1) return EditorSelection.cursor(pos, assoc)
  if (type === 2) return selectionGroupAt(state, pos, assoc || 1)
  const line = state.doc.lineAt(pos)
  const from = line.from
  let to = line.to
  if (to < state.doc.length && to === line.to) to++
  return EditorSelection.range(from, to)
}

function removeRangeAround(sel: EditorSelection, pos: number): EditorSelection | null {
  for (let i = 0; i < sel.ranges.length; i++) {
    const { from, to } = sel.ranges[i]
    if (from <= pos && to >= pos) {
      const ranges = sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1))
      const mainIndex =
        sel.mainIndex === i ? 0 : sel.mainIndex - (sel.mainIndex > i ? 1 : 0)
      return EditorSelection.create(ranges, mainIndex)
    }
  }
  return null
}

function buildMouseSelectionStyle(view: EditorView, event: MouseEvent) {
  const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false)
  const type = reliableClickType(event)
  let startSel = view.state.selection
  return {
    update(update: { docChanged: boolean; changes: ChangeDesc }) {
      if (update.docChanged) {
        start.pos = update.changes.mapPos(start.pos)
        startSel = startSel.map(update.changes)
      }
    },
    get(event: MouseEvent, extend: boolean, multiple: boolean) {
      const cur = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false)
      let range = selectionForClickType(view.state, cur.pos, cur.assoc, type)
      if (start.pos !== cur.pos && !extend) {
        const startRange = selectionForClickType(view.state, start.pos, start.assoc, type)
        const from = Math.min(startRange.from, range.from)
        const to = Math.max(startRange.to, range.to)
        range =
          from < range.from
            ? EditorSelection.range(from, to, range.assoc)
            : EditorSelection.range(to, from, range.assoc)
      }
      if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc))
      if (multiple && type === 1) {
        const removed = removeRangeAround(startSel, cur.pos)
        if (removed) return removed
      }
      if (multiple) return startSel.addRange(range)
      return EditorSelection.create([range])
    },
  }
}

/** Override CM mouse selection when WebView2 breaks multi-click `event.detail`. */
export function reliableClickMouseSelection(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.altKey) return null
    return buildMouseSelectionStyle(view, event)
  })
}
