import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

/** Everforest medium-dark palette — common “Forest” look in JetBrains Everforest plugins. */
export const FOREST_THEME = EditorView.theme(
  {
    '&': { backgroundColor: '#2d353b', color: '#d3c6aa' },
    '.cm-gutters': {
      backgroundColor: '#232a2e',
      color: '#7a8478',
      borderRight: '1px solid #4f585e',
    },
    '.cm-activeLine': { backgroundColor: '#343f44' },
    '.cm-activeLineGutter': { backgroundColor: '#343f44', color: '#d3c6aa' },
    '.cm-selectionBackground, ::selection': { backgroundColor: '#543a48' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#543a48',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#d3c6aa' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: '#425047',
      outline: '1px solid #83c092',
    },
    '.cm-searchMatch': { backgroundColor: '#4d4c43' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#55544a' },
  },
  { dark: true },
)

const forestHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#e67e80' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#d3c6aa' },
  { tag: [t.propertyName], color: '#7fbbb3' },
  { tag: [t.function(t.variableName), t.labelName], color: '#a7c080', fontWeight: 'bold' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#d699b6' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#dbbc7f' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#e69875' },
  { tag: [t.meta, t.comment], color: '#859289', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#7fbbb3', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: '#dbbc7f' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#d699b6' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#a7c080' },
  { tag: t.invalid, color: '#e67e80' },
])

export const forestSyntax = syntaxHighlighting(forestHighlight)
