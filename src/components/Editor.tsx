import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { syncScrollTop } from '../utils/scrollSync'
import { minimalSetup } from 'codemirror'
import { search } from '@codemirror/search'
import { qingBasicSetup } from '../lib/editorBasicSetup'
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from '@codemirror/view'
import { createEditorFindReplacePanel } from './EditorFindReplacePanel'
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  AtSign,
  BookOpen,
  ClipboardPaste,
  Columns2,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  LocateFixed,
  Redo2,
  Save,
  Scissors,
  SquareMousePointer,
  Undo2,
  AlignLeft,
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
import { FOREST_THEME, forestSyntax } from '../lib/forestEditorTheme'
import {
  EDITOR_SETTINGS_EVENT,
  getEditorPreferences,
  loadEffectiveEditorPreferences,
  type EditorPreferenceSettings,
} from '../lib/editorSettings'
import { FONT_SETTINGS_EVENT, loadFontSettings } from '../lib/fontSettings'
import { buildEditorPreferenceExtensions } from '../lib/editorSettingsExtensions'
import { reliableClickMouseSelection } from '../lib/editorMouseSelection'
import {
  editorHasOccurrenceHighlight,
  occurrenceHighlightMarker,
  preserveSelectionTokenColors,
  selectionMatchMainHighlight,
} from '../lib/selectionMatchMainHighlight'
import { translate, useI18n } from '../lib/i18n'
import { notifyEditorBlur, notifyEditorContentChanged } from '../lib/autoSave'
import {
  captureEditorScroll,
  clearCachedEditorStates,
  clearTabContentBuffer,
  flushLiveEditorContent,
  getLiveEditorContent,
  isHugeDocument,
  isLargeDocument,
  registerEditorView,
  restoreEditorScroll,
  setCachedEditorState,
  takeCachedEditorState,
  unregisterEditorView,
} from '../lib/editorSession'
import { editorPerfProfileForTab, type EditorPerfProfile } from '../lib/fileSizePolicy'
import { formatDocument } from '../lib/formatDocument'
import {
  isSupportedEditorLanguage,
  loadLanguageSupport,
} from '../lib/editorLanguages'

// Drop in-memory EditorState cache after occurrence-highlight wiring changes so
// background tabs reopen with match highlighting (large/degraded included).
clearCachedEditorStates()
import { emitMinimapUpdate } from '../lib/minimapBridge'
import {
  getMinimapEnabled,
  loadEffectiveMinimapEnabled,
  migrateLegacyMinimapProjectSetting,
  MINIMAP_SETTINGS_EVENT,
} from '../lib/minimapSettings'
import { loadMinimapHideScrollbar } from '../lib/minimapPolicy'
import { isLoadingTab, isOpenErrorTab, isViewOnlyTab } from '../lib/openFileError'
import type { EditorTab } from '../types'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Kbd from './Kbd'
import MarkdownPreview from './MarkdownPreview'
import EditorOpenError from './EditorOpenError'
import LargeFileViewer from './LargeFileViewer'
import EditorMinimap from './EditorMinimap'
import Tooltip from './Tooltip'
const DiffEditor = lazy(() => import('./DiffEditor'))

// 浅色编辑器主题：与 App.css 的 [data-theme="light"] 调色协调。
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#f0f0f0', color: '#1f1f1f' },
    '.cm-gutters': { backgroundColor: '#ebebeb', color: '#757575', borderRight: '1px solid #d0d0d0' },
    '.cm-activeLine': { backgroundColor: '#e8edf2' },
    '.cm-activeLineGutter': { backgroundColor: '#e2e8ef', color: '#1f1f1f' },
    '.cm-selectionBackground': { backgroundColor: '#cfe3fb' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#b9d6f5',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1a1a1a' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: '#e9f5d0',
      outline: '1px solid #c2e08a',
    },
    '.cm-searchMatch': { backgroundColor: '#ffe9a8' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#ffd56b' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-selectionMatchMainLayer .cm-selectionMatchMain': {
      backgroundColor: 'rgba(153, 255, 119, 0.5)',
    },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  },
  { dark: false },
)

/** Selection-match colors for oneDark (main overlay + other hits). */
const darkSelectionMatchTheme = EditorView.theme(
  {
    '.cm-selectionMatch': { backgroundColor: 'rgba(153, 255, 119, 0.28)' },
    '.cm-selectionMatchMainLayer .cm-selectionMatchMain': {
      backgroundColor: 'rgba(153, 255, 119, 0.5)',
    },
    '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  },
  { dark: true },
)

function editorThemeExtension() {
  const resolved = getResolvedTheme()
  if (resolved === 'forest') return [FOREST_THEME, forestSyntax]
  if (resolved === 'dark') return [oneDark, darkSelectionMatchTheme]
  return lightTheme
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

function scheduleIdle(fn: () => void, timeoutMs = 800): () => void {
  let cancelled = false
  const run = () => {
    if (!cancelled) fn()
  }
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: timeoutMs })
    return () => {
      cancelled = true
      window.cancelIdleCallback(id)
    }
  }
  const timer = window.setTimeout(run, 0)
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}

function isMarkdownTab(tab: EditorTab | undefined | null): boolean {
  if (!tab) return false
  if (tab.language === 'markdown') return true
  return /\.md$/i.test(tab.path)
}

function plainEditorBase(showLineNumbers: boolean): Extension[] {
  return [
    highlightSpecialChars(),
    history({ minDepth: 20, newGroupDelay: 300 }),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    showLineNumbers ? lineNumbers() : [],
    keymap.of([...historyKeymap, ...defaultKeymap]),
    search({ top: true, createPanel: createEditorFindReplacePanel }),
  ]
}

function createTabEditorState(
  tab: EditorTab,
  themeCompartment: Compartment,
  languageCompartment: Compartment,
  settingsCompartment: Compartment,
  markDirty: (id: string) => void,
  saveFile: (id: string) => Promise<void>,
  setCursor: (cursor: { line: number; col: number } | null) => void,
): EditorState {
  const tabId = tab.id
  const tabPath = tab.path
  const profile: EditorPerfProfile = editorPerfProfileForTab(tab)
  const large = profile === 'full' && isLargeDocument(tab.content)
  const huge = profile !== 'full' || isHugeDocument(tab.content)
  const deferHighlight = profile === 'full' && !huge
  const initialLang: Extension = []
  const basePrefs = getEditorPreferences()
  const prefs =
    profile === 'full'
      ? basePrefs
      : { ...basePrefs, wordWrap: 'off' as const }
  const showLineNumbers = prefs.lineNumbers !== 'off'
  const settingsContent = profile === 'full' ? tab.content : undefined
  const enableBracketDecorations =
    profile === 'full' && !large && !huge && !deferHighlight

  // Own occurrence highlighter for every profile (main overlay + other hits).
  const occurrenceHighlight: Extension[] = [
    occurrenceHighlightMarker(),
    selectionMatchMainHighlight(),
  ]

  const setup: Extension[] =
    profile === 'plain'
      ? plainEditorBase(showLineNumbers)
      : profile === 'degraded' || large
        ? [
            minimalSetup,
            showLineNumbers ? lineNumbers() : [],
            search({ top: true, createPanel: createEditorFindReplacePanel }),
          ]
        : [qingBasicSetup(), search({ top: true, createPanel: createEditorFindReplacePanel })]

  return EditorState.create({
    doc: tab.content || '',
    extensions: [
      setup,
      themeCompartment.of(editorThemeExtension()),
      languageCompartment.of(initialLang),
      settingsCompartment.of(
        buildEditorPreferenceExtensions(prefs, settingsContent, {
          enableBracketDecorations,
        }),
      ),
      flashField,
      preserveSelectionTokenColors(),
      // Kept outside compartments so every profile (incl. large/degraded) gets matches.
      occurrenceHighlight,
      reliableClickMouseSelection(),
      EditorView.updateListener.of(update => {
        emitMinimapUpdate(update)
        if (update.docChanged) {
          // Avoid full-document copies into Zustand on every keystroke.
          markDirty(tabId)
          notifyEditorContentChanged(tabId)
          const pasted = update.transactions.some(tr => tr.isUserEvent('input.paste'))
          if (
            pasted &&
            profile === 'full' &&
            getEditorPreferences().formatOnPaste
          ) {
            void formatDocument(tabId, { quiet: true })
          }
        }
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head
          const line = update.state.doc.lineAt(head)
          setCursor({ line: line.number, col: head - line.from + 1 })
        }
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void saveFile(tabId)
            return true
          },
        },
        {
          key: 'Ctrl-Shift-c',
          run: () => {
            void copyToClipboard(tabPath)
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
              findProjectForPath(projectState.projects, tabPath) ??
              projectState.currentProject
            if (!project) return false
            const { startLine, endLine } = selectionLineRange(view)
            const reference = formatFileReference(project, tabPath, startLine, endLine)
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
        {
          key: 'Ctrl-Shift-v',
          run: () => {
            if (editorPerfProfileForTab(tab) !== 'full') return true
            window.dispatchEvent(new CustomEvent('qingcode:toggle-markdown-preview'))
            return true
          },
        },
        {
          key: 'Shift-Alt-f',
          run: () => {
            void formatDocument(tabId)
            return true
          },
        },
        {
          // Windows / some layouts report Alt before Shift.
          key: 'Alt-Shift-f',
          run: () => {
            void formatDocument(tabId)
            return true
          },
        },
      ]),
    ],
  })
}

function scheduleHeavyEditorFeatures(
  viewRef: RefObject<EditorView | null>,
  boundTabIdRef: RefObject<string | null>,
  tab: EditorTab,
  languageCompartment: Compartment,
  settingsCompartment: Compartment,
): () => void {
  const profile = editorPerfProfileForTab(tab)
  if (profile !== 'full' || isHugeDocument(tab.content)) return () => {}

  const tabId = tab.id
  const large = isLargeDocument(tab.content)
  const langId = tab.language

  return scheduleIdle(() => {
    const current = viewRef.current
    if (!current || boundTabIdRef.current !== tabId) return

    if (langId && isSupportedEditorLanguage(langId)) {
      void loadLanguageSupport(langId).then(lang => {
        const live = viewRef.current
        if (!live || boundTabIdRef.current !== tabId) return
        live.dispatch({ effects: languageCompartment.reconfigure(lang) })
      })
    }

    if (!large) {
      const prefs = getEditorPreferences()
      current.dispatch({
        effects: settingsCompartment.reconfigure(
          buildEditorPreferenceExtensions(prefs, tab.content, {
            enableBracketDecorations: true,
          }),
        ),
      })
    }
  })
}

function bindTabToView(
  view: EditorView,
  tab: EditorTab,
  themeCompartment: Compartment,
  languageCompartment: Compartment,
  settingsCompartment: Compartment,
  markDirty: (id: string) => void,
  saveFile: (id: string) => Promise<void>,
  setCursor: (cursor: { line: number; col: number } | null) => void,
  previousTabId: string | null,
): { tabId: string; fresh: boolean } {
  if (previousTabId && previousTabId !== tab.id) {
    captureEditorScroll(previousTabId, view)
    setCachedEditorState(previousTabId, view.state)
    flushLiveEditorContent(previousTabId)
    unregisterEditorView(previousTabId, view)
  }

  const cached = takeCachedEditorState(tab.id)
  const usableCache = cached && editorHasOccurrenceHighlight(cached) ? cached : undefined
  const fresh = !usableCache
  // Prefer live buffer when rebuilding a stale active state (keeps unsaved edits).
  const tabForState =
    !usableCache && previousTabId === null && view.state.doc.length > 0
      ? { ...tab, content: view.state.doc.toString() }
      : tab
  const priorSelection = !usableCache ? view.state.selection : null
  const state =
    usableCache ??
    createTabEditorState(
      tabForState,
      themeCompartment,
      languageCompartment,
      settingsCompartment,
      markDirty,
      saveFile,
      setCursor,
    )

  view.setState(state)
  if (priorSelection && !usableCache) {
    try {
      view.dispatch({ selection: priorSelection })
    } catch {
      /* selection may be out of range after external reload */
    }
  }
  registerEditorView(tab.id, view)
  restoreEditorScroll(tab.id, view)
  const profile = editorPerfProfileForTab(tab)
  const prefs =
    profile === 'full'
      ? getEditorPreferences()
      : { ...getEditorPreferences(), wordWrap: 'off' as const }
  const enableBracketDecorations =
    profile === 'full' &&
    !isLargeDocument(tab.content) &&
    !isHugeDocument(tab.content)
  view.dispatch({
    effects: [
      themeCompartment.reconfigure(editorThemeExtension()),
      settingsCompartment.reconfigure(
        buildEditorPreferenceExtensions(
          prefs,
          profile === 'full' ? tab.content : undefined,
          { enableBracketDecorations },
        ),
      ),
    ],
  })
  // Plain: CM owns the buffer; drop Zustand duplicate after bind.
  if (profile === 'plain' && tab.content !== undefined) {
    clearTabContentBuffer(tab.id)
  }
  return { tabId: tab.id, fresh }
}

type MdPreviewMode = 'off' | 'side' | 'preview'

export default function Editor() {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const boundTabIdRef = useRef<string | null>(null)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const settingsCompartment = useRef(new Compartment())
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const markDirty = useEditorStore(s => s.markDirty)
  const saveFile = useEditorStore(s => s.saveFile)
  const setCursor = useEditorStore(s => s.setCursor)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const currentProject = useProjectStore(s => s.currentProject)
  const setView = useUIStore(s => s.setView)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [mdPreviewMode, setMdPreviewMode] = useState<MdPreviewMode>('off')
  const [previewContent, setPreviewContent] = useState('')
  const [minimapEnabled, setMinimapEnabled] = useState(getMinimapEnabled)
  const [minimapHideScrollbar, setMinimapHideScrollbar] = useState(loadMinimapHideScrollbar)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const syncingMdScrollRef = useRef(false)
  const boundEpochRef = useRef(0)

  const activeTab = tabs.find(tab => tab.id === activeTabId)
  const pendingReveal = useEditorStore(s => s.pendingReveal)
  const clearPendingReveal = useEditorStore(s => s.clearPendingReveal)
  const showEditor =
    !!activeTab &&
    activeTab.kind !== 'diff' &&
    !isOpenErrorTab(activeTab) &&
    !isLoadingTab(activeTab) &&
    !isViewOnlyTab(activeTab)
  const activeProfile = activeTab ? editorPerfProfileForTab(activeTab) : 'full'
  const markdownTab = isMarkdownTab(activeTab) && activeProfile === 'full'
  const showPreviewPane = markdownTab && mdPreviewMode !== 'off'
  const showSourcePane = !markdownTab || mdPreviewMode !== 'preview'

  // Destroy the shared view only when leaving the editable surface (not on tab switch).
  useEffect(() => {
    if (showEditor) return
    setCursor(null)
    const view = viewRef.current
    if (!view) return
    const tabId = boundTabIdRef.current
    if (tabId) {
      captureEditorScroll(tabId, view)
      setCachedEditorState(tabId, view.state)
      flushLiveEditorContent(tabId)
      unregisterEditorView(tabId, view)
    }
    view.destroy()
    viewRef.current = null
    boundTabIdRef.current = null
  }, [showEditor, setCursor])

  // One EditorView + cached EditorState per tab (undo/selection/folds survive switches).
  useEffect(() => {
    if (!showEditor || !activeTab) return
    const host = containerRef.current
    if (!host) return

    let view = viewRef.current
    if (!view) {
      view = new EditorView({
        state: EditorState.create({ doc: '' }),
        parent: host,
      })
      viewRef.current = view
    }

    const previousTabId = boundTabIdRef.current
    const epoch = activeTab.contentEpoch ?? 0
    const staleOccurrence = !editorHasOccurrenceHighlight(view.state)
    let cancelHeavy: (() => void) | undefined
    if (previousTabId !== activeTab.id) {
      const bind = bindTabToView(
        view,
        activeTab,
        themeCompartment.current,
        languageCompartment.current,
        settingsCompartment.current,
        markDirty,
        saveFile,
        setCursor,
        previousTabId,
      )
      boundTabIdRef.current = bind.tabId
      boundEpochRef.current = epoch
      if (bind.fresh) {
        cancelHeavy = scheduleHeavyEditorFeatures(
          viewRef,
          boundTabIdRef,
          activeTab,
          languageCompartment.current,
          settingsCompartment.current,
        )
      }
    } else if (epoch !== boundEpochRef.current || staleOccurrence) {
      // External reload / draft restore, or occurrence-highlight extensions missing
      // (stale HMR / pre-fix EditorState still bound to this tab).
      boundEpochRef.current = epoch
      unregisterEditorView(activeTab.id, view)
      const bind = bindTabToView(
        view,
        activeTab,
        themeCompartment.current,
        languageCompartment.current,
        settingsCompartment.current,
        markDirty,
        saveFile,
        setCursor,
        null,
      )
      boundTabIdRef.current = bind.tabId
      cancelHeavy = scheduleHeavyEditorFeatures(
        viewRef,
        boundTabIdRef,
        activeTab,
        languageCompartment.current,
        settingsCompartment.current,
      )
    }

    return () => {
      cancelHeavy?.()
    }
    // Recreate/swap only when the tab identity / epoch / loadability changes — not on content flushes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showEditor,
    activeTabId,
    activeTab?.loading,
    activeTab?.openError,
    activeTab?.viewMode,
    activeTab?.contentEpoch,
    markDirty,
    saveFile,
    setCursor,
  ])

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
    void loadEffectiveEditorPreferences(currentProject)
    void import('../lib/fileSizeSettings').then(m =>
      m.loadEffectiveFileSizePreferences(currentProject),
    )
    void import('../lib/formatOnSaveSettings').then(m =>
      m.loadEffectiveFormatOnSave(currentProject),
    )
    void migrateLegacyMinimapProjectSetting(currentProject).finally(() => {
      void loadEffectiveMinimapEnabled(currentProject)
    })
    void import('../lib/terminalScrollbackSettings').then(m =>
      m.loadEffectiveTerminalScrollback(currentProject),
    )
    void import('../lib/terminalCursorSettings').then(m =>
      m.loadEffectiveTerminalCursorBlinking(currentProject),
    )
  }, [currentProject?.id])

  useEffect(() => {
    const onMinimap = (event: Event) => {
      setMinimapEnabled((event as CustomEvent<boolean>).detail === true)
    }
    window.addEventListener(MINIMAP_SETTINGS_EVENT, onMinimap)
    return () => window.removeEventListener(MINIMAP_SETTINGS_EVENT, onMinimap)
  }, [])

  useEffect(() => {
    const apply = (prefs?: EditorPreferenceSettings) => {
      const view = viewRef.current
      if (!view) return
      const tab = useEditorStore.getState().tabs.find(t => t.id === boundTabIdRef.current)
      const profile = tab ? editorPerfProfileForTab(tab) : 'full'
      const next =
        profile === 'full'
          ? (prefs ?? getEditorPreferences())
          : { ...(prefs ?? getEditorPreferences()), wordWrap: 'off' as const }
      const enableBracketDecorations =
        profile === 'full' &&
        !isLargeDocument(tab?.content) &&
        !isHugeDocument(tab?.content)
      view.dispatch({
        effects: settingsCompartment.current.reconfigure(
          buildEditorPreferenceExtensions(
            next,
            profile === 'full' ? tab?.content : undefined,
            { enableBracketDecorations },
          ),
        ),
      })
    }
    const onSettings = (event: Event) => {
      apply((event as CustomEvent<EditorPreferenceSettings>).detail)
    }
    const onFontSettings = () => {
      const view = viewRef.current
      if (!view) return
      // CSS/localStorage update precedes the async prefs-cache write.
      apply({ ...getEditorPreferences(), fontSize: loadFontSettings().editorFontSize })
      view.requestMeasure()
    }
    window.addEventListener(EDITOR_SETTINGS_EVENT, onSettings)
    window.addEventListener(FONT_SETTINGS_EVENT, onFontSettings)
    return () => {
      window.removeEventListener(EDITOR_SETTINGS_EVENT, onSettings)
      window.removeEventListener(FONT_SETTINGS_EVENT, onFontSettings)
    }
  }, [])

  useEffect(() => {
    if (!showPreviewPane || !activeTab) {
      setPreviewContent('')
      return
    }
    const sync = () => {
      setPreviewContent(getLiveEditorContent(activeTab.id) ?? activeTab.content ?? '')
    }
    sync()
    const timer = window.setInterval(sync, 400)
    return () => window.clearInterval(timer)
  }, [showPreviewPane, activeTab?.id, activeTab?.content, activeTab?.dirty])

  // Side-by-side Markdown: keep editor ↔ preview vertical scroll in sync.
  useEffect(() => {
    if (mdPreviewMode !== 'side' || !showSourcePane || !showPreviewPane) return
    const view = viewRef.current
    const preview = previewScrollRef.current
    if (!view || !preview) return

    const syncFrom = (source: HTMLElement, target: HTMLElement) => {
      if (syncingMdScrollRef.current) return
      syncingMdScrollRef.current = true
      syncScrollTop(source, target)
      requestAnimationFrame(() => {
        syncingMdScrollRef.current = false
      })
    }

    const onEditorScroll = () => syncFrom(view.scrollDOM, preview)
    const onPreviewScroll = () => syncFrom(preview, view.scrollDOM)

    view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })
    return () => {
      view.scrollDOM.removeEventListener('scroll', onEditorScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
    }
  }, [mdPreviewMode, showSourcePane, showPreviewPane, activeTabId, previewContent])

  useEffect(() => {
    if (!markdownTab) setMdPreviewMode('off')
  }, [markdownTab, activeTabId])

  useEffect(() => {
    const onToggle = () => {
      const tab = useEditorStore
        .getState()
        .tabs.find(t => t.id === useEditorStore.getState().activeTabId)
      if (!isMarkdownTab(tab) || !tab || editorPerfProfileForTab(tab) !== 'full') return
      setMdPreviewMode(mode => (mode === 'off' ? 'side' : mode === 'side' ? 'preview' : 'off'))
    }
    window.addEventListener('qingcode:toggle-markdown-preview', onToggle)
    return () => window.removeEventListener('qingcode:toggle-markdown-preview', onToggle)
  }, [])

  useEffect(() => {
    if (!viewRef.current || !activeTab || isOpenErrorTab(activeTab) || isLoadingTab(activeTab) || !pendingReveal) return
    if (pendingReveal.path !== activeTab.path) return
    const doc = viewRef.current.state.doc
    const lineNum = Math.min(Math.max(1, pendingReveal.line), doc.lines)
    const line = doc.line(lineNum)
    const pos =
      typeof pendingReveal.from === 'number'
        ? Math.min(Math.max(0, pendingReveal.from), doc.length)
        : line.from
    viewRef.current.dispatch({
      effects: [
        EditorView.scrollIntoView(pos, { y: 'center' }),
        flashLineEffect.of(lineNum),
      ],
      selection: { anchor: pos },
    })
    viewRef.current.focus()
    clearPendingReveal()
    const timer = window.setTimeout(() => {
      if (viewRef.current) viewRef.current.dispatch({ effects: clearFlashEffect.of() })
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [pendingReveal, activeTab?.path, activeTabId, clearPendingReveal, activeTab])

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
    void revealFileInTree(path, { force: true })
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
        label: t('格式化文档'),
        icon: <AlignLeft size={14} />,
        shortcut: 'Shift+Alt+F',
        action: () => {
          if (activeTabId) void formatDocument(activeTabId)
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
      ...(markdownTab
        ? [
            {
              label: t('切换 Markdown 预览'),
              icon: <BookOpen size={14} />,
              shortcut: 'Ctrl+Shift+V',
              separatorBefore: true,
              action: () =>
                setMdPreviewMode(mode =>
                  mode === 'off' ? 'side' : mode === 'side' ? 'preview' : 'off',
                ),
            } satisfies ContextMenuItem,
          ]
        : []),
    ]
  }

  const openContextMenu = (event: ReactMouseEvent) => {
    // Minimap owns its own menu; do not steal right-clicks from that overlay.
    if ((event.target as Element | null)?.closest?.('.editor-minimap')) {
      event.preventDefault()
      return
    }
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
        <p className="text-xs text-fg-dim flex items-center gap-1.5">
          <Kbd>Ctrl+Shift+C</Kbd> {t('路径')} <span>·</span> <Kbd>Alt+C</Kbd> {t('文件引用')}
        </p>
      </div>
    )
  }

  if (activeTab.kind === 'diff') {
    return (
      <Suspense fallback={<div className="flex-1 bg-bg" aria-hidden="true" />}>
        <DiffEditor tab={activeTab} />
      </Suspense>
    )
  }

  if (isOpenErrorTab(activeTab)) {
    return <EditorOpenError tab={activeTab} />
  }

  if (isViewOnlyTab(activeTab)) {
    return <LargeFileViewer tab={activeTab} />
  }

  if (isLoadingTab(activeTab)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-bg text-fg-muted">
        <LoaderCircle size={28} className="animate-spin text-accent" aria-hidden />
        <p className="text-sm">{t('正在打开文件…')}</p>
        <Tooltip
          label={activeTab.path}
          side="bottom"
          onlyWhenOverflow
          wrapperClassName="max-w-md block px-6"
        >
          <p className="truncate font-mono text-[11px] text-fg-dim">{activeTab.path}</p>
        </Tooltip>
      </div>
    )
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
        {markdownTab && (
          <div className="flex h-8 flex-shrink-0 items-center gap-1 border-b border-border px-2">
            <span className="mr-1 text-[11px] text-fg-dim">{t('Markdown')}</span>
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                mdPreviewMode === 'off'
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
              onClick={() => setMdPreviewMode('off')}
            >
              <FileText size={12} />
              {t('编辑')}
            </button>
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                mdPreviewMode === 'side'
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
              onClick={() => setMdPreviewMode('side')}
            >
              <Columns2 size={12} />
              {t('并排预览')}
            </button>
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                mdPreviewMode === 'preview'
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
              onClick={() => setMdPreviewMode('preview')}
            >
              <BookOpen size={12} />
              {t('预览')}
            </button>
            <span className="ml-auto"><Kbd>Ctrl+Shift+V</Kbd></span>
          </div>
        )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={`${showSourcePane ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col overflow-hidden`}
            onContextMenu={openContextMenu}
          >
            <div
              className={`editor-pane flex-1 min-h-0 overflow-hidden${
                minimapEnabled && showSourcePane && minimapHideScrollbar
                  ? ' editor-pane--minimap-hide-scrollbar'
                  : ''
              }`}
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  if (activeTabId) flushLiveEditorContent(activeTabId)
                  notifyEditorBlur()
                }
              }}
            >
              <div ref={containerRef} className="editor-pane__host" />
              {minimapEnabled && showSourcePane && (
                <EditorMinimap
                  viewRef={viewRef}
                  tabId={activeTabId}
                  fileSize={activeTab?.fileSize}
                  onHideScrollbarChange={setMinimapHideScrollbar}
                />
              )}
            </div>
          </div>
          {showPreviewPane && (
            <div
              className={`min-w-0 flex-1 overflow-hidden border-border ${
                showSourcePane ? 'border-l' : ''
              }`}
            >
              <MarkdownPreview ref={previewScrollRef} content={previewContent} />
            </div>
          )}
        </div>
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
