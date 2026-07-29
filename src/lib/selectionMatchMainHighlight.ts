import { SearchCursor } from '@codemirror/search'
import type { EditorState, Extension, SelectionRange } from '@codemirror/state'
import { EditorSelection, Facet, Prec } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
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
export const OCCURRENCE_HIGHLIGHT_REV = 5

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
 * Hide native ::selection chrome so only CodeMirror's `.cm-selectionBackground`
 * shows (one color). Also keep syntax token colors — WebView2/Chromium otherwise
 * forces selected text to white even when ::selection background is transparent.
 */
export function preserveSelectionTokenColors(): Extension {
  return Prec.highest(
    EditorView.theme({
      '.cm-line ::selection, .cm-line::selection, .cm-content ::selection': {
        backgroundColor: 'transparent !important',
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
 * Occurrence highlighting for double-click / selection.
 *
 * Only other hits get a match decoration. The primary selection is already
 * painted by CodeMirror's selection layer; drawing another translucent layer
 * above it changes both its background and syntax-token colors, and used to
 * make short selections look different from selections over the length cap.
 *
 * Unlike CodeMirror's highlightSelectionMatches, overflowing maxMatches stops
 * adding marks instead of clearing every highlight (common in Java/TS files).
 */
export function selectionMatchesHighlight(options: MainSelectionMatchOptions = {}): Extension {
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

  const theme = EditorView.baseTheme({
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  })

  return [theme, otherMatches]
}
