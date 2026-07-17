import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { basicSetup } from 'codemirror'
import { search } from '@codemirror/search'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { createEditorFindReplacePanel } from './EditorFindReplacePanel'
import { redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import {
  AtSign,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileText,
  LocateFixed,
  Redo2,
  Save,
  Scissors,
  SquareMousePointer,
  Undo2,
} from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  copyToClipboard,
  findProjectForPath,
  formatFileReference,
} from '../utils/fileReferences'
import { THEME_SETTINGS_EVENT, getResolvedTheme } from '../lib/themeSettings'
import { translate, useI18n } from '../lib/i18n'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'

// 浅色编辑器主题：与 App.css 的 [data-theme="light"] 调色协调。
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#f0f0f0', color: '#1f1f1f' },
    '.cm-gutters': { backgroundColor: '#ebebeb', color: '#757575', borderRight: '1px solid #d0d0d0' },
    '.cm-activeLine': { backgroundColor: '#e8edf2' },
    '.cm-activeLineGutter': { backgroundColor: '#e2e8ef', color: '#1f1f1f' },
    '.cm-selectionBackground, ::selection': { backgroundColor: '#cfe3fb' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#b9d6f5',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1a1a1a' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: '#e9f5d0',
      outline: '1px solid #c2e08a',
    },
    '.cm-searchMatch': { backgroundColor: '#ffe9a8' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#ffd56b' },
  },
  { dark: false },
)

function editorThemeExtension() {
  return getResolvedTheme() === 'dark' ? oneDark : lightTheme
}

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
  // JSON5 / JSONC: JS highlighter so // and /* */ comments are allowed visually
  json5: () => javascript(),
  markdown: () => markdown(),
  css: () => css(),
  html: () => html(),
  python: () => python(),
}

function hasNonEmptySelection(view: EditorView) {
  return !view.state.selection.main.empty
}

function selectedText(view: EditorView) {
  const { from, to } = view.state.selection.main
  return view.state.sliceDoc(from, to)
}

function selectionLineRange(view: EditorView) {
  const selection = view.state.selection.main
  const startLine = view.state.doc.lineAt(selection.from).number
  const endPosition = selection.empty
    ? selection.head
    : Math.max(selection.from, selection.to - 1)
  const endLine = view.state.doc.lineAt(endPosition).number
  return { startLine, endLine }
}

export default function Editor() {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const setTabContent = useEditorStore(s => s.setTabContent)
  const markDirty = useEditorStore(s => s.markDirty)
  const saveFile = useEditorStore(s => s.saveFile)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const setView = useUIStore(s => s.setView)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

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
        search({ top: true, createPanel: createEditorFindReplacePanel }),
        themeCompartment.current.of(editorThemeExtension()),
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
                .then(() =>
                  useProjectStore.getState().pushToast('success', translate('路径已复制'))
                )
                .catch(error =>
                  useProjectStore
                    .getState()
                    .pushToast(
                      'error',
                      translate('复制路径失败: {error}', { error: String(error) })
                    )
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
              const { startLine, endLine } = selectionLineRange(view)
              const reference = formatFileReference(project, activeTab.path, startLine, endLine)
              void copyToClipboard(reference)
                .then(() =>
                  useProjectStore.getState().pushToast('success', translate('文件引用已复制'))
                )
                .catch(error =>
                  useProjectStore
                    .getState()
                    .pushToast(
                      'error',
                      translate('复制引用失败: {error}', { error: String(error) })
                    )
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

  // 主题切换时即时重配置编辑器主题（不重建 view）。
  useEffect(() => {
    const onTheme = () => {
      const view = viewRef.current
      if (view) view.dispatch({ effects: themeCompartment.current.reconfigure(editorThemeExtension()) })
    }
    window.addEventListener(THEME_SETTINGS_EVENT, onTheme)
    return () => window.removeEventListener(THEME_SETTINGS_EVENT, onTheme)
  }, [])

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
    const timer = window.setTimeout(() => {
      if (viewRef.current) viewRef.current.dispatch({ effects: clearFlashEffect.of() })
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [pendingReveal, activeTab?.path, activeTabId, clearPendingReveal])

  const copyPath = async (path: string) => {
    try {
      await copyToClipboard(path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
    }
  }

  const copyAsReference = async (path: string) => {
    const view = viewRef.current
    const projectState = useProjectStore.getState()
    const project = findProjectForPath(projectState.projects, path) ?? projectState.currentProject
    if (!project) {
      useProjectStore.getState().pushToast('error', t('无法确定该路径所属项目'))
      return
    }
    const { startLine, endLine } = view
      ? selectionLineRange(view)
      : { startLine: 1, endLine: 1 }
    const reference = formatFileReference(project, path, startLine, endLine)
    try {
      await copyToClipboard(reference)
      useProjectStore.getState().pushToast('success', t('文件引用已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制引用失败: {error}', { error: String(error) }))
    }
  }

  const revealInSidebar = (path: string) => {
    setView('explorer')
    void revealFileInTree(path)
  }

  const revealPath = async (path: string) => {
    try {
      await revealItemInDir(path)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('在文件管理器中显示失败: {error}', { error: String(error) }))
    }
  }

  const menuItems = (path: string): ContextMenuItem[] => {
    const view = viewRef.current
    const canEditSelection = !!view && hasNonEmptySelection(view)
    const canUndo = !!view && undoDepth(view.state) > 0
    const canRedo = !!view && redoDepth(view.state) > 0

    return [
      {
        label: t('剪切'),
        icon: <Scissors size={14} />,
        shortcut: 'Ctrl+X',
        disabled: !canEditSelection,
        action: async () => {
          if (!view || !hasNonEmptySelection(view)) return
          await navigator.clipboard.writeText(selectedText(view))
          view.dispatch(view.state.replaceSelection(''))
          view.focus()
        },
      },
      {
        label: t('复制'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+C',
        disabled: !canEditSelection,
        action: async () => {
          if (!view || !hasNonEmptySelection(view)) return
          await navigator.clipboard.writeText(selectedText(view))
          view.focus()
        },
      },
      {
        label: t('粘贴'),
        icon: <ClipboardPaste size={14} />,
        shortcut: 'Ctrl+V',
        disabled: !view,
        action: async () => {
          if (!view) return
          try {
            const text = await navigator.clipboard.readText()
            view.dispatch(view.state.replaceSelection(text))
            view.focus()
          } catch (error) {
            useProjectStore
              .getState()
              .pushToast('error', t('粘贴失败: {error}', { error: String(error) }))
          }
        },
      },
      {
        label: t('全选'),
        icon: <SquareMousePointer size={14} />,
        shortcut: 'Ctrl+A',
        disabled: !view,
        action: () => {
          if (!view) return
          selectAll(view)
          view.focus()
        },
      },
      {
        label: t('撤销'),
        icon: <Undo2 size={14} />,
        shortcut: 'Ctrl+Z',
        separatorBefore: true,
        disabled: !canUndo,
        action: () => {
          if (!view) return
          undo(view)
          view.focus()
        },
      },
      {
        label: t('重做'),
        icon: <Redo2 size={14} />,
        shortcut: 'Ctrl+Y',
        disabled: !canRedo,
        action: () => {
          if (!view) return
          redo(view)
          view.focus()
        },
      },
      {
        label: t('保存'),
        icon: <Save size={14} />,
        shortcut: 'Ctrl+S',
        separatorBefore: true,
        action: () => {
          if (activeTabId) void saveFile(activeTabId)
        },
      },
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        separatorBefore: true,
        action: () => copyPath(path),
      },
      {
        label: t('复制为文件引用'),
        icon: <AtSign size={14} />,
        shortcut: 'Alt+C',
        action: () => copyAsReference(path),
      },
      {
        label: t('在资源管理器中定位'),
        icon: <LocateFixed size={14} />,
        separatorBefore: true,
        action: () => revealInSidebar(path),
      },
      {
        label: t('在文件管理器中显示'),
        icon: <ExternalLink size={14} />,
        action: () => revealPath(path),
      },
    ]
  }

  const openContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    viewRef.current?.focus()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }

  if (!activeTab) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-fg-dim bg-bg gap-3">
        <FileText size={40} strokeWidth={1.2} />
        <p className="text-sm">{t('从侧边栏打开文件开始编辑')}</p>
        <p className="text-xs text-fg-dim">
          {t('Ctrl+Shift+C 路径 · Alt+C 文件引用')}
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="flex-1 overflow-hidden bg-bg" onContextMenu={openContextMenu}>
        <div ref={containerRef} className="h-full" />
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(activeTab.path)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}
