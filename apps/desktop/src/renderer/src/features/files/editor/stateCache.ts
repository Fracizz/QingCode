// 每个标签保留自己的 EditorState，切换标签时不丢撤销栈/光标/选区。
// hooks 用模块级动态查找：缓存的 state 在别的标签里被复用时仍能调到当前标签的回调。

import { Compartment, Transaction } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export type EditorHooks = {
  onChange: (text: string) => void
  onSave: () => void
}

let activeHooks: EditorHooks = { onChange: () => {}, onSave: () => {} }

export function setEditorHooks(hooks: EditorHooks): void {
  activeHooks = hooks
}

export function getEditorHooks(): EditorHooks {
  return activeHooks
}

/** 全局唯一的 Compartment：缓存的 state 可能由不同组件实例创建，必须共用同一身份。 */
export const languageCompartment = new Compartment()
export const readOnlyCompartment = new Compartment()

const MAX_CACHED = 32
const states = new Map<string, EditorState>()

export function getEditorState(id: string): EditorState | undefined {
  return states.get(id)
}

export function putEditorState(id: string, state: EditorState): void {
  states.delete(id)
  states.set(id, state)
  while (states.size > MAX_CACHED) {
    const oldest = states.keys().next()
    if (oldest.done) break
    states.delete(oldest.value)
  }
}

export function forgetEditorState(id: string): void {
  states.delete(id)
}

export function clearEditorStates(): void {
  states.clear()
}

/**
 * 外部重载/重新加载时同步文档：同一 EditorView 内做整篇替换，保留滚动位置并把光标夹到新文档内；
 * 不写进撤销历史（Transaction.addToHistory），避免"撤销"把磁盘版本退回旧文本。
 */
export function syncDocument(view: EditorView, doc: string): void {
  const current = view.state.doc.toString()
  if (current === doc) return
  const head = Math.min(view.state.selection.main.head, doc.length)
  const { scrollTop, scrollLeft } = view.scrollDOM
  view.dispatch({
    changes: { from: 0, to: current.length, insert: doc },
    selection: { anchor: head },
    annotations: [Transaction.addToHistory.of(false)],
  })
  view.scrollDOM.scrollTop = scrollTop
  view.scrollDOM.scrollLeft = scrollLeft
}
