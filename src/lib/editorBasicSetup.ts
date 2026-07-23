import {
  closeBrackets,
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  matchBrackets,
  syntaxHighlighting,
  type MatchResult,
} from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { EditorState, Facet, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from '@codemirror/view'
import { clearCachedEditorStates } from './editorSession'
import { createFoldGutterMarker } from './foldGutterMarkers'

const BRACKETS = '()[]{}'

/**
 * Bump when caret-bracket highlight wiring changes so cached/HMR EditorStates
 * rebuild. Module load also clears the tab state cache (Vite HMR).
 */
export const CURSOR_BRACKET_HIGHLIGHT_REV = 3

clearCachedEditorStates()

const cursorBracketHighlightRevFacet = Facet.define<number, number>({
  combine: values => values[0] ?? 0,
})

/** Marker so every EditorState (incl. plain/degraded) can pass the cache gate. */
export function cursorBracketHighlightMarker(): Extension {
  return cursorBracketHighlightRevFacet.of(CURSOR_BRACKET_HIGHLIGHT_REV)
}

/** Whether this state includes the current caret-side bracket highlight. */
export function editorHasCursorBracketHighlight(state: EditorState): boolean {
  return state.facet(cursorBracketHighlightRevFacet) === CURSOR_BRACKET_HIGHLIGHT_REV
}

/**
 * Dedicated class — never reuse `cm-matchingBracket` (CM default paints both
 * ends with that class; we neutralize it in CSS and paint with this instead).
 */
export const CURSOR_BRACKET_CLASS = 'cm-cursorBracket'
export const CURSOR_BRACKET_BAD_CLASS = 'cm-cursorBracketBad'

const cursorBracketMark = Decoration.mark({ class: CURSOR_BRACKET_CLASS })
const cursorBracketBadMark = Decoration.mark({ class: CURSOR_BRACKET_BAD_CLASS })

function tryBraceAt(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } | null {
  if (from < 0 || to > state.doc.length || to - from !== 1) return null
  const ch = state.sliceDoc(from, to)
  if (!BRACKETS.includes(ch)) return null
  return { from, to }
}

/**
 * CM `match.start` can be a multi-char syntax node (e.g. whole Object). Always
 * resolve to the single brace glyph beside the caret.
 */
export function cursorSideBracketRange(
  state: EditorState,
  match: MatchResult,
  head: number,
): { from: number; to: number } | null {
  const inMatch = (from: number, to: number) => {
    if (from >= match.start.from && to <= match.start.to) return true
    if (match.end && from >= match.end.from && to <= match.end.to) return true
    return false
  }

  const tryPos = (from: number, to: number) => {
    const r = tryBraceAt(state, from, to)
    if (!r || !inMatch(from, to)) return null
    return r
  }

  return (
    tryPos(head - 1, head) ||
    tryPos(head, head + 1) ||
    (match.start.to - match.start.from === 1 ? match.start : null) ||
    tryPos(match.start.from, match.start.from + 1) ||
    (match.end ? tryPos(match.end.from, match.end.from + 1) : null)
  )
}

/** Single brace glyph for a match endpoint (handles multi-char syntax nodes). */
export function matchEndpointGlyph(
  state: EditorState,
  endpoint: { from: number; to: number },
  prefer: 'start' | 'end',
): { from: number; to: number } | null {
  if (endpoint.to - endpoint.from === 1) {
    return tryBraceAt(state, endpoint.from, endpoint.to)
  }
  if (prefer === 'start') {
    return (
      tryBraceAt(state, endpoint.from, endpoint.from + 1) ||
      tryBraceAt(state, endpoint.to - 1, endpoint.to)
    )
  }
  return (
    tryBraceAt(state, endpoint.to - 1, endpoint.to) ||
    tryBraceAt(state, endpoint.from, endpoint.from + 1)
  )
}

function findMatchAtHead(state: EditorState, head: number): MatchResult | null {
  return (
    matchBrackets(state, head, -1) ||
    (head > 0 ? matchBrackets(state, head - 1, 1) : null) ||
    matchBrackets(state, head, 1) ||
    (head < state.doc.length ? matchBrackets(state, head + 1, -1) : null)
  )
}

/** Ranges to paint for one MatchResult — both pair ends when matched. */
export function decorationsForMatch(state: EditorState, match: MatchResult) {
  const mark = match.matched ? cursorBracketMark : cursorBracketBadMark
  const byFrom = new Map<number, { from: number; to: number }>()
  const add = (r: { from: number; to: number } | null) => {
    if (r) byFrom.set(r.from, r)
  }
  add(matchEndpointGlyph(state, match.start, 'start'))
  if (match.end) add(matchEndpointGlyph(state, match.end, 'end'))
  return [...byFrom.values()].map(r => mark.range(r.from, r.to))
}

/**
 * Highlight both ends of the matched pair (VS/CM style), each as a 1-char glyph.
 * Unmatched: only the caret-side brace with the bad mark.
 */
export function cursorBracketDecorations(state: EditorState): DecorationSet {
  const decos = []
  for (const range of state.selection.ranges) {
    let head = range.head
    if (!range.empty) {
      if (range.to - range.from !== 1) continue
      if (!BRACKETS.includes(state.sliceDoc(range.from, range.to))) continue
      head = range.from
    }
    const match = findMatchAtHead(state, head)
    if (!match) continue
    if (!match.matched) {
      const caret = cursorSideBracketRange(state, match, head)
      if (caret) decos.push(cursorBracketBadMark.range(caret.from, caret.to))
      continue
    }
    decos.push(...decorationsForMatch(state, match))
  }
  return Decoration.set(decos, true)
}

function renderMatchBoth(match: MatchResult, state: EditorState) {
  if (!match.matched) {
    const head = state.selection.main.head
    const caret = cursorSideBracketRange(state, match, head)
    return caret ? [cursorBracketBadMark.range(caret.from, caret.to)] : []
  }
  return decorationsForMatch(state, match)
}

/**
 * Same as CodeMirror `basicSetup`, but without `highlightSelectionMatches`.
 * QingCode installs its own occurrence highlighter (caps matches instead of
 * disabling all highlights when over the limit — important for Java/TS).
 *
 * Uses `bracketMatching` with a custom `renderMatch` that paints both pair
 * ends via `cm-cursorBracket` (not CM's default class).
 */
export function qingBasicSetup(): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: createFoldGutterMarker }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching({ renderMatch: renderMatchBoth }),
    EditorView.theme({
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'transparent',
        outline: 'none',
      },
      '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'transparent',
        outline: 'none',
      },
      [`.${CURSOR_BRACKET_CLASS}, &.cm-focused .${CURSOR_BRACKET_CLASS}`]: {
        backgroundColor: 'var(--editor-matching-bracket-bg)',
        outline: '1px solid var(--editor-matching-bracket-outline)',
      },
      [`.${CURSOR_BRACKET_BAD_CLASS}, &.cm-focused .${CURSOR_BRACKET_BAD_CLASS}`]:
        {
          backgroundColor:
            'color-mix(in srgb, var(--color-danger) 28%, transparent)',
          outline:
            '1px solid color-mix(in srgb, var(--color-danger) 55%, transparent)',
        },
    }),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
    ]),
  ]
}
