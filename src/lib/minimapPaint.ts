import type { Text, EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight'
import {
  resolveMinimapCharSize,
  resolveMinimapContentHeight,
  resolveMinimapLineY,
  resolveMinimapScrollOffset,
  resolveMinimapVisibleLines,
  type MinimapRenderMode,
} from './minimapPolicy'

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

export function readMinimapPalette(root: HTMLElement | Document = document): MinimapPalette {
  const styles = getComputedStyle(
    root instanceof Document ? root.documentElement : root.ownerDocument?.documentElement ?? document.documentElement,
  )
  const read = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim()
    return value || fallback
  }
  return {
    code: read('--color-fg-muted', '#858585'),
    comment: read('--color-fg-dim', '#6b6b6b'),
    string: read('--color-ok', '#89d185'),
    keyword: read('--color-accent', '#4d9eff'),
    number: read('--color-warn', '#d7ba7d'),
    type: read('--color-fg', '#cccccc'),
    function: read('--color-accent', '#4d9eff'),
    property: read('--color-fg-muted', '#858585'),
    density: read('--color-fg-dim', '#6b6b6b'),
    caret: read('--color-accent', '#4d9eff'),
  }
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

export type PaintMinimapOptions = {
  canvas: HTMLCanvasElement
  doc: Text
  state: EditorState
  mode: MinimapRenderMode
  cssWidth: number
  cssHeight: number
  palette: MinimapPalette
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** 1-based caret line; omit to skip caret marker. */
  caretLine?: number
}

/**
 * CodeGlance-style paint: fixed char width/height blocks.
 * Long files scroll the glance instead of crushing every line to 1px.
 */
export function paintMinimap({
  canvas,
  doc,
  state,
  mode,
  cssWidth,
  cssHeight,
  palette,
  scrollTop,
  scrollHeight,
  clientHeight,
  caretLine,
}: PaintMinimapOptions): void {
  const safeWidth = Math.min(Math.max(0, cssWidth), MINIMAP_CANVAS_MAX_CSS_PX)
  const safeHeight = Math.min(Math.max(0, cssHeight), MINIMAP_CANVAS_MAX_CSS_PX)
  if (mode === 'hidden' || safeWidth <= 0 || safeHeight <= 0) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.floor(safeWidth * dpr))
  const height = Math.max(1, Math.floor(safeHeight * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  // Keep CSS box == logical paint size so the bitmap is not bilinear-scaled.
  if (canvas.style.width !== `${safeWidth}px`) canvas.style.width = `${safeWidth}px`
  if (canvas.style.height !== `${safeHeight}px`) canvas.style.height = `${safeHeight}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, safeWidth, safeHeight)

  const { charWidth, charHeight } = resolveMinimapCharSize(mode)
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
  const maxChars = Math.max(1, Math.floor(safeWidth / charWidth))
  // Gapless blocks read as smooth token streaks (IDEA/CodeGlance look) rather
  // than a sparse LEGO grid.
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
      // Cap prefix to visible char columns — never materialize the whole document.
      prefix = doc.sliceString(line.from, Math.min(line.to, line.from + maxChars))
    } catch {
      continue
    }

    if (mode === 'density') {
      if (!prefix.trim()) continue
      const density = Math.min(1, prefix.length / Math.max(8, maxChars))
      ctx.fillStyle = palette.density
      ctx.globalAlpha = 0.4 + density * 0.5
      ctx.fillRect(0, y, Math.max(blockW, safeWidth * density), blockH)
      ctx.globalAlpha = 1
      continue
    }

    if (!prefix) continue

    const fallback = colorForLineKind(classifyLineFallback(prefix), palette)
    if (fallback === 'transparent') continue
    const colors = resolveLineCharColors(state, lineFrom, prefix, palette, fallback)

    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i]
      if (ch === ' ' || ch === '\t' || ch === '\r') continue
      ctx.fillStyle = colors[i] ?? fallback
      ctx.fillRect(i * charWidth, y, blockW, blockH)
    }
  }

  if (caretLine != null && caretLine >= 1) {
    const caretY = resolveMinimapLineY(caretLine, charHeight, scrollOffset)
    if (caretY + charHeight >= 0 && caretY <= safeHeight) {
      ctx.fillStyle = palette.caret
      ctx.globalAlpha = 0.9
      ctx.fillRect(0, caretY, safeWidth, Math.max(2, charHeight))
      ctx.globalAlpha = 1
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
      // Cap each line so a huge single line cannot blow up the peek.
      lines.push(doc.sliceString(line.from, Math.min(line.to, line.from + 200)))
    } catch {
      lines.push('')
    }
  }
  return { startLine: start, lines }
}
