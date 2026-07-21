import { getIndentUnit, language, syntaxTree } from '@codemirror/language'
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
  includePosition: (position: number, bracket: string) => boolean = () => true,
): BracketPair[] {
  const stack: { pos: number; ch: string; depth: number }[] = []
  const pairs: BracketPair[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (OPENERS.has(ch)) {
      if (!includePosition(i, ch)) continue
      stack.push({ pos: i, ch, depth: stack.length })
      continue
    }
    const want = CLOSERS[ch]
    if (!want) continue
    if (!includePosition(i, ch)) continue
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

/** Ignore bracket-looking characters inside strings/comments using Lezer tokens. */
export function scanStateBracketPairs(state: EditorState): BracketPair[] {
  const tree = syntaxTree(state)
  return scanBracketPairs(state.doc.toString(), 8000, (position, bracket) => {
    let node = tree.resolveInner(position, 1)
    if (
      node.from <= position &&
      node.to >= position + 1 &&
      (node.name === bracket || node.type.name === bracket)
    ) {
      return true
    }
    for (; node; node = node.parent!) {
      if (/(?:String|Comment|RegExp|Template)/i.test(node.name)) return false
      if (!node.parent) break
    }
    return true
  })
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

function buildColorDecorations(state: EditorState): DecorationSet {
  const pairs = scanStateBracketPairs(state)
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

/** Lines covered by a VS Code vertical bracket guide. */
export function bracketGuideLineRange(
  openLine: number,
  closeLine: number,
  includeCloseLine = false,
): { from: number; to: number } | null {
  if (closeLine <= openLine) return null
  return { from: openLine, to: closeLine - (includeCloseLine ? 0 : 1) }
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
export function lineIndentLevel(
  text: string,
  tabSize: number,
  indentSize = tabSize,
): number {
  if (!text.trim()) return -1
  return Math.ceil(lineIndentColumn(text, tabSize) / indentSize)
}

/** VS Code guide columns for a content line (0-based visual columns). */
export function indentGuideColumnsForLine(
  text: string,
  tabSize: number,
  indentSize = tabSize,
): number[] {
  return indentGuideColumnsForLevel(
    lineIndentLevel(text, tabSize, indentSize),
    indentSize,
  )
}

export function indentGuideColumnsForLevel(
  level: number,
  indentSize: number,
): number[] {
  if (level <= 0) return []
  return Array.from({ length: level }, (_, i) => i * indentSize)
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
  closeColInLine?: number,
): number | null {
  let minInner = Infinity
  for (const row of lineTexts) {
    if (row.number <= openLineNo || row.number > closeLineNo) continue
    if (!row.text.trim()) continue
    if (row.number === closeLineNo) {
      const firstNonWhitespace = row.text.search(/\S/)
      if (
        closeColInLine == null ||
        firstNonWhitespace < 0 ||
        firstNonWhitespace >= closeColInLine
      ) {
        continue
      }
    }
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
  closeColInLine?: number,
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
    ? closeColInLine != null
      ? visualColumnAt(closeRow.text, closeColInLine, tabSize)
      : lineIndentColumn(closeRow.text, tabSize)
    : openCol
  const inner = minInnerIndent(
    lineTexts,
    openLineNo,
    closeLineNo,
    tabSize,
    closeColInLine,
  )
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
    _closeOffsetInLine,
  )
}

export type BracketPairGuide = {
  enclosing: BracketPair
  fromLine: number
  toLine: number
  column: number
  active: boolean
}

/** Pick the innermost multi-line pair containing the cursor (VS Code range). */
export function findActiveGuidePair(
  pairs: BracketPair[],
  pos: number,
  _lineFrom: number,
  _lineTo: number,
  lineOfPos: (index: number) => { number: number },
): BracketPair | null {
  let enclosing: BracketPair | null = null
  for (const p of pairs) {
    const openLine = lineOfPos(p.open).number
    const closeLine = lineOfPos(p.close).number
    if (closeLine <= openLine) continue
    // VS Code's pair range is [open, close+1): caret on either bracket, or
    // immediately after the closer (typical end-of-line caret), still counts.
    if (pos < p.open || pos > p.close + 1) continue
    if (!enclosing || p.depth >= enclosing.depth) enclosing = p
  }
  return enclosing
}

type MinIndentTree = {
  offset: number
  values: number[]
}

function buildMinIndentTree(lines: readonly string[], tabSize: number): MinIndentTree {
  let offset = 1
  while (offset < lines.length) offset *= 2
  const values = new Array<number>(offset * 2).fill(Number.POSITIVE_INFINITY)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) values[offset + i] = lineIndentColumn(lines[i], tabSize)
  }
  for (let i = offset - 1; i > 0; i--) {
    values[i] = Math.min(values[i * 2], values[i * 2 + 1])
  }
  return { offset, values }
}

function minIndentInRange(
  tree: MinIndentTree,
  fromIndex: number,
  toIndex: number,
): number | null {
  if (fromIndex >= toIndex) return null
  let from = fromIndex + tree.offset
  let to = toIndex + tree.offset
  let result = Number.POSITIVE_INFINITY
  while (from < to) {
    if (from % 2 === 1) result = Math.min(result, tree.values[from++])
    if (to % 2 === 1) result = Math.min(result, tree.values[--to])
    from = Math.floor(from / 2)
    to = Math.floor(to / 2)
  }
  return Number.isFinite(result) ? result : null
}

/** Stable bracket-guide geometry; cursor movement changes only `active`. */
export function bracketPairGuidesForState(
  state: EditorState,
  lineTexts?: readonly string[],
): BracketPairGuide[] {
  const doc = state.doc
  const lines =
    lineTexts ??
    Array.from({ length: doc.lines }, (_, i) => {
      const line = doc.line(i + 1)
      return doc.sliceString(line.from, line.to)
    })
  const tabSize = state.facet(EditorState.tabSize)
  const minIndentTree = buildMinIndentTree(lines, tabSize)
  const pairs = scanStateBracketPairs(state)
  const head = state.selection.main.head
  const cursorLine = doc.lineAt(head)
  const activePair = findActiveGuidePair(
    pairs,
    head,
    cursorLine.from,
    cursorLine.to,
    i => doc.lineAt(i),
  )
  const guides: BracketPairGuide[] = []
  for (const pair of pairs) {
    const openLine = doc.lineAt(pair.open)
    const closeLine = doc.lineAt(pair.close)
    if (closeLine.number <= openLine.number) continue

    const openText = lines[openLine.number - 1]
    const closeText = lines[closeLine.number - 1]
    const openOffsetInLine = pair.open - openLine.from
    const closeOffsetInLine = pair.close - closeLine.from
    const firstNonWhitespace = closeText.search(/\S/)
    const hasTextBeforeCloser =
      firstNonWhitespace >= 0 && firstNonWhitespace < closeOffsetInLine
    const range = bracketGuideLineRange(
      openLine.number,
      closeLine.number,
      hasTextBeforeCloser,
    )
    if (!range) continue

    let innerIndent = minIndentInRange(
      minIndentTree,
      openLine.number,
      closeLine.number - 1,
    )
    if (hasTextBeforeCloser) {
      const closeLineIndent = lineIndentColumn(closeText, tabSize)
      innerIndent = Math.min(
        innerIndent ?? Number.POSITIVE_INFINITY,
        closeLineIndent,
      )
    }
    const column = Math.min(
      visualColumnAt(openText, openOffsetInLine, tabSize),
      visualColumnAt(closeText, closeOffsetInLine, tabSize),
      innerIndent ?? Number.POSITIVE_INFINITY,
    )
    guides.push({
      enclosing: pair,
      fromLine: range.from,
      toLine: range.to,
      column,
      active: pair === activePair,
    })
  }
  return guides
}

export type ActiveBlockGuide = {
  fromLine: number
  toLine: number
  column: number
}

/** VS Code effective indent levels, including its blank-line interpolation. */
export function indentLevelsForLines(
  lines: string[],
  tabSize: number,
  offSide = false,
  indentSize = tabSize,
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
    if (indent >= 0) return Math.ceil(indent / indentSize)
    const aboveIndent = above[i]
    const belowIndent = below[i]
    if (aboveIndent < 0 || belowIndent < 0) return 0
    if (aboveIndent < belowIndent) return 1 + Math.floor(aboveIndent / indentSize)
    if (aboveIndent === belowIndent) return Math.ceil(belowIndent / indentSize)
    return offSide
      ? Math.ceil(belowIndent / indentSize)
      : 1 + Math.floor(belowIndent / indentSize)
  })
}

export type ActiveIndentGuide = ActiveBlockGuide & { level: number }

/** Port of VS Code `getActiveIndentGuide`: one contiguous active indent scope. */
export function activeIndentGuideForLines(
  lines: string[],
  cursorLine: number,
  tabSize: number,
  offSide = false,
  indentSize = tabSize,
): ActiveIndentGuide | null {
  const levels = indentLevelsForLines(lines, tabSize, offSide, indentSize)
  return activeIndentGuideForLevels(levels, cursorLine, indentSize)
}

export function activeIndentGuideForLevels(
  levels: number[],
  cursorLine: number,
  indentSize: number,
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
    column: (level - 1) * indentSize,
  }
}

/** Solid 1px rails in one pseudo-element (no layered gradients). */
export function buildGuideBoxShadow(
  columns: number[],
  charWidth: number,
  activeCol: number | null | readonly number[],
): string {
  const active =
    activeCol == null
      ? new Set<number>()
      : new Set(typeof activeCol === 'number' ? [activeCol] : activeCol)
  const w = Math.max(1, charWidth)
  return columns
    .map(col => {
      // A 0px-offset shadow on a transparent box often fails to paint, which
      // hides the class-body rail (only column 0). Nudge it by 1px — same
      // visual lane as VS Code's first indent guide.
      const x = col <= 0 ? 1 : col * w
      const color = active.has(col)
        ? 'var(--editor-indent-guide-active)'
        : 'var(--editor-indent-guide)'
      return `${x}px 0 0 0 ${color}`
    })
    .join(', ')
}

/**
 * Port of VS Code `IndentGuidesOverlay.getGuidesByLine` column merge:
 * walk indent lanes left-to-right; flush earlier bracket rails; when a bracket
 * lands on the same column as an indent lane, skip the indent (bracket wins).
 * Remaining bracket rails (including non-indent columns) are appended.
 */
export function mergeGuideColumnsForLine(
  indentLevel: number,
  indentSize: number,
  indentationGuides: boolean,
  bracketColumns: readonly number[],
): number[] {
  const brackets = [...bracketColumns].sort((a, b) => a - b)
  let bi = 0
  const cols: number[] = []

  const takeBracketsWhile = (pred: (col: number) => boolean) => {
    while (bi < brackets.length && pred(brackets[bi])) {
      cols.push(brackets[bi++])
    }
  }

  if (indentationGuides && indentLevel > 0) {
    for (let indentLvl = 1; indentLvl <= indentLevel; indentLvl++) {
      const indentCol = (indentLvl - 1) * indentSize
      takeBracketsWhile(col => col < indentCol)
      const peeked = bi < brackets.length ? brackets[bi] : null
      // Same-column bracket replaces the indent lane (VS Code peek equality).
      if (peeked !== indentCol) cols.push(indentCol)
    }
  }
  takeBracketsWhile(() => true)
  return cols
}

/**
 * Hang-indent continuation lines (`data = [\\n        for x]`) are deeper than
 * the opener. Prefer the opener's indent rails plus the bracket rail under `[`
 * — not intermediate stubs at every hang-indent stop.
 *
 * When the opener is at column 0 (module-level `(...)` / `[...]`), still keep
 * at least indent level 1 so the outer gutter-adjacent rail does not vanish
 * on continuation lines (that gap looks like the line-number border “covering”
 * the guide).
 */
export function indentLevelForLineGuides(
  lineIndentLevel: number,
  bracketFromLines: readonly number[],
  indentLevels: readonly number[],
): number {
  if (bracketFromLines.length === 0) return lineIndentLevel
  let openerLevel = lineIndentLevel
  for (const fromLine of bracketFromLines) {
    const level = indentLevels[fromLine - 1]
    if (level != null) openerLevel = Math.min(openerLevel, level)
  }
  if (lineIndentLevel > openerLevel) {
    return Math.max(openerLevel, 1)
  }
  return lineIndentLevel
}

export function guideColumnsForLine(
  indentLevel: number,
  indentSize: number,
  indentationGuides: boolean,
  activeCol: number | null,
  addActiveColumn = true,
  bracketColumns: readonly number[] = [],
): number[] {
  const cols = new Set(
    mergeGuideColumnsForLine(
      indentLevel,
      indentSize,
      indentationGuides,
      bracketColumns,
    ),
  )
  if (addActiveColumn && activeCol != null) cols.add(activeCol)
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

/**
 * Active rails for a line. VS Code can light the active indent guide and the
 * active bracket guide at once (`highlightActiveIndentation: 'always'` style);
 * we always keep the active indent lit so the outer function rail does not
 * punch a gap through multi-line `[`…`]` continuations.
 */
export function resolveActiveGuideColumns(
  activeBracketCol: number | null,
  indentCol: number | null,
): number[] {
  const cols: number[] = []
  if (indentCol != null) cols.push(indentCol)
  if (activeBracketCol != null && activeBracketCol !== indentCol) {
    cols.push(activeBracketCol)
  }
  return cols
}

/** @deprecated Prefer {@link resolveActiveGuideColumns}. */
export function resolveActiveGuideColumn(
  activeBracketCol: number | null,
  indentCol: number | null,
  _hasBracketGuides = false,
  _highlightActiveIndentation: boolean | 'always' = true,
): number | null {
  return resolveActiveGuideColumns(activeBracketCol, indentCol)[0] ?? null
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
    const indentSize = getIndentUnit(view.state)
    const charWidth = view.defaultCharacterWidth || 8
    const doc = view.state.doc
    const lines = Array.from({ length: doc.lines }, (_, i) => {
      const line = doc.line(i + 1)
      return doc.sliceString(line.from, line.to)
    })
    const offSide = view.state.facet(language)?.name === 'python'
    const indentLevels = indentLevelsForLines(
      lines,
      tabSize,
      offSide,
      indentSize,
    )
    const bracketGuides = options.bracketPairGuides
      ? bracketPairGuidesForState(view.state, lines)
      : []
    const indent =
      options.indentationGuides && options.highlightActiveIndentation
        ? activeIndentGuideForLevels(
            indentLevels,
            doc.lineAt(view.state.selection.main.head).number,
            indentSize,
          )
        : null

    const builder = new RangeSetBuilder<Decoration>()
    const bracketGuidesByLine = new Map<number, BracketPairGuide[]>()
    if (bracketGuides.length > 0 && view.visibleRanges.length > 0) {
      const visibleFromLine = doc.lineAt(view.visibleRanges[0].from).number
      const lastVisibleRange = view.visibleRanges[view.visibleRanges.length - 1]
      const visibleToLine = doc.lineAt(lastVisibleRange.to).number
      for (const guide of bracketGuides) {
        const fromLine = Math.max(guide.fromLine, visibleFromLine)
        const toLine = Math.min(guide.toLine, visibleToLine)
        for (let lineNo = fromLine; lineNo <= toLine; lineNo++) {
          const lineGuides = bracketGuidesByLine.get(lineNo)
          if (lineGuides) lineGuides.push(guide)
          else bracketGuidesByLine.set(lineNo, [guide])
        }
      }
    }

    let lastDecoratedLine = 0
    for (const { from, to } of view.visibleRanges) {
      let pos = from
      while (pos <= to) {
        const line = doc.lineAt(pos)
        if (line.number === lastDecoratedLine) {
          pos = line.to + 1
          continue
        }
        lastDecoratedLine = line.number
        const lineBracketGuides = bracketGuidesByLine.get(line.number) ?? []
        const drawableBracketGuides = lineBracketGuides.filter(
          guide => line.number > guide.fromLine,
        )
        const activeBracketCol =
          drawableBracketGuides.find(guide => guide.active)?.column ?? null
        const indentCol = activeGuideColumnForLine(
          line.number,
          null,
          indent,
        )
        // Keep outer active indent lit through bracket-guide lines; also light
        // the active bracket rail when present (multi-active, VS Code-like).
        const activeCols = resolveActiveGuideColumns(
          activeBracketCol,
          indentCol,
        )
        const guideIndentLevel = indentLevelForLineGuides(
          indentLevels[line.number - 1],
          drawableBracketGuides.map(guide => guide.fromLine),
          indentLevels,
        )
        const columns = guideColumnsForLine(
          guideIndentLevel,
          indentSize,
          options.indentationGuides,
          activeCols[0] ?? null,
          false,
          drawableBracketGuides.map(guide => guide.column),
        )
        // Ensure every active rail is present in the shadow geometry.
        for (const col of activeCols) {
          if (!columns.includes(col)) columns.push(col)
        }
        columns.sort((a, b) => a - b)

        if (columns.length > 0) {
          const shadow = buildGuideBoxShadow(columns, charWidth, activeCols)
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
            this.decorations = buildColorDecorations(view.state)
          }
          update(update: ViewUpdate) {
            if (
              update.docChanged ||
              update.startState.facet(language) !== update.state.facet(language)
            ) {
              this.decorations = buildColorDecorations(update.state)
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
    '.cm-line': { position: 'relative', overflow: 'visible' },
    '.cm-line.cm-line-guides::before': {
      content: '""',
      position: 'absolute',
      // CodeMirror's content origin is the line's 6px left padding.
      left: '6px',
      top: '0',
      bottom: '0',
      width: '1px',
      pointerEvents: 'none',
      zIndex: '1',
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
