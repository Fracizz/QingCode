import { useEffect, useRef, type RefObject } from 'react'
import { LockKeyhole } from 'lucide-react'
import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import { useSetting } from '../../settings/settingsStore'
import { cn } from '../../../lib/cn'
import { readOnlyLabel, readOnlyReason } from '../editModel'
import { loadedLabel } from '../filesModel'
import type { Tab } from '../filesModel'
import { createEditorState, readOnlyExtension } from './extensions'
import { loadLanguageForPath } from './languages'
import {
  getEditorState,
  languageCompartment,
  putEditorState,
  readOnlyCompartment,
  setEditorHooks,
  syncDocument,
} from './stateCache'

type Props = {
  viewRef: RefObject<EditorView | null>
  tab: Tab
  onChange: (text: string) => void
  onSave: () => void
  onLoadMore: () => void
  className?: string
}

/**
 * 受控文档但保留每个标签自己的 EditorState：切换标签时销毁 DOM、缓存 state，
 * 回来时连同撤销栈、选区一起恢复；外部重载用整篇替换，滚动位置不动。
 */
export function CodeEditor({ viewRef, tab, onChange, onSave, onLoadMore, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fontSize = useSetting((settings) => settings.general.editorFontSize)
  const jumped = useRef<string | null>(null)
  const reason = readOnlyReason(tab)
  const readOnly = reason !== null

  // 缓存 state 里的扩展只能动态取 hooks，否则切回旧标签会调到创建时那个标签的回调。
  setEditorHooks({ onChange, onSave })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const state = getEditorState(tab.id) ?? createEditorState(tab.content, readOnly)
    const view = new EditorView({ state, parent: host })
    viewRef.current = view

    let alive = true
    void loadLanguageForPath(tab.path).then((language) => {
      if (!alive || viewRef.current !== view) return
      view.dispatch({ effects: languageCompartment.reconfigure(language) })
    })

    return () => {
      alive = false
      putEditorState(tab.id, view.state)
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // 只在标签切换时重建视图；其余变化通过 compartment / 事务同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  useEffect(() => viewRef.current?.requestMeasure(), [fontSize])

  useEffect(() => {
    const view = viewRef.current
    if (view) view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtension(readOnly)) })
  }, [readOnly, tab.id])

  useEffect(() => {
    const view = viewRef.current
    if (view) syncDocument(view, tab.content)
  }, [tab.content, tab.id])

  useEffect(() => {
    const line = tab.line
    if (!line) return
    const key = `${tab.id}:${line}:${tab.column ?? ''}`
    if (jumped.current === key) return
    const view = viewRef.current
    if (!view) return
    const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines))
    const pos = Math.min(target.from + Math.max(0, (tab.column ?? 1) - 1), target.to)
    jumped.current = key
    view.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
      annotations: [Transaction.addToHistory.of(false)],
    })
  }, [tab.id, tab.line, tab.column, tab.content])

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div ref={hostRef} className="qn-editor-host min-h-0 flex-1 overflow-hidden bg-qn-code" />
      {readOnly && (
        <div className="pointer-events-none absolute right-3 top-2 inline-flex items-center gap-1 rounded-md bg-qn-panel/90 px-1.5 py-0.5 text-ui-xs text-qn-muted">
          <LockKeyhole size={11} />
          只读 · {readOnlyLabel(reason)}
        </div>
      )}
      {tab.truncated && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-qn-border px-3 py-1.5 text-ui-sm text-qn-muted">
          <span>{loadedLabel(tab.loadedBytes)} · 只读</span>
          <button
            type="button"
            className="rounded-md px-2 py-0.5 text-qn-accent hover:bg-qn-hover disabled:opacity-50"
            disabled={tab.busy}
            onClick={onLoadMore}
          >
            {tab.busy ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  )
}
