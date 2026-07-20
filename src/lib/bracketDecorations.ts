import { language } from '@codemirror/language'
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

/** VS Code indentation level for a content line; blank lines are resolved by context. */
export function lineIndentLevel(text: string, tabSize: number): number {
  if (!text.trim()) return -1
  return Math.ceil(lineIndentColumn(text, tabSize) / tabSize)
}

/** VS Code guide columns for a content line (0-based visual columns). */
export function indentGuideColumnsForLine(text: string, tabSize: number): number[] {
  return indentGuideColumnsForLevel(lineIndentLevel(text, tabSize), tabSize)
}

export function indentGuideColumnsForLevel(level: number, tabSize: number): number[] {
  if (level <= 0) return []
  return Array.from({ length: level }, (_, i) => i * tabSize)
}

function visualColumnAt(text: string, offset: number, tabSize: number): number {
  let col = 0
  for (let i = 0; i < Math.min(offset, text.length); i++) {
    col = text[i] === '\t' ? col + tabSize - (col % tabSize) : col + 1
  }
  return col
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
  return minInner === Infinity ? null : minInner
}

/** VS Code bracket guide column: minimum opener, closer, and inner indentation. */
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
  const openCol =
    openColInLine != null
      ? visualColumnAt(openText, openColInLine, tabSize)
      : lineIndentColumn(openText, tabSize)
  const closeRow = lineTexts.find(l => l.number === closeLineNo)
  const closeCol = closeRow
    ? lineIndentColumn(closeRow.text, tabSize)
    : openCol
  const inner = minInnerIndent(lineTexts, openLineNo, closeLineNo, tabSize)
  return Math.min(openCol, closeCol, inner ?? Number.POSITIVE_INFINITY)
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
  return blockGuideColumn(
    lineTexts,
    openLineNo,
    closeLineNo,
    tabSize,
    _openOffsetInLine,
  )
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

/** VS Code effective indent levels, including its blank-line interpolation. */
export function indentLevelsForLines(
  lines: string[],
  tabSize: number,
  offSide = false,
): number[] {
  const indents = lines.map(text =>
    text.trim() ? lineIndentColumn(text, tabSize) : -1,
  )
  const above = new Array<number>(lines.length).fill(-1)
  const below = new Array<number>(lines.length).fill(-1)

  let nearest = -1
  for (let i = 0; i < indents.length; i++) {
    above[i] = nearest
    if (indents[i] >= 0) nearest = indents[i]
  }
  nearest = -1
  for (let i = indents.length - 1; i >= 0; i--) {
    below[i] = nearest
    if (indents[i] >= 0) nearest = indents[i]
  }

  return indents.map((indent, i) => {
    if (indent >= 0) return Math.ceil(indent / tabSize)
    const aboveIndent = above[i]
    const belowIndent = below[i]
    if (aboveIndent < 0 || belowIndent < 0) return 0
    if (aboveIndent < belowIndent) return 1 + Math.floor(aboveIndent / tabSize)
    if (aboveIndent === belowIndent) return Math.ceil(belowIndent / tabSize)
    return offSide
      ? Math.ceil(belowIndent / tabSize)
      : 1 + Math.floor(belowIndent / tabSize)
  })
}

export type ActiveIndentGuide = ActiveBlockGuide & { level: number }

/** Port of VS Code `getActiveIndentGuide`: one contiguous active indent scope. */
export function activeIndentGuideForLines(
  lines: string[],
  cursorLine: number,
  tabSize: number,
  offSide = false,
): ActiveIndentGuide | null {
  const levels = indentLevelsForLines(lines, tabSize, offSide)
  return activeIndentGuideForLevels(levels, cursorLine, tabSize)
}

export function activeIndentGuideForLevels(
  levels: number[],
  cursorLine: number,
  tabSize: number,
): ActiveIndentGuide | null {
  if (cursorLine < 1 || cursorLine > levels.length) return null
  const index = cursorLine - 1
  const initial = levels[index]
  let level = initial
  let fromLine = cursorLine
  let toLine = cursorLine

  if (levels[index + 1] === initial + 1) {
    level = levels[index + 1]
    fromLine = cursorLine + 1
    toLine = cursorLine + 1
  } else if (levels[index - 1] === initial + 1) {
    level = levels[index - 1]
    fromLine = cursorLine - 1
    toLine = cursorLine - 1
  }
  if (level <= 0) return null

  while (fromLine > 1 && levels[fromLine - 2] >= level) fromLine--
  while (toLine < levels.length && levels[toLine] >= level) toLine++

  return {
    fromLine,
    toLine,
    level,
    column: (level - 1) * tabSize,
  }
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

export function guideColumnsForLine(
  indentLevel: number,
  tabSize: number,
  indentationGuides: boolean,
  activeCol: number | null,
): number[] {
  const cols = new Set<number>()
  if (indentationGuides) {
    for (const c of indentGuideColumnsForLevel(indentLevel, tabSize)) cols.add(c)
  }
  if (activeCol != null) cols.add(activeCol)
  return [...cols].sort((a, b) => a - b)
}

export function activeGuideColumnForLine(
  lineNo: number,
  bracket: ActiveBlockGuide | null,
  indent: ActiveIndentGuide | null,
): number | null {
  if (
    bracket &&
    lineNo >= bracket.fromLine &&
    lineNo <= bracket.toLine
  ) {
    return bracket.column
  }
  if (indent && lineNo >= indent.fromLine && lineNo <= indent.toLine) {
    return indent.column
  }
  return null
}

type GuideBuildOptions = {
  indentationGuides: boolean
  bracketPairGuides: boolean
  highlightActiveIndentation: boolean
}

function buildGuideDecorations(
  view: EditorView,
  options: GuideBuildOptions,
): DecorationSet {
  if (!options.indentationGuides && !options.bracketPairGuides) {
    return Decoration.none
  }

  try {
    const tabSize = view.state.facet(EditorState.tabSize)
    const charWidth = view.defaultCharacterWidth || 8
    const doc = view.state.doc
    const lines = Array.from({ length: doc.lines }, (_, i) => {
      const line = doc.line(i + 1)
      return doc.sliceString(line.from, line.to)
    })
    const offSide = view.state.facet(language)?.name === 'python'
    const indentLevels = indentLevelsForLines(lines, tabSize, offSide)
    const bracket = options.bracketPairGuides ? activeBlockGuide(view) : null
    const indent =
      options.indentationGuides && options.highlightActiveIndentation
        ? activeIndentGuideForLevels(
            indentLevels,
            doc.lineAt(view.state.selection.main.head).number,
            tabSize,
          )
        : null

    const builder = new RangeSetBuilder<Decoration>()

    for (const { from, to } of view.visibleRanges) {
      let pos = from
      while (pos <= to) {
        const line = doc.lineAt(pos)
        const activeCol = activeGuideColumnForLine(
          line.number,
          bracket,
          indent,
        )
        const columns = guideColumnsForLine(
          indentLevels[line.number - 1],
          tabSize,
          options.indentationGuides,
          activeCol,
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
  const bracketPairGuides = options.guides !== false
  const highlightActiveIndentation = options.highlightActiveIndentation !== false
  const guideOpts: GuideBuildOptions = {
    indentationGuides,
    bracketPairGuides,
    highlightActiveIndentation,
  }

  if (
    !options.colorization &&
    !indentationGuides &&
    !bracketPairGuides
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
    indentationGuides || bracketPairGuides
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
                update.viewportChanged ||
                update.startState.facet(language) !== update.state.facet(language)
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
