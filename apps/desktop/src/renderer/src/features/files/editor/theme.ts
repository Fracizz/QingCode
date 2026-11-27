// 编辑器主题：颜色全部取自 styles.css 的 CSS 变量，切换主题不需要重建编辑器；语法色深色接近 github-dark-default、浅色接近 github-light-default。
// CodeMirror 的样式由 styleModule 注入，不能写在 Tailwind 里（面板在无 portal 的编辑器 DOM 内）。

import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const qnEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--color-qn-text)',
      backgroundColor: 'var(--color-qn-code)',
      fontSize: 'var(--qn-editor-font-size, 12.5px)',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
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
      backgroundColor: 'var(--qn-selection)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-qn-accent) 13%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-qn-accent) 27%, transparent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-qn-code)',
      color: 'var(--color-qn-dim)',
      border: 'none',
      borderRight: '1px solid var(--color-qn-border)',
      minWidth: '44px',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-qn-fg) 3%, transparent)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in srgb, var(--color-qn-fg) 3%, transparent)',
      color: 'var(--color-qn-text)',
    },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--color-qn-dim)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-qn-active)',
      border: '1px solid var(--color-qn-border-strong)',
      borderRadius: '4px',
      color: 'var(--color-qn-muted)',
      padding: '0 4px',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--color-qn-brand) 20%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-qn-brand) 53%, transparent)',
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: 'var(--color-qn-danger)' },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-qn-warn) 20%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-qn-warn) 53%, transparent)',
      borderRadius: '2px',
    },
    '.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--color-qn-accent) 40%, transparent)',
      outlineColor: 'var(--color-qn-accent)',
    },
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
      backgroundColor: 'var(--color-qn-field)',
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
      boxShadow: 'var(--qn-float-shadow)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--color-qn-active)',
      color: 'var(--color-qn-text)',
    },
    // MergeView 自身不滚动，交给外层 .cm-mergeView 统一滚动。
    '.cm-mergeView': { height: '100%', overflowY: 'auto', backgroundColor: 'var(--color-qn-code)' },
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
    '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--color-qn-danger) 7%, transparent)' },
    '.cm-deletedChunk button[name=accept]': { backgroundColor: '#2f6f46' },
    '.cm-deletedChunk button[name=reject]': { backgroundColor: '#8a3b38' },
    '.cm-collapsedLines': { color: 'var(--color-qn-muted)' },
  },
  // 只影响 CodeMirror 内置的少量默认样式；用到的颜色上面都已覆盖，三套主题共用。
  { dark: true },
)

/** github-default 风格的 tag 配色（颜色随主题切换）；未覆盖的 tag 由语言包默认样式兜底。 */
export const qnHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.definitionKeyword], color: 'var(--qn-syn-keyword)' },
  { tag: [t.name, t.variableName, t.propertyName, t.attributeName], color: 'var(--qn-syn-name)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--qn-syn-function)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--qn-syn-constant)' },
  { tag: [t.typeName, t.className, t.namespace, t.number, t.bool, t.null, t.atom], color: 'var(--qn-syn-constant)' },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue], color: 'var(--qn-syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--qn-syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.operatorKeyword, t.escape, t.regexp, t.link, t.url], color: 'var(--qn-syn-operator)' },
  { tag: [t.heading], color: 'var(--qn-syn-constant)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.inserted], color: 'var(--qn-syn-inserted)' },
  { tag: [t.deleted], color: 'var(--qn-syn-deleted)' },
  { tag: [t.changed], color: 'var(--qn-syn-changed)' },
  { tag: [t.invalid], color: 'var(--qn-syn-invalid)' },
])
