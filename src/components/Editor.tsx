import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { THEME_SETTINGS_EVENT } from '../lib/themeSettings'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import {
  copyToClipboard,
  findProjectForPath,
  formatFileReference,
} from '../utils/fileReferences'
import { FileText } from 'lucide-react'

const flashLineEffect = StateEffect.define<number>()
const clearFlashEffect = StateEffect.define<void>()

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        const lines = tr.state.doc.lines
        const n = Math.min(Math.max(1, e.value), lines)
        const line = tr.state.doc.line(n)
        return Decoration.set([Decoration.mark({ class: 'cm-search-reveal-flash' }).range(line.from, line.to)])
      }
      if (e.is(clearFlashEffect)) {
        return Decoration.none
      }
    }
    return value
  },
  provide: f => EditorView.decorations.from(f),
})

const LANG_MAP: Record<string, () => import('@codemirror/language').LanguageSupport> = {
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  markdown: () => markdown(),
  css: () => css(),
  html: () => html(),
  python: () => python(),
}

export default function Editor() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const setTabContent = useEditorStore(s => s.setTabContent)
  const markDirty = useEditorStore(s => s.markDirty)
  const saveFile = useEditorStore(s => s.saveFile)

  const activeTab = tabs.find(t => t.id === activeTabId)
  const pendingReveal = useEditorStore(s => s.pendingReveal)
  const clearPendingReveal = useEditorStore(s => s.clearPendingReveal)

  useEffect(() => {
    if (!containerRef.current) return
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }
    if (!activeTab) return

    const langSupport = activeTab.language ? LANG_MAP[activeTab.language]?.() : undefined

    const state = EditorState.create({
      doc: activeTab.content || '',
      extensions: [
        basicSetup,
        oneDark,
        langSupport ?? [],
        flashField,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            setTabContent(activeTab.id, update.state.doc.toString())
            markDirty(activeTab.id)
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              saveFile(activeTab.id)
              return true
            },
          },
          {
            key: 'Ctrl-Shift-c',
            run: () => {
              void copyToClipboard(activeTab.path)
                .then(() => useProjectStore.getState().pushToast('success', '文件路径已复制'))
                .catch(error =>
                  useProjectStore.getState().pushToast('error', `复制路径失败: ${String(error)}`)
                )
              return true
            },
          },
          {
            key: 'Alt-c',
            run: view => {
              const projectState = useProjectStore.getState()
              const project =
                findProjectForPath(projectState.projects, activeTab.path) ??
                projectState.currentProject
              if (!project) return false
              const selection = view.state.selection.main
              const startLine = view.state.doc.lineAt(selection.from).number
              const endPosition = selection.empty
                ? selection.head
                : Math.max(selection.from, selection.to - 1)
              const endLine = view.state.doc.lineAt(endPosition).number
              const reference = formatFileReference(project, activeTab.path, startLine, endLine)
              void copyToClipboard(reference)
                .then(() =>
                  useProjectStore.getState().pushToast('success', `文件引用已复制: ${reference}`)
                )
                .catch(error =>
                  useProjectStore.getState().pushToast('error', `复制引用失败: ${String(error)}`)
                )
              return true
            },
          },
        ]),
        EditorView.lineWrapping,
      ],
    })

    viewRef.current = new EditorView({ state, parent: containerRef.current })

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId])

  useEffect(() => {
    if (!viewRef.current || !activeTab || !pendingReveal) return
    if (pendingReveal.path !== activeTab.path) return
    const lineNum = Math.min(
      Math.max(1, pendingReveal.line),
      viewRef.current.state.doc.lines
    )
    const line = viewRef.current.state.doc.line(lineNum)
    viewRef.current.dispatch({
      effects: [
        EditorView.scrollIntoView(line.from, { y: 'center' }),
        flashLineEffect.of(lineNum),
      ],
      selection: { anchor: line.from },
    })
    viewRef.current.focus()
    clearPendingReveal()
    const t = window.setTimeout(() => {
      if (viewRef.current) viewRef.current.dispatch({ effects: clearFlashEffect.of() })
    }, 1200)
    return () => window.clearTimeout(t)
  }, [pendingReveal, activeTab?.path, activeTabId, clearPendingReveal])

  if (!activeTab) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-fg-dim bg-bg gap-3">
        <FileText size={40} strokeWidth={1.2} />
        <p className="text-sm">Open a file from the sidebar to start editing</p>
        <p className="text-xs text-fg-dim">Ctrl + Shift + C 复制文件路径</p>
        <p className="text-xs text-fg-dim">Alt + C 复制引用，例如 @web/src/app.vue#L70</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden bg-bg">
      <div ref={containerRef} className="h-full" />
    </div>
  )
}
