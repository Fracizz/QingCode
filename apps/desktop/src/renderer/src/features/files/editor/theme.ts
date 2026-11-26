// 编辑器主题：颜色取自 styles.css 的 @theme token；语法配色接近 github-dark-default。
// CodeMirror 的样式由 styleModule 注入，不能写在 Tailwind 里（面板在无 portal 的编辑器 DOM 内）。

import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const qnEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--color-qn-text)',
      backgroundColor: '#141414',
      fontSize: '12.5px',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '20px',
      overflow: 'auto',
    },
    '.cm-content': {
      padding: '8px 0',
      caretColor: 'var(--color-qn-accent)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-qn-accent)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#264f78',
    },
    '.cm-selectionMatch': { backgroundColor: '#4f8cff22', outline: '1px solid #4f8cff44' },
    '.cm-gutters': {
      backgroundColor: '#141414',
      color: 'var(--color-qn-dim)',
      border: 'none',
      borderRight: '1px solid var(--color-qn-border)',
      minWidth: '44px',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px' },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff08', color: 'var(--color-qn-text)' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--color-qn-dim)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-qn-active)',
      border: '1px solid var(--color-qn-border-strong)',
      borderRadius: '4px',
      color: 'var(--color-qn-muted)',
      padding: '0 4px',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: '#4ecdb533',
      outline: '1px solid #4ecdb588',
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: 'var(--color-qn-danger)' },
    '.cm-searchMatch': {
      backgroundColor: '#e2b55d33',
      outline: '1px solid #e2b55d88',
      borderRadius: '2px',
    },
    '.cm-searchMatch-selected': { backgroundColor: '#4f8cff66', outlineColor: 'var(--color-qn-accent)' },
    '.cm-panels': {
      backgroundColor: 'var(--color-qn-panel)',
      color: 'var(--color-qn-text)',
      borderColor: 'var(--color-qn-border)',
    },
    '.cm-panel.cm-search': {
      padding: '6px 8px',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px',
    },
    '.cm-panel.cm-search [name=close]': { color: 'var(--color-qn-muted)' },
    '.cm-panel.cm-search label': { color: 'var(--color-qn-muted)', fontSize: '11px' },
    '.cm-textfield': {
      backgroundColor: '#161616',
      border: '1px solid var(--color-qn-border-strong)',
      borderRadius: '6px',
      color: 'var(--color-qn-text)',
      fontSize: '12px',
      padding: '3px 8px',
      outline: 'none',
    },
    '.cm-textfield:focus': { borderColor: 'var(--color-qn-accent)' },
    '.cm-button': {
      backgroundColor: 'var(--color-qn-active)',
      border: '1px solid var(--color-qn-border-strong)',
      borderRadius: '6px',
      color: 'var(--color-qn-text)',
      fontSize: '11px',
      padding: '3px 8px',
    },
    '.cm-button:hover': { backgroundColor: 'var(--color-qn-hover)' },
    '.cm-panel.cm-gotoLine input': { minWidth: '8rem' },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-qn-float)',
      border: '1px solid var(--color-qn-border-strong)',
      borderRadius: '8px',
      color: 'var(--color-qn-text)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--color-qn-active)',
      color: 'var(--color-qn-text)',
    },
    // MergeView 自身不滚动，交给外层 .cm-mergeView 统一滚动。
    '.cm-mergeView': { height: '100%', overflowY: 'auto', backgroundColor: '#141414' },
    '.cm-mergeView .cm-editor': { backgroundColor: 'transparent' },
    '.cm-mergeViewEditors': { minHeight: '100%' },
    '.cm-merge-revert button': {
      color: 'var(--color-qn-brand)',
      backgroundColor: 'var(--color-qn-panel)',
      border: '1px solid var(--color-qn-border-strong)',
      borderRadius: '4px',
      fontSize: '11px',
      lineHeight: '16px',
    },
    '.cm-deletedChunk': { backgroundColor: '#ff6b6312' },
    '.cm-deletedChunk button[name=accept]': { backgroundColor: '#2f6f46' },
    '.cm-deletedChunk button[name=reject]': { backgroundColor: '#8a3b38' },
    '.cm-collapsedLines': { color: 'var(--color-qn-muted)' },
  },
  { dark: true },
)

/** github-dark-default 风格的 tag 配色；未覆盖的 tag 由语言包默认样式兜底。 */
export const qnHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.definitionKeyword], color: '#ff7b72' },
  { tag: [t.name, t.variableName, t.propertyName, t.attributeName], color: '#e6e6e6' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#d2a8ff' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#79c0ff' },
  { tag: [t.typeName, t.className, t.namespace, t.number, t.bool, t.null, t.atom], color: '#79c0ff' },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue], color: '#a5d6ff' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.operator, t.operatorKeyword, t.escape, t.regexp, t.link, t.url], color: '#ffa657' },
  { tag: [t.heading], color: '#79c0ff', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.inserted], color: '#7ee787' },
  { tag: [t.deleted], color: '#ffa198' },
  { tag: [t.changed], color: '#e2b55d' },
  { tag: [t.invalid], color: '#ff6b63' },
])
