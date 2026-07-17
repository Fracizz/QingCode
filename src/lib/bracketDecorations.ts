import { RangeSetBuilder, type Extension } from '@codemirror/state'
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

/** Innermost pair that fully contains `pos` (cursor between open and close). */
export function findEnclosingPair(
  pairs: BracketPair[],
  pos: number,
): BracketPair | null {
  let best: BracketPair | null = null
  for (const p of pairs) {
    if (pos <= p.open || pos > p.close) continue
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

function buildGuideDecorations(view: EditorView): DecorationSet {
  const head = view.state.selection.main.head
  const pairs = scanBracketPairs(view.state.doc.toString())
  const enclosing = findEnclosingPair(pairs, head)
  if (!enclosing) return Decoration.none

  const doc = view.state.doc
  const openLine = doc.lineAt(enclosing.open)
  const closeLine = doc.lineAt(enclosing.close)
  if (closeLine.number <= openLine.number + 1) return Decoration.none

  const col = enclosing.open - openLine.from
  const builder = new RangeSetBuilder<Decoration>()
  const lineDeco = Decoration.line({
    class: `cm-bracket-guide-line ${colorClass(enclosing.depth)}`,
    attributes: { style: `--cm-bracket-guide-col: ${col}ch` },
  })

  for (let lineNo = openLine.number + 1; lineNo < closeLine.number; lineNo++) {
    const line = doc.line(lineNo)
    builder.add(line.from, line.from, lineDeco)
  }
  return builder.finish()
}

export type BracketDecorationOptions = {
  colorization: boolean
  guides: boolean
}

/** CodeMirror extensions for VS-style bracket colorization / guides. */
export function bracketDecorationExtensions(
  options: BracketDecorationOptions,
): Extension {
  if (!options.colorization && !options.guides) return []

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

  const guidePlugin = options.guides
    ? ViewPlugin.fromClass(
        class {
          decorations: DecorationSet
          constructor(view: EditorView) {
            this.decorations = buildGuideDecorations(view)
          }
          update(update: ViewUpdate) {
            if (
              update.docChanged ||
              update.selectionSet ||
              update.viewportChanged
            ) {
              this.decorations = buildGuideDecorations(update.view)
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
    '.cm-bracket-guide-line': {
      position: 'relative',
    },
    '.cm-bracket-guide-line::before': {
      content: '""',
      position: 'absolute',
      top: '0',
      bottom: '0',
      left: 'var(--cm-bracket-guide-col, 0ch)',
      borderLeft: '1px solid currentColor',
      opacity: '0.4',
      pointerEvents: 'none',
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
