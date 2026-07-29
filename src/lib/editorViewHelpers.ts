import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { FOREST_THEME, forestSyntax } from './forestEditorTheme'
import { getResolvedTheme } from './themeSettings'
import type { EditorTab } from '../types'

// 浅色编辑器主题：与 App.css 的 [data-theme="light"] 调色协调。
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#f0f0f0', color: '#1f1f1f' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg)',
      color: 'var(--color-fg-muted)',
      borderRight: 'none',
    },
    '.cm-activeLine': { backgroundColor: '#e8edf2' },
    '.cm-activeLineGutter': { backgroundColor: '#e8edf2', color: '#1f1f1f' },
    '.cm-selectionBackground': { backgroundColor: '#cfe3fb' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#b9d6f5',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1a1a1a' },
    '.cm-searchMatch': { backgroundColor: '#ffe9a8' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#ffd56b' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  },
  { dark: false },
)

/** Soften oneDark’s near-white default body; leave syntax token colors alone. */
const darkDefaultFgTheme = EditorView.theme(
  {
    '&': { color: '#cccccc' },
    '.cm-content': { color: '#cccccc' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg)',
      color: 'var(--color-fg-muted)',
      borderRight: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in srgb, var(--color-bg-hover) 70%, transparent)',
      color: 'var(--color-fg)',
    },
  },
  { dark: true },
)

/** Selection-match colors for oneDark (other occurrence hits). */
const darkSelectionMatchTheme = EditorView.theme(
  {
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  },
  { dark: true },
)

export function editorThemeExtension() {
  const resolved = getResolvedTheme()
  if (resolved === 'forest') return [FOREST_THEME, forestSyntax]
  if (resolved === 'dark') return [oneDark, darkDefaultFgTheme, darkSelectionMatchTheme]
  return lightTheme
}

export const FLASH_REVEAL_MS = 1200

export const flashLineEffect = StateEffect.define<number>()
export const clearFlashEffect = StateEffect.define<void>()

export type EditorRevealScroll = 'if-needed' | 'center' | 'none'

/** True when `pos` lies inside any currently visible editor range. */
export function isEditorPositionVisible(view: EditorView, pos: number): boolean {
  for (const range of view.visibleRanges) {
    if (pos >= range.from && pos <= range.to) return true
  }
  return false
}

export function revealPosFromLineColumn(
  state: EditorState,
  line: number,
  column?: number,
  from?: number
): { pos: number; lineNum: number } {
  const lineNum = Math.min(Math.max(1, line), state.doc.lines)
  const docLine = state.doc.line(lineNum)
  const pos =
    typeof from === 'number'
      ? Math.min(Math.max(0, from), state.doc.length)
      : typeof column === 'number'
        ? Math.min(Math.max(docLine.from, docLine.from + column - 1), docLine.to)
        : docLine.from
  return { pos, lineNum }
}

/** Place the caret on a target line/column, flash it, and scroll only when needed. */
export function editorRevealPos(
  view: EditorView,
  pos: number,
  lineNum: number,
  scroll: EditorRevealScroll = 'if-needed'
): void {
  const shouldScroll =
    scroll === 'center' || (scroll === 'if-needed' && !isEditorPositionVisible(view, pos))
  view.dispatch({
    effects: shouldScroll
      ? [EditorView.scrollIntoView(pos, { y: 'center' }), flashLineEffect.of(lineNum)]
      : [flashLineEffect.of(lineNum)],
    selection: { anchor: pos },
  })
}

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(flashLineEffect)) {
        const lines = tr.state.doc.lines
        const lineNumber = Math.min(Math.max(1, effect.value), lines)
        const line = tr.state.doc.line(lineNumber)
        return Decoration.set([
          Decoration.mark({ class: 'cm-search-reveal-flash' }).range(line.from, line.to),
        ])
      }
      if (effect.is(clearFlashEffect)) return Decoration.none
    }
    return value
  },
  provide: field => EditorView.decorations.from(field),
})

export function hasNonEmptySelection(view: EditorView) {
  return !view.state.selection.main.empty
}

export function selectedText(view: EditorView) {
  const { from, to } = view.state.selection.main
  return view.state.sliceDoc(from, to)
}

export function selectionLineRange(view: EditorView) {
  const selection = view.state.selection.main
  const startLine = view.state.doc.lineAt(selection.from).number
  const endPosition = selection.empty
    ? selection.head
    : Math.max(selection.from, selection.to - 1)
  const endLine = view.state.doc.lineAt(endPosition).number
  return { startLine, endLine }
}

export function scheduleIdle(fn: () => void, timeoutMs = 800): () => void {
  let cancelled = false
  const run = () => {
    if (!cancelled) fn()
  }
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: timeoutMs })
    return () => {
      cancelled = true
      window.cancelIdleCallback(id)
    }
  }
  const timer = window.setTimeout(run, 0)
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}

export function isMarkdownTab(tab: EditorTab | undefined | null): boolean {
  if (!tab) return false
  if (tab.language === 'markdown') return true
  return /\.md$/i.test(tab.path)
}
