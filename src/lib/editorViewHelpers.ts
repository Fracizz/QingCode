import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { FOREST_THEME, forestSyntax } from './forestEditorTheme'
import { getResolvedTheme } from './themeSettings'
import type { EditorTab } from '../types'

// 浅色编辑器主题：与 App.css 的 [data-theme="light"] 调色协调。
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#f0f0f0', color: '#1f1f1f' },
    '.cm-gutters': { backgroundColor: '#ebebeb', color: '#757575', borderRight: '1px solid #d0d0d0' },
    '.cm-activeLine': { backgroundColor: '#e8edf2' },
    '.cm-activeLineGutter': { backgroundColor: '#e2e8ef', color: '#1f1f1f' },
    '.cm-selectionBackground': { backgroundColor: '#cfe3fb' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#b9d6f5',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1a1a1a' },
    '.cm-searchMatch': { backgroundColor: '#ffe9a8' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#ffd56b' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-selectionMatchMainLayer .cm-selectionMatchMain': {
      backgroundColor: 'rgba(153, 255, 119, 0.5)',
    },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  },
  { dark: false },
)

/** Soften oneDark’s near-white default body; leave syntax token colors alone. */
const darkDefaultFgTheme = EditorView.theme(
  {
    '&': { color: '#cccccc' },
    '.cm-content': { color: '#cccccc' },
  },
  { dark: true },
)

/** Selection-match colors for oneDark (main overlay + other hits). */
const darkSelectionMatchTheme = EditorView.theme(
  {
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-selectionMatchMainLayer .cm-selectionMatchMain': {
      backgroundColor: 'rgba(153, 255, 119, 0.5)',
    },
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

export const flashLineEffect = StateEffect.define<number>()
export const clearFlashEffect = StateEffect.define<void>()

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
