import type { Text, EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight'
import {
  MINIMAP_TEXT_FONT_SIZE,
  resolveMinimapCharSize,
  resolveMinimapContentHeight,
  resolveMinimapLineY,
  resolveMinimapPaintStyle,
  resolveMinimapScrollOffset,
  resolveMinimapVisibleLines,
  type MinimapPaintStyle,
  type MinimapRenderMode,
} from './minimapPolicy'
import {
  DEFAULT_MAX_SELECTION_MATCH_LENGTH,
  DEFAULT_MIN_SELECTION_MATCH_LENGTH,
  shouldDecorateMainSelectionMatch,
} from './selectionMatchMainHighlight'

export type MinimapPalette = {
  code: string
  comment: string
  string: string
  keyword: string
  number: string
  type: string
  function: string
  property: string
  density: string
  caret: string
  emptyLine: string
  /** Other selection-match occurrences (dimmer). */
  selectionMatch: string
  /** Main selected range match tint. */
  selectionMatchMain: string
}

/** Selection text used for occurrence highlights on the minimap, or null. */
export function resolveMinimapSelectionMatchQuery(state: EditorState): string | null {
  if (!shouldDecorateMainSelectionMatch(state.selection)) return null
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  if (!text || text.includes('\n')) return null
  const len = text.length
  if (len < DEFAULT_MIN_SELECTION_MATCH_LENGTH || len > DEFAULT_MAX_SELECTION_MATCH_LENGTH) {
    return null
  }
  return text
}

/** Find non-overlapping start indexes of `query` within `lineText` (capped). */
export function findMinimapSelectionMatchIndexes(
  lineText: string,
  query: string,
  maxChars: number,
): number[] {
  if (!query || maxChars <= 0) return []
  const haystack = lineText.slice(0, maxChars)
  const out: number[] = []
  let from = 0
  while (from < haystack.length) {
    const idx = haystack.indexOf(query, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + query.length
  }
  return out
}

const TOKEN_HIGHLIGHTER = tagHighlighter([
  { tag: t.comment, class: 'comment' },
  { tag: t.lineComment, class: 'comment' },
  { tag: t.blockComment, class: 'comment' },
  { tag: t.docComment, class: 'comment' },
  { tag: t.string, class: 'string' },
  { tag: t.special(t.string), class: 'string' },
  { tag: t.character, class: 'string' },
  { tag: t.keyword, class: 'keyword' },
  { tag: t.controlKeyword, class: 'keyword' },
  { tag: t.definitionKeyword, class: 'keyword' },
  { tag: t.moduleKeyword, class: 'keyword' },
  { tag: t.operatorKeyword, class: 'keyword' },
  { tag: t.number, class: 'number' },
  { tag: t.integer, class: 'number' },
  { tag: t.float, class: 'number' },
  { tag: t.bool, class: 'number' },
  { tag: t.atom, class: 'number' },
  { tag: t.null, class: 'number' },
  { tag: t.typeName, class: 'type' },
  { tag: t.className, class: 'type' },
  { tag: t.namespace, class: 'type' },
  { tag: t.function(t.variableName), class: 'function' },
  { tag: t.function(t.propertyName), class: 'function' },
  { tag: t.definition(t.function(t.variableName)), class: 'function' },
  { tag: t.propertyName, class: 'property' },
  { tag: t.variableName, class: 'code' },
  { tag: t.name, class: 'code' },
])

type LineKind = 'empty' | 'comment' | 'string' | 'keyword' | 'code'

const KEYWORD_RE =
  /^(import|export|from|function|const|let|var|class|return|if|else|for|while|switch|case|break|continue|type|interface|enum|async|await|def|public|private|protected|struct|fn|use|mod|impl|pub|package|func)\b/

/** Heuristic fallback when the syntax tree is unavailable. */
export function classifyLineFallback(text: string): LineKind {
  const trimmed = text.trimStart()
  if (!trimmed) return 'empty'
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('<!--')
  ) {
    return 'comment'
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`')) {
    return 'string'
  }
  if (KEYWORD_RE.test(trimmed)) return 'keyword'
  return 'code'
}

export function colorForLineKind(kind: LineKind, palette: MinimapPalette): string {
  switch (kind) {
    case 'comment':
      return palette.comment
    case 'string':
      return palette.string
    case 'keyword':
      return palette.keyword
    case 'empty':
      return 'transparent'
    default:
      return palette.code
  }
}

function colorForTokenClass(tokenClass: string, palette: MinimapPalette): string {
  switch (tokenClass) {
    case 'comment':
      return palette.comment
    case 'string':
      return palette.string
    case 'keyword':
      return palette.keyword
    case 'number':
      return palette.number
    case 'type':
      return palette.type
    case 'function':
      return palette.function
    case 'property':
      return palette.property
    default:
      return palette.code
  }
}

function readThemeVar(root: HTMLElement | Document, name: string, fallback: string): string {
  const styles = getComputedStyle(
    root instanceof Document
      ? root.documentElement
      : (root.ownerDocument?.documentElement ?? document.documentElement),
  )
  const value = styles.getPropertyValue(name).trim()
  return value || fallback
}

function parseRgb(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Blend syntax colors toward the editor background so the minimap feels softer. */
export function softenColor(color: string, toward: string, amount: number): string {
  const from = parseRgb(color)
  const bg = parseRgb(toward)
  if (!from || !bg) return color
  const t = Math.min(1, Math.max(0, amount))
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
  return `rgb(${mix(from[0], bg[0])}, ${mix(from[1], bg[1])}, ${mix(from[2], bg[2])})`
}

function sampleEditorSyntaxColors(editor: HTMLElement): Partial<MinimapPalette> {
  const sampled: Partial<MinimapPalette> = {}
  const spans = editor.querySelectorAll('.cm-line span')
  let scanned = 0
  for (const span of spans) {
    if (scanned++ > 180) break
    const text = (span.textContent ?? '').trim()
    if (!text) continue
    const style = getComputedStyle(span)
    const color = style.color
    if (!color) continue

    if (!sampled.comment && style.fontStyle === 'italic') {
      sampled.comment = color
      continue
    }
    if (!sampled.string && /^['"`]/.test(text)) {
      sampled.string = color
      continue
    }
    if (!sampled.keyword && KEYWORD_RE.test(text)) {
      sampled.keyword = color
      continue
    }
    if (!sampled.number && /^\d/.test(text)) {
      sampled.number = color
      continue
    }
    if (!sampled.type && /^[A-Z][A-Za-z0-9_$]*$/.test(text)) {
      sampled.type = color
    }
  }
  return sampled
}

/** Read palette from the live editor theme (CM spans + CSS vars), then soften. */
export function readMinimapPalette(
  root: HTMLElement | Document = document,
  editorEl?: HTMLElement | null,
): MinimapPalette {
  const editor = (editorEl?.closest('.cm-editor') ?? editorEl) as HTMLElement | null
  const content = editor?.querySelector('.cm-content')
  const bg =
    (editor && getComputedStyle(editor).backgroundColor) ||
    readThemeVar(root, '--color-bg', '#1e1e1e')
  const baseCode =
    (content && getComputedStyle(content).color) ||
    readThemeVar(root, '--color-fg', '#d4d4d4')

  const raw: MinimapPalette = {
    code: baseCode,
    comment: readThemeVar(root, '--color-fg-dim', '#6b6b6b'),
    string: readThemeVar(root, '--color-ok', '#89d185'),
    keyword: readThemeVar(root, '--color-accent', '#4d9eff'),
    number: readThemeVar(root, '--color-warn', '#d7ba7d'),
    type: readThemeVar(root, '--color-fg', baseCode),
    function: readThemeVar(root, '--color-accent', '#4d9eff'),
    property: readThemeVar(root, '--color-fg-muted', '#858585'),
    density: readThemeVar(root, '--color-fg-dim', '#6b6b6b'),
    caret: readThemeVar(root, '--color-accent', '#4d9eff'),
    emptyLine: readThemeVar(
      root,
      '--minimap-empty-line',
      'color-mix(in srgb, var(--color-fg) 8%, transparent)',
    ),
    selectionMatch: 'rgba(153, 255, 119, 0.2)',
    selectionMatchMain: 'rgba(153, 255, 119, 0.5)',
  }

  if (editor) {
    const sampled = sampleEditorSyntaxColors(editor)
    if (sampled.comment) raw.comment = sampled.comment
    if (sampled.string) raw.string = sampled.string
    if (sampled.keyword) raw.keyword = sampled.keyword
    if (sampled.number) raw.number = sampled.number
    if (sampled.type) raw.type = sampled.type
    if (sampled.function) raw.function = sampled.function
    if (sampled.property) raw.property = sampled.property
  }

  const soft = (color: string, amount = 0.32) => softenColor(color, bg, amount)
  return {
    code: soft(raw.code, 0.38),
    comment: soft(raw.comment, 0.42),
    string: soft(raw.string, 0.42),
    keyword: soft(raw.keyword, 0.4),
    number: soft(raw.number, 0.32),
    type: soft(raw.type, 0.36),
    function: soft(raw.function, 0.36),
    property: soft(raw.property, 0.38),
    density: soft(raw.density, 0.4),
    caret: soft(raw.caret, 0.22),
    emptyLine: raw.emptyLine,
    selectionMatch: raw.selectionMatch,
    selectionMatchMain: raw.selectionMatchMain,
  }
}

export function readMinimapFont(root: HTMLElement | Document = document): string {
  const mono = readThemeVar(
    root,
    '--font-mono',
    'ui-monospace, "Cascadia Mono", Consolas, monospace',
  )
  return `${MINIMAP_TEXT_FONT_SIZE}px ${mono}`
}

/** Normalize tabs and strip CR for minimap display. */
export function normalizeMinimapLine(text: string): string {
  return text.replace(/\t/g, '  ').replace(/\r/g, '')
}

/** True when a language parser has produced a usable Lezer tree (not plain text). */
export function syntaxHighlightAvailable(state: EditorState): boolean {
  const tree = syntaxTree(state)
  if (tree.length === 0 || tree.length < state.doc.length) return false
  const node = tree.topNode.firstChild
  if (!node) return false
  const name = node.type.name
  if (name === 'Text' || name === 'Document') {
    return node.nextSibling !== null || node.to - node.from < tree.length
  }
  return true
}

/** Fill per-character colors for a short line prefix via Lezer highlightTree. */
export function resolveLineCharColors(
  state: EditorState,
  lineFrom: number,
  text: string,
  palette: MinimapPalette,
  fallback: string,
): string[] {
  const colors = Array.from({ length: text.length }, () => fallback)
  if (!text) return colors
  if (!syntaxHighlightAvailable(state)) return colors

  const tree = syntaxTree(state)
  const to = lineFrom + text.length
  try {
    highlightTree(
      tree,
      TOKEN_HIGHLIGHTER,
      (start, end, style) => {
        if (!style) return
        const fill = colorForTokenClass(style, palette)
        const left = Math.max(start, lineFrom)
        const right = Math.min(end, to)
        for (let pos = left; pos < right; pos++) {
          colors[pos - lineFrom] = fill
        }
      },
      lineFrom,
      to,
    )
  } catch {
    // keep fallback colors
  }
  return colors
}

function paintEmptyLineMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  color: string,
): void {
  ctx.fillStyle = color
  ctx.fillRect(x, y + Math.max(0, lineHeight - 1), width, 1)
}

function paintCaretMarker(
  ctx: CanvasRenderingContext2D,
  caretY: number,
  width: number,
  lineHeight: number,
  palette: MinimapPalette,
): void {
  ctx.fillStyle = palette.caret
  ctx.globalAlpha = 0.72
  ctx.fillRect(0, caretY, 2, Math.max(2, lineHeight))
  ctx.globalAlpha = 0.06
  ctx.fillRect(0, caretY, width, lineHeight)
  ctx.globalAlpha = 1
}

/** Paint selection-match tints for the visible glance window (main + other hits). */
function paintSelectionMatches(
  ctx: CanvasRenderingContext2D,
  samples: ReturnType<typeof resolveMinimapVisibleLines>,
  doc: Text,
  state: EditorState,
  safeWidth: number,
  safeHeight: number,
  charWidth: number,
  charHeight: number,
  palette: MinimapPalette,
): void {
  const query = resolveMinimapSelectionMatchQuery(state)
  if (!query) return
  const main = state.selection.main
  const maxChars = Math.max(1, Math.floor(safeWidth / charWidth))
  const matchW = Math.max(1, query.length * charWidth)

  for (const sample of samples) {
    const y = sample.y
    if (y + charHeight < 0 || y > safeHeight) continue
    let lineText = ''
    let lineFrom = 0
    try {
      const line = doc.line(sample.lineNumber)
      lineFrom = line.from
      lineText = line.text
    } catch {
      continue
    }
    for (const idx of findMinimapSelectionMatchIndexes(lineText, query, maxChars)) {
      const from = lineFrom + idx
      const to = from + query.length
      const isMain = from < main.to && to > main.from
      ctx.fillStyle = isMain ? palette.selectionMatchMain : palette.selectionMatch
      ctx.fillRect(idx * charWidth, y, Math.min(matchW, safeWidth - idx * charWidth), charHeight)
    }
  }
}

function paintColoredSegments(
  ctx: CanvasRenderingContext2D,
  text: string,
  colors: string[],
  x: number,
  y: number,
  charWidth: number,
): void {
  if (!text) return
  ctx.textBaseline = 'top'
  let runStart = 0
  let runColor = colors[0] ?? colors[colors.length - 1]
  for (let i = 1; i <= text.length; i++) {
    const nextColor = i < text.length ? colors[i] : null
    if (i === text.length || nextColor !== runColor) {
      ctx.fillStyle = runColor
      ctx.fillText(text.slice(runStart, i), x + runStart * charWidth, y)
      runStart = i
      if (nextColor) runColor = nextColor
    }
  }
}

function paintMinimapBlocks(
  ctx: CanvasRenderingContext2D,
  samples: ReturnType<typeof resolveMinimapVisibleLines>,
  doc: Text,
  state: EditorState,
  mode: MinimapRenderMode,
  safeWidth: number,
  safeHeight: number,
  charWidth: number,
  charHeight: number,
  palette: MinimapPalette,
): void {
  const maxChars = Math.max(1, Math.floor(safeWidth / charWidth))
  const blockW = Math.max(1, charWidth)
  const blockH = Math.max(1, charHeight)

  for (const sample of samples) {
    const y = sample.y
    if (y + charHeight < 0 || y > safeHeight) continue

    let lineFrom = 0
    let prefix = ''
    try {
      const line = doc.line(sample.lineNumber)
      lineFrom = line.from
      prefix = normalizeMinimapLine(
        doc.sliceString(line.from, Math.min(line.to, line.from + maxChars)),
      )
    } catch {
      continue
    }

    if (mode === 'density') {
      if (!prefix.trim()) {
        paintEmptyLineMarker(ctx, 0, y, safeWidth, blockH, palette.emptyLine)
        continue
      }
      const density = Math.min(1, prefix.length / Math.max(8, maxChars))
      ctx.fillStyle = palette.density
      ctx.globalAlpha = 0.35 + density * 0.45
      ctx.fillRect(0, y, Math.max(blockW, safeWidth * density), blockH)
      ctx.globalAlpha = 1
      continue
    }

    if (!prefix.trim()) {
      paintEmptyLineMarker(ctx, 0, y, safeWidth, blockH, palette.emptyLine)
      continue
    }

    const fallback = colorForLineKind(classifyLineFallback(prefix), palette)
    const colors = resolveLineCharColors(state, lineFrom, prefix, palette, fallback)

    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i]
      if (ch === ' ') continue
      ctx.fillStyle = colors[i] ?? fallback
      ctx.fillRect(i * charWidth, y, blockW, blockH)
    }
  }
}

function paintMinimapText(
  ctx: CanvasRenderingContext2D,
  samples: ReturnType<typeof resolveMinimapVisibleLines>,
  doc: Text,
  state: EditorState,
  safeWidth: number,
  safeHeight: number,
  charWidth: number,
  charHeight: number,
  palette: MinimapPalette,
  font: string,
): void {
  const maxChars = Math.max(1, Math.floor(safeWidth / charWidth))
  ctx.font = font
  ctx.imageSmoothingEnabled = true
  ctx.globalAlpha = 0.86

  for (const sample of samples) {
    const y = sample.y
    if (y + charHeight < 0 || y > safeHeight) continue

    let lineFrom = 0
    let prefix = ''
    try {
      const line = doc.line(sample.lineNumber)
      lineFrom = line.from
      prefix = normalizeMinimapLine(
        doc.sliceString(line.from, Math.min(line.to, line.from + maxChars)),
      )
    } catch {
      continue
    }

    if (!prefix.trim()) {
      paintEmptyLineMarker(ctx, 0, y, safeWidth, charHeight, palette.emptyLine)
      continue
    }

    const fallback = colorForLineKind(classifyLineFallback(prefix), palette)
    const colors = resolveLineCharColors(state, lineFrom, prefix, palette, fallback)
    paintColoredSegments(ctx, prefix, colors, 0, y, charWidth)
  }

  ctx.globalAlpha = 1
}

export type PaintMinimapOptions = {
  canvas: HTMLCanvasElement
  doc: Text
  state: EditorState
  mode: MinimapRenderMode
  paintStyle: MinimapPaintStyle
  cssWidth: number
  cssHeight: number
  palette: MinimapPalette
  font: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** 1-based caret line; omit to skip caret marker. */
  caretLine?: number
}

/**
 * Minimap paint: text mode (default) or legacy color blocks.
 * Long files scroll the glance instead of crushing every line to 1px.
 */
export function paintMinimap({
  canvas,
  doc,
  state,
  mode,
  paintStyle,
  cssWidth,
  cssHeight,
  palette,
  font,
  scrollTop,
  scrollHeight,
  clientHeight,
  caretLine,
}: PaintMinimapOptions): void {
  const safeWidth = Math.min(Math.max(0, cssWidth), MINIMAP_CANVAS_MAX_CSS_PX)
  const safeHeight = Math.min(Math.max(0, cssHeight), MINIMAP_CANVAS_MAX_CSS_PX)
  if (mode === 'hidden' || safeWidth <= 0 || safeHeight <= 0) return

  const effectiveStyle = resolveMinimapPaintStyle(mode, paintStyle)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.floor(safeWidth * dpr))
  const height = Math.max(1, Math.floor(safeHeight * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  if (canvas.style.width !== `${safeWidth}px`) canvas.style.width = `${safeWidth}px`
  if (canvas.style.height !== `${safeHeight}px`) canvas.style.height = `${safeHeight}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, safeWidth, safeHeight)

  const { charWidth, charHeight } = resolveMinimapCharSize(mode, effectiveStyle)
  const totalLines = Math.max(1, doc.lines)
  const contentHeight = resolveMinimapContentHeight(totalLines, charHeight)
  const scrollOffset = resolveMinimapScrollOffset(
    scrollTop,
    scrollHeight,
    clientHeight,
    contentHeight,
    safeHeight,
  )
  const samples = resolveMinimapVisibleLines(totalLines, safeHeight, scrollOffset, charHeight)

  if (effectiveStyle === 'text') {
    paintMinimapText(ctx, samples, doc, state, safeWidth, safeHeight, charWidth, charHeight, palette, font)
  } else {
    ctx.imageSmoothingEnabled = false
    paintMinimapBlocks(ctx, samples, doc, state, mode, safeWidth, safeHeight, charWidth, charHeight, palette)
  }

  paintSelectionMatches(
    ctx,
    samples,
    doc,
    state,
    safeWidth,
    safeHeight,
    charWidth,
    charHeight,
    palette,
  )

  if (caretLine != null && caretLine >= 1) {
    const caretY = resolveMinimapLineY(caretLine, charHeight, scrollOffset)
    if (caretY + charHeight >= 0 && caretY <= safeHeight) {
      paintCaretMarker(ctx, caretY, safeWidth, charHeight, palette)
    }
  }
}

/** WebView2 / Chromium reject oversized backing stores (shows a broken canvas). */
export const MINIMAP_CANVAS_MAX_CSS_PX = 8192

/** Collect nearby source lines for the Quick View peek. */
export function collectQuickViewLines(
  doc: Text,
  centerLine: number,
  radius: number,
): { startLine: number; lines: string[] } {
  const total = Math.max(1, doc.lines)
  const start = Math.max(1, Math.floor(centerLine) - radius)
  const end = Math.min(total, Math.floor(centerLine) + radius)
  const lines: string[] = []
  for (let lineNumber = start; lineNumber <= end; lineNumber++) {
    try {
      const line = doc.line(lineNumber)
      lines.push(doc.sliceString(line.from, Math.min(line.to, line.from + 200)))
    } catch {
      lines.push('')
    }
  }
  return { startLine: start, lines }
}
