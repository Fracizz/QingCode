import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

const OPENERS = new Set(['(', '[', '{'])
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export type BracketPair = {
  open: number
  close: number
  depth: number
  openCh: string
}

/** Scan plain text for `()[]{}` pairs (string/comment-unaware, best-effort). */
export function scanBracketPairs(
  text: string,
  maxPairs = 8000,
): BracketPair[] {
  const stack: { pos: number; ch: string; depth: number }[] = []
  const pairs: BracketPair[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (OPENERS.has(ch)) {
      stack.push({ pos: i, ch, depth: stack.length })
      continue
    }
    const want = CLOSERS[ch]
    if (!want) continue
    for (let j = stack.length - 1; j >= 0; j--) {
      if (stack[j].ch !== want) continue
      const open = stack[j]
      stack.length = j
      pairs.push({
        open: open.pos,
        close: i,
        depth: open.depth,
        openCh: open.ch,
      })
      if (pairs.length >= maxPairs) return pairs
      break
    }
  }
  return pairs
}

/** Innermost pair containing `pos`, including the open/close bracket characters. */
export function findEnclosingPair(
  pairs: BracketPair[],
  pos: number,
): BracketPair | null {
  let best: BracketPair | null = null
  for (const p of pairs) {
    if (pos < p.open || pos > p.close) continue
    if (!best || p.depth >= best.depth) best = p
  }
  return best
}

const COLOR_COUNT = 6

function colorClass(depth: number): string {
  return `cm-bracket-color-${depth % COLOR_COUNT}`
}

const colorMark = Array.from({ length: COLOR_COUNT }, (_, i) =>
  Decoration.mark({ class: colorClass(i) }),
)

function buildColorDecorations(doc: string): DecorationSet {
  const pairs = scanBracketPairs(doc)
  const builder = new RangeSetBuilder<Decoration>()
  const marks: { from: number; to: number; depth: number }[] = []
  for (const p of pairs) {
    marks.push({ from: p.open, to: p.open + 1, depth: p.depth })
    marks.push({ from: p.close, to: p.close + 1, depth: p.depth })
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  for (const m of marks) {
    builder.add(m.from, m.to, colorMark[m.depth % COLOR_COUNT])
  }
  return builder.finish()
}

/** Inclusive line numbers for the active bracket-pair guide (VS-style rail). */
export function bracketGuideLineRange(
  openLine: number,
  closeLine: number,
): { from: number; to: number } | null {
  if (closeLine <= openLine) return null
  return { from: openLine, to: closeLine }
}

/** Visual column of leading whitespace (tabs expanded). */
export function lineIndentColumn(text: string, tabSize: number): number {
  let col = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === ' ') {
      col++
      continue
    }
    if (ch === '\t') {
      col += tabSize - (col % tabSize)
      continue
    }
    break
  }
  return col
}

/** Snap a column to the nearest indent lane (tabSize, 2×tabSize, …). */
export function snapIndentLane(col: number, tabSize: number): number {
  if (col <= 0) return tabSize
  const lane = Math.round(col / tabSize) * tabSize
  return lane > 0 ? lane : tabSize
}

/** Indent-guide columns for one line (VS Code `editor.guides.indentation`).
 * Guides sit in leading whitespace only — never on the first content column
 * (so a lone `{` / `}` line does not get a rail through the brace).
 */
export function indentGuideColumnsForLine(text: string, tabSize: number): number[] {
  const indent = lineIndentColumn(text, tabSize)
  const cols: number[] = []
  for (let c = tabSize; c < indent; c += tabSize) {
    cols.push(c)
  }
  return cols
}

function minInnerIndent(
  lineTexts: { number: number; text: string }[],
  openLineNo: number,
  closeLineNo: number,
  tabSize: number,
): number | null {
  let minInner = Infinity
  for (const row of lineTexts) {
    if (row.number <= openLineNo || row.number >= closeLineNo) continue
    if (!row.text.trim()) continue
    minInner = Math.min(minInner, lineIndentColumn(row.text, tabSize))
  }
  return minInner === Infinity ? null : snapIndentLane(minInner, tabSize)
}

/**
 * VS Code active bracket-pair guide column (`editor.guides.bracketPairs`):
 * - brace alone on its line → column of `{` / `[`
 * - `fn() {` at EOL → first body indent lane
 */
export function blockGuideColumn(
  lineTexts: { number: number; text: string }[],
  openLineNo: number,
  closeLineNo: number,
  tabSize: number,
  openColInLine?: number,
): number {
  const openRow = lineTexts.find(l => l.number === openLineNo)
  if (!openRow) return tabSize

  const openText = openRow.text
  const openIndent = lineIndentColumn(openText, tabSize)
  const openCol =
    openColInLine != null ? openColInLine : openIndent
  const trimmed = openText.trim()
  const braceOnlyLine =
    trimmed === '{' ||
    trimmed === '{,' ||
    trimmed === '[' ||
    trimmed === '],' ||
    /^[\[{]\s*,?\s*$/.test(trimmed)

  // `      {` — rail sits on the brace column (VS).
  if (braceOnlyLine) return openCol

  // `function f() {` / `"obj": {` — body indent; `"tasks": [` — key/closer indent.
  const braceAfterCode = /\S.*[\{\[]\s*$/.test(openText)
  if (braceAfterCode) {
    const closeRow = lineTexts.find(l => l.number === closeLineNo)
    const closeIndent = closeRow ? lineIndentColumn(closeRow.text, tabSize) : openIndent
    const closeTrim = closeRow?.text.trim() ?? ''
    const closeAlone = /^[\]\}],?\s*$/.test(closeTrim)
    const openCh = openText.trimEnd().slice(-1)
    // JSON arrays: `    "tasks": [ … ]` — rail at the key/`]` indent, not inner `{`.
    if (openCh === '[' && closeAlone && closeIndent === openIndent && openIndent > 0) {
      return openIndent
    }
    const inner = minInnerIndent(lineTexts, openLineNo, closeLineNo, tabSize)
    if (inner != null) return inner
    if (closeRow) return closeIndent
    return openIndent + tabSize
  }

  if (openCol > 0) return openCol

  const inner = minInnerIndent(lineTexts, openLineNo, closeLineNo, tabSize)
  if (inner != null) return inner

  const closeRow = lineTexts.find(l => l.number === closeLineNo)
  if (closeRow && closeLineNo > openLineNo) {
    return lineIndentColumn(closeRow.text, tabSize)
  }
  return tabSize
}

/** @deprecated Use {@link blockGuideColumn}; kept for tests. */
export function bracketGuideColumn(
  lineTexts: { number: number; text: string }[],
  openLineNo: number,
  closeLineNo: number,
  _openOffsetInLine: number,
  _closeOffsetInLine: number,
  tabSize: number,
): number {
  return blockGuideColumn(lineTexts, openLineNo, closeLineNo, tabSize)
}

export type ActiveBracketGuide = {
  enclosing: BracketPair
  column: number
  openLineNo: number
  closeLineNo: number
}

/**
 * Pick the multi-line pair to highlight (VS behavior):
 * prefer a pair that opens/closes on the cursor line (even if caret is in
 * leading whitespace before `{`), else innermost enclosing pair.
 */
export function findActiveGuidePair(
  pairs: BracketPair[],
  pos: number,
  lineFrom: number,
  lineTo: number,
  lineOfPos: (index: number) => { number: number },
): BracketPair | null {
  let onLine: BracketPair | null = null
  for (const p of pairs) {
    const openLine = lineOfPos(p.open).number
    const closeLine = lineOfPos(p.close).number
    if (closeLine <= openLine) continue
    const touches =
      (p.open >= lineFrom && p.open <= lineTo) ||
      (p.close >= lineFrom && p.close <= lineTo)
    if (!touches) continue
    if (!onLine || p.depth >= onLine.depth) onLine = p
  }
  if (onLine) return onLine
  return findEnclosingPair(pairs, pos)
}

/** Active bracket-pair guide metadata for the current cursor (or null). */
export function activeBracketGuide(view: EditorView): ActiveBracketGuide | null {
  const head = view.state.selection.main.head
  const doc = view.state.doc
  const pairs = scanBracketPairs(doc.toString())
  const cursorLine = doc.lineAt(head)
  const enclosing = findActiveGuidePair(
    pairs,
    head,
    cursorLine.from,
    cursorLine.to,
    i => doc.lineAt(i),
  )
  if (!enclosing) return null

  const openLine = doc.lineAt(enclosing.open)
  const closeLine = doc.lineAt(enclosing.close)
  const range = bracketGuideLineRange(openLine.number, closeLine.number)
  if (!range) return null

  const tabSize = view.state.facet(EditorState.tabSize)
  const lineTexts: { number: number; text: string }[] = []
  for (let lineNo = range.from; lineNo <= range.to; lineNo++) {
    const line = doc.line(lineNo)
    lineTexts.push({ number: lineNo, text: doc.sliceString(line.from, line.to) })
  }
  const column = blockGuideColumn(
    lineTexts,
    openLine.number,
    closeLine.number,
    tabSize,
    enclosing.open - openLine.from,
  )
  return {
    enclosing,
    column,
    openLineNo: openLine.number,
    closeLineNo: closeLine.number,
  }
}

/** Active `{…}` / `[…]` block guide span (VS bracket-pairs rail at indent lane). */
export type ActiveBlockGuide = {
  fromLine: number
  toLine: number
  column: number
}

export function activeBlockGuide(view: EditorView): ActiveBlockGuide | null {
  const g = activeBracketGuide(view)
  if (!g) return null
  return {
    fromLine: g.openLineNo,
    toLine: g.closeLineNo,
    column: g.column,
  }
}

/** VS Code `editor.guides.highlightActiveIndentation`: cursor line indent lane. */
export function activeIndentGuideColumn(view: EditorView): number | null {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const text = view.state.doc.sliceString(line.from, line.to)
  const tabSize = view.state.facet(EditorState.tabSize)
  const indent = lineIndentColumn(text, tabSize)
  if (indent <= 0) return null
  return snapIndentLane(indent, tabSize)
}

/** Solid 1px rails via box-shadow (no gradient AA / inter-line dots). */
export function buildGuideBoxShadow(
  columns: number[],
  charWidth: number,
  activeCol: number | null,
): string {
  const w = Math.max(1, charWidth)
  return columns
    .map(col => {
      const x = Math.max(0, Math.round(col * w))
      const color =
        activeCol != null && col === activeCol
          ? 'var(--editor-indent-guide-active)'
          : 'var(--editor-indent-guide)'
      return `${x}px 0 0 0 ${color}`
    })
    .join(', ')
}

function guideColumnsForLine(
  text: string,
  tabSize: number,
  lineNo: number,
  block: ActiveBlockGuide | null,
  indentationGuides: boolean,
): number[] {
  const cols = new Set<number>()
  if (indentationGuides) {
    for (const c of indentGuideColumnsForLine(text, tabSize)) cols.add(c)
  }
  // Active rail only where this line still has whitespace at that column
  // (never paint on the `{` / `}` characters themselves).
  if (
    block &&
    lineNo >= block.fromLine &&
    lineNo <= block.toLine &&
    lineIndentColumn(text, tabSize) > block.column
  ) {
    cols.add(block.column)
  }
  return [...cols].sort((a, b) => a - b)
}

function activeGuideColumnForLine(
  lineNo: number,
  lineIndent: number,
  block: ActiveBlockGuide | null,
  cursorIndentCol: number | null,
  blockScopeGuides: boolean,
  highlightActiveIndentation: boolean,
): number | null {
  if (
    blockScopeGuides &&
    block &&
    lineNo >= block.fromLine &&
    lineNo <= block.toLine &&
    lineIndent > block.column
  ) {
    return block.column
  }
  if (blockScopeGuides && block) return null
  if (
    highlightActiveIndentation &&
    cursorIndentCol != null &&
    lineIndent > cursorIndentCol
  ) {
    return cursorIndentCol
  }
  return null
}

type GuideBuildOptions = {
  indentationGuides: boolean
  blockScopeGuides: boolean
  highlightActiveIndentation: boolean
}

function buildGuideDecorations(
  view: EditorView,
  options: GuideBuildOptions,
): DecorationSet {
  if (
    !options.indentationGuides &&
    !options.blockScopeGuides &&
    !options.highlightActiveIndentation
  ) {
    return Decoration.none
  }

  try {
    const tabSize = view.state.facet(EditorState.tabSize)
    const charWidth = view.defaultCharacterWidth || 8
    const doc = view.state.doc
    const block = options.blockScopeGuides ? activeBlockGuide(view) : null
    const cursorIndentCol = options.highlightActiveIndentation
      ? activeIndentGuideColumn(view)
      : null

    const builder = new RangeSetBuilder<Decoration>()

    for (const { from, to } of view.visibleRanges) {
      let pos = from
      while (pos <= to) {
        const line = doc.lineAt(pos)
        const text = doc.sliceString(line.from, line.to)
        const lineIndent = lineIndentColumn(text, tabSize)
        const columns = guideColumnsForLine(
          text,
          tabSize,
          line.number,
          block,
          options.indentationGuides,
        )

        const activeCol = activeGuideColumnForLine(
          line.number,
          lineIndent,
          block,
          cursorIndentCol,
          options.blockScopeGuides,
          options.highlightActiveIndentation,
        )

        if (columns.length > 0) {
          const shadow = buildGuideBoxShadow(columns, charWidth, activeCol)
          builder.add(
            line.from,
            line.from,
            Decoration.line({
              class: 'cm-line-guides',
              attributes: {
                style: `--cm-guide-shadow: ${shadow}`,
              },
            }),
          )
        }

        pos = line.to + 1
      }
    }

    return builder.finish()
  } catch {
    return Decoration.none
  }
}

export type BracketDecorationOptions = {
  colorization: boolean
  guides: boolean
  indentationGuides?: boolean
  highlightActiveIndentation?: boolean
}

/** CodeMirror extensions for VS-style bracket colorization / guides. */
export function bracketDecorationExtensions(
  options: BracketDecorationOptions,
): Extension {
  const indentationGuides = options.indentationGuides !== false
  // Vertical brace-pair rails are easy to mis-place vs VS; keep matching via
  // bracketMatching + active *indent* highlight instead.
  const blockScopeGuides = false
  const highlightActiveIndentation =
    options.highlightActiveIndentation !== false || options.guides !== false
  const guideOpts: GuideBuildOptions = {
    indentationGuides,
    blockScopeGuides,
    highlightActiveIndentation,
  }

  if (
    !options.colorization &&
    !indentationGuides &&
    !blockScopeGuides &&
    !highlightActiveIndentation
  ) {
    return []
  }

  const colorPlugin = options.colorization
    ? ViewPlugin.fromClass(
        class {
          decorations: DecorationSet
          constructor(view: EditorView) {
            this.decorations = buildColorDecorations(view.state.doc.toString())
          }
          update(update: ViewUpdate) {
            if (update.docChanged) {
              this.decorations = buildColorDecorations(update.state.doc.toString())
            }
          }
        },
        { decorations: v => v.decorations },
      )
    : []

  const guidePlugin =
    indentationGuides || blockScopeGuides || highlightActiveIndentation
      ? ViewPlugin.fromClass(
          class {
            decorations: DecorationSet

            constructor(view: EditorView) {
              this.decorations = buildGuideDecorations(view, guideOpts)
            }

            update(update: ViewUpdate) {
              if (
                update.docChanged ||
                update.selectionSet ||
                update.geometryChanged ||
                update.viewportChanged
              ) {
                this.decorations = buildGuideDecorations(update.view, guideOpts)
              }
            }
          },
          { decorations: v => v.decorations },
        )
      : []

  const theme = EditorView.baseTheme({
    '.cm-bracket-color-0': { color: '#e06c75' },
    '.cm-bracket-color-1': { color: '#e5c07b' },
    '.cm-bracket-color-2': { color: '#98c379' },
    '.cm-bracket-color-3': { color: '#56b6c2' },
    '.cm-bracket-color-4': { color: '#61afef' },
    '.cm-bracket-color-5': { color: '#c678dd' },
    '.cm-line': { position: 'relative' },
    '.cm-line.cm-line-guides::before': {
      content: '""',
      position: 'absolute',
      left: '0',
      top: '0',
      bottom: '0',
      width: '1px',
      pointerEvents: 'none',
      zIndex: '0',
      background: 'transparent',
      boxShadow: 'var(--cm-guide-shadow)',
    },
    '&light .cm-bracket-color-0': { color: '#c41e3a' },
    '&light .cm-bracket-color-1': { color: '#b88000' },
    '&light .cm-bracket-color-2': { color: '#107c10' },
    '&light .cm-bracket-color-3': { color: '#038387' },
    '&light .cm-bracket-color-4': { color: '#005fb8' },
    '&light .cm-bracket-color-5': { color: '#881798' },
  })

  return [theme, colorPlugin, guidePlugin]
}
