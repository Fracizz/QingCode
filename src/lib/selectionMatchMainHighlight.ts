import { SearchCursor } from '@codemirror/search'
import type { EditorState, Extension, SelectionRange } from '@codemirror/state'
import { EditorSelection, Facet, Prec } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  RectangleMarker,
  ViewPlugin,
  layer,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/** Mirrors @codemirror/search highlightSelectionMatches defaults. */
export const DEFAULT_MIN_SELECTION_MATCH_LENGTH = 1
export const DEFAULT_MAX_SELECTION_MATCH_LENGTH = 200
/** Cap painted matches; stop adding — never clear all (CM's default does). */
export const DEFAULT_MAX_SELECTION_MATCHES = 500

/**
 * Bump when occurrence-highlight wiring changes so stale cached/live EditorStates
 * are rebuilt (HMR / tab cache otherwise keep the old extension set).
 */
export const OCCURRENCE_HIGHLIGHT_REV = 3

const occurrenceHighlightRevFacet = Facet.define<number, number>({
  combine: values => values[0] ?? 0,
})

/** Marker extension — present only on states built with current match highlighting. */
export function occurrenceHighlightMarker(): Extension {
  return occurrenceHighlightRevFacet.of(OCCURRENCE_HIGHLIGHT_REV)
}

/** Whether this state includes the current occurrence-highlight extension set. */
export function editorHasOccurrenceHighlight(state: EditorState): boolean {
  return state.facet(occurrenceHighlightRevFacet) === OCCURRENCE_HIGHLIGHT_REV
}

export type MainSelectionMatchOptions = {
  minSelectionLength?: number
  maxSelectionLength?: number
  maxMatches?: number
}

/** Whether the main selection should receive match highlighting. */
export function shouldDecorateMainSelectionMatch(
  selection: EditorSelection,
  options: MainSelectionMatchOptions = {},
): boolean {
  if (selection.ranges.length > 1) return false
  const range = selection.main
  if (range.empty) return false
  const minLen = options.minSelectionLength ?? DEFAULT_MIN_SELECTION_MATCH_LENGTH
  const maxLen = options.maxSelectionLength ?? DEFAULT_MAX_SELECTION_MATCH_LENGTH
  const len = range.to - range.from
  return len >= minLen && len <= maxLen
}

/** Main selection range to decorate, or null when match highlighting does not apply. */
export function mainSelectionMatchRange(
  state: EditorState,
  options: MainSelectionMatchOptions = {},
): SelectionRange | null {
  if (!shouldDecorateMainSelectionMatch(state.selection, options)) return null
  const range = state.selection.main
  if (!state.sliceDoc(range.from, range.to)) return null
  return range
}

/**
 * Keep syntax token colors while text is selected. WebView2/Chromium otherwise
 * forces selected text to white even when native ::selection background is
 * transparent (CodeMirror draws its own selection layer).
 */
export function preserveSelectionTokenColors(): Extension {
  return Prec.highest(
    EditorView.theme({
      '.cm-line ::selection, .cm-line::selection, .cm-content ::selection': {
        color: 'inherit !important',
        '-webkit-text-fill-color': 'inherit !important',
      },
    }),
  )
}

const otherMatchMark = Decoration.mark({ class: 'cm-selectionMatch' })

/** Collect other occurrence ranges (excludes the primary selection). Caps without clearing. */
export function collectOtherSelectionMatchRanges(
  state: EditorState,
  from: number,
  to: number,
  options: MainSelectionMatchOptions = {},
): { from: number; to: number }[] {
  const range = mainSelectionMatchRange(state, options)
  if (!range) return []
  const query = state.sliceDoc(range.from, range.to)
  if (!query) return []

  const maxMatches = options.maxMatches ?? DEFAULT_MAX_SELECTION_MATCHES
  const out: { from: number; to: number }[] = []
  const cursor = new SearchCursor(state.doc, query, from, to)
  while (!cursor.next().done) {
    const match = cursor.value
    if (match.from < range.to && match.to > range.from) continue
    out.push({ from: match.from, to: match.to })
    if (out.length >= maxMatches) break
  }
  return out
}

function buildOtherMatchDecorations(
  view: EditorView,
  options: MainSelectionMatchOptions,
): DecorationSet {
  const deco = []
  for (const part of view.visibleRanges) {
    for (const match of collectOtherSelectionMatchRanges(
      view.state,
      part.from,
      part.to,
      options,
    )) {
      deco.push(otherMatchMark.range(match.from, match.to))
      if (deco.length >= (options.maxMatches ?? DEFAULT_MAX_SELECTION_MATCHES)) {
        return Decoration.set(deco)
      }
    }
  }
  return deco.length ? Decoration.set(deco) : Decoration.none
}

/**
 * Occurrence highlighting for double-click / selection:
 * - Other hits: Decoration.mark (background only, keeps syntax colors)
 * - Main hit: rectangle layer *above* the selection (forest selection bg is opaque)
 *
 * Unlike CodeMirror's highlightSelectionMatches, overflowing maxMatches stops
 * adding marks instead of clearing every highlight (common in Java/TS files).
 */
export function selectionMatchMainHighlight(options: MainSelectionMatchOptions = {}): Extension {
  const otherMatches = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildOtherMatchDecorations(view, options)
      }
      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged || update.viewportChanged) {
          this.decorations = buildOtherMatchDecorations(update.view, options)
        }
      }
    },
    { decorations: value => value.decorations },
  )

  const mainLayer = layer({
    above: true,
    class: 'cm-selectionMatchMainLayer',
    markers(view) {
      const range = mainSelectionMatchRange(view.state, options)
      if (!range) return []
      return RectangleMarker.forRange(view, 'cm-selectionMatchMain', range)
    },
    update(update) {
      return update.selectionSet || update.docChanged || update.viewportChanged
    },
  })

  const theme = EditorView.baseTheme({
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-selectionMatchMainLayer .cm-selectionMatchMain': {
      backgroundColor: 'rgba(153, 255, 119, 0.5)',
    },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  })

  return [theme, otherMatches, mainLayer]
}
