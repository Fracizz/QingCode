import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import { MATERIAL_FOREST as M } from './materialForestTheme'

/** CodeMirror chrome + syntax for JetBrains Material Forest. */
export const FOREST_THEME = EditorView.theme(
  {
    '&': { backgroundColor: M.background, color: M.syntax.variables },
    '.cm-gutters': {
      backgroundColor: M.contrast,
      color: M.text,
      borderRight: `1px solid ${M.border}`,
    },
    '.cm-activeLine': { backgroundColor: M.highlight },
    '.cm-activeLineGutter': { backgroundColor: M.highlight, color: M.foreground },
    // Only tint CM's drawn selection layer. Do not style ::selection color/background —
    // WebView2 turns selected token text white when ::selection sets `color`.
    '.cm-selectionBackground': { backgroundColor: M.selectionBg },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: M.selectionBg,
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: M.accent },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: M.active,
      outline: `1px solid ${M.syntax.green}`,
    },
    '.cm-searchMatch': { backgroundColor: M.buttons },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: M.highlight },
    // Match highlights: background only — never set `color` (keeps syntax tokens).
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-selectionMatchMainLayer .cm-selectionMatchMain': {
      backgroundColor: 'rgba(153, 255, 119, 0.5)',
    },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  },
  { dark: true },
)

const forestHighlight = HighlightStyle.define([
  { tag: t.keyword, color: M.syntax.keywords },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: M.syntax.variables },
  { tag: [t.propertyName], color: M.syntax.links },
  {
    tag: [t.function(t.variableName), t.labelName],
    color: M.syntax.functions,
    fontWeight: 'bold',
  },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: M.syntax.orange },
  {
    tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: M.syntax.yellow,
  },
  { tag: [t.number], color: M.syntax.orange },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: M.syntax.operators,
  },
  { tag: [t.meta, t.comment], color: M.syntax.comments, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: M.syntax.links, textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: M.syntax.yellow },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: M.syntax.purple },
  { tag: [t.processingInstruction, t.string, t.inserted], color: M.syntax.strings },
  { tag: t.tagName, color: M.syntax.tags },
  { tag: t.invalid, color: M.syntax.error },
])

export const forestSyntax = syntaxHighlighting(forestHighlight)
