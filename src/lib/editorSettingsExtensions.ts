import { indentUnit } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  highlightTrailingWhitespace,
  highlightWhitespace,
} from '@codemirror/view'
import {
  detectIndentFromContent,
  getEditorPreferences,
  type EditorPreferenceSettings,
} from './editorSettings'

/** Build CodeMirror extensions from effective editor preferences. */
export function buildEditorPreferenceExtensions(
  prefs: EditorPreferenceSettings = getEditorPreferences(),
  content?: string,
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

  const whitespaceExt =
    prefs.renderWhitespace === 'all' || prefs.renderWhitespace === 'boundary'
      ? highlightWhitespace()
      : prefs.renderWhitespace === 'trailing'
        ? highlightTrailingWhitespace()
        : prefs.renderWhitespace === 'selection'
          ? highlightWhitespace()
          : []

  return [
    EditorState.tabSize.of(tabSize),
    indentUnit.of(indent),
    wrapOn ? EditorView.lineWrapping : [],
    showLineNumbers
      ? []
      : EditorView.editorAttributes.of({ class: 'cm-hide-linenumbers' }),
    whitespaceExt,
  ]
}
