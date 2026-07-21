import { indentUnit } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  highlightTrailingWhitespace,
  highlightWhitespace,
} from '@codemirror/view'
import { bracketDecorationExtensions } from './bracketDecorations'
import {
  detectIndentFromContent,
  getEditorPreferences,
  type EditorPreferenceSettings,
} from './editorSettings'

export type BuildEditorPreferenceOptions = {
  /** Skip expensive bracket decorations (degraded / plain / huge docs). */
  enableBracketDecorations?: boolean
}

/** Build CodeMirror extensions from effective editor preferences. */
export function buildEditorPreferenceExtensions(
  prefs: EditorPreferenceSettings = getEditorPreferences(),
  content?: string,
  options: BuildEditorPreferenceOptions = {},
): Extension[] {
  let tabSize = prefs.tabSize
  let insertSpaces = prefs.insertSpaces
  if (prefs.detectIndentation && content) {
    const detected = detectIndentFromContent(content)
    if (detected) {
      tabSize = detected.tabSize
      insertSpaces = detected.insertSpaces
    }
  }

  const indent = insertSpaces ? ' '.repeat(tabSize) : '\t'
  const wrapOn = prefs.wordWrap !== 'off'
  const showLineNumbers = prefs.lineNumbers !== 'off'

  // CodeMirror has no built-in "selection-only" whitespace highlighter (VS Code's
  // `selection` mode). Map selection/none → off so we do not paint every indent
  // space as dots. `boundary` is approximated with full highlightWhitespace.
  const whitespaceExt =
    prefs.renderWhitespace === 'all' || prefs.renderWhitespace === 'boundary'
      ? highlightWhitespace()
      : prefs.renderWhitespace === 'trailing'
        ? highlightTrailingWhitespace()
        : []

  const bracketsEnabled = options.enableBracketDecorations !== false
  const bracketExt = bracketsEnabled
    ? bracketDecorationExtensions({
        colorization: prefs.bracketPairColorization,
        guides: prefs.guidesEnabled && prefs.bracketPairGuides,
        indentationGuides: prefs.guidesEnabled && prefs.indentationGuides,
        highlightActiveIndentation: prefs.highlightActiveIndentation,
      })
    : []

  return [
    EditorView.theme({
      '&': { fontSize: `${prefs.fontSize}px` },
      '.cm-scroller': { fontSize: `${prefs.fontSize}px` },
    }),
    EditorState.tabSize.of(tabSize),
    indentUnit.of(indent),
    wrapOn ? EditorView.lineWrapping : [],
    showLineNumbers
      ? []
      : EditorView.editorAttributes.of({ class: 'cm-hide-linenumbers' }),
    whitespaceExt,
    bracketExt,
  ]
}
