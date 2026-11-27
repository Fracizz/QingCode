// 编辑器扩展装配：普通文件、合并视图共用一套主题与语言，交互扩展只在文件编辑器里启用。

import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type KeyBinding,
} from '@codemirror/view'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { qnEditorTheme, qnHighlightStyle } from './theme'
import { getEditorHooks, languageCompartment, readOnlyCompartment } from './stateCache'

export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

/** 视觉 + 基础编辑能力：行号、折叠、括号、多光标、补全、语法高亮、语言。 */
export function coreExtensions(language: Extension = []): Extension[] {
  return [
    qnEditorTheme,
    syntaxHighlighting(qnHighlightStyle),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    foldGutter(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    EditorState.allowMultipleSelections.of(true),
    languageCompartment.of(language),
  ]
}

/**
 * 自定义键位放在最前面；必须过滤 searchKeymap 的 Mod-g（Shift 变体 findPrevious 会吃掉
 * 全局 Ctrl+Shift+G「源代码管理」），Ctrl+Shift+E/F/G 由 App 全局处理，编辑器不抢。
 */
const qnKeymap: readonly KeyBinding[] = [
  { key: 'Mod-s', preventDefault: true, run: () => { getEditorHooks().onSave(); return true } },
  { key: 'Mod-g', preventDefault: true, run: gotoLine },
  { key: 'Mod-h', preventDefault: true, run: openSearchPanel },
]

export function interactiveExtensions(): Extension[] {
  return [
    history(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...qnKeymap,
      ...searchKeymap.filter((binding) => binding.key !== 'Mod-g'),
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) getEditorHooks().onChange(update.state.doc.toString())
    }),
  ]
}

export function createEditorState(doc: string, readOnly: boolean, language: Extension = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      ...coreExtensions(language),
      readOnlyCompartment.of(readOnlyExtension(readOnly)),
      ...interactiveExtensions(),
    ],
  })
}

/** 合并视图：不要文件保存快捷键与 updateListener 污染文件标签，只留基本编辑键位。 */
export function mergeExtensions(options: {
  readOnly: boolean
  language?: Extension
  onChange?: (text: string) => void
}): Extension[] {
  const { readOnly, language = [], onChange } = options
  return [
    ...coreExtensions(language),
    readOnlyExtension(readOnly),
    history(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    ...(onChange
      ? [
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString())
          }),
        ]
      : []),
  ]
}
