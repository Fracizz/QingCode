import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Clock, FileText, FolderOpen, Settings, Terminal as TerminalIcon } from 'lucide-react'
import './App.css'
import ActivityBar from './components/ActivityBar'
import AppIcon from './components/AppIcon'
import Sidebar from './components/Sidebar'
import EditorTabs from './components/EditorTabs'
import TerminalTabs from './components/TerminalTabs'
import StatusBar from './components/StatusBar'
import TitleBar from './components/TitleBar'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import ChoiceDialog from './components/ChoiceDialog'
import PromptDialog from './components/PromptDialog'
import CommandPalette from './components/CommandPalette'
import SymbolPicker from './components/SymbolPicker'
import FileCompareDialog from './components/FileCompareDialog'
import { useTerminalStore } from './store/terminalStore'
import { useProjectStore } from './store/projectStore'
import { useEditorStore } from './store/editorStore'
import { useUIStore } from './store/uiStore'
import { useCompareStore } from './store/compareStore'
import { useCommandPaletteStore } from './store/commandPaletteStore'
import { useSymbolPickerStore } from './store/symbolPickerStore'
import { isTauri } from './lib/tauri'
import ResizableSidebar from './components/ResizableSidebar'
import { startSystemThemeListener } from './lib/themeSettings'
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from './lib/sidebarLayout'
import {
  getTerminalMaxHeight,
  TERMINAL_MIN_HEIGHT,
  terminalResizerHint,
} from './lib/panelLayout'
import PanelResizer from './components/PanelResizer'
import { beginPanelResize, endPanelResize } from './lib/panelResize'
import { dismissStartupSplash } from './lib/startupSplash'
import { migrateLegacySettings } from './lib/migrateLegacySettings'
import { listenForOpenFileRequests, openLaunchFiles } from './lib/launchFiles'
import { useI18n } from './lib/i18n'
import { formatDocument } from './lib/formatDocument'
import { isShortcutInputTarget, shortcutMatchesEvent } from './lib/shortcuts'
import { useShortcutStore } from './store/shortcutStore'
import { useAutoSave } from './hooks/useAutoSave'
import { useFileWatcher } from './hooks/useFileWatcher'
import { useDraftRecovery } from './hooks/useDraftRecovery'
import {
  markWorkspaceSessionPersistReady,
  pruneWorkspaceSessions,
} from './lib/workspaceSessionSync'
import {
  isProjectRestricted,
  isProjectTrusted,
  trustProject,
  pushTrustedRootsToNative,
  WORKSPACE_TRUST_CHANGED_EVENT,
} from './lib/workspaceTrust'

const Editor = lazy(() => import('./components/Editor'))
const TerminalView = lazy(() => import('./components/Terminal'))
const SearchPanel = lazy(() => import('./components/SearchPanel'))
const SourceControlPanel = lazy(() => import('./components/SourceControlPanel'))
const RunPanel = lazy(() => import('./components/RunPanel'))
const ProjectManager = lazy(() => import('./components/ProjectManager'))
const WorkspaceManager = lazy(() => import('./components/WorkspaceManager'))
const SettingsEditor = lazy(() => import('./components/SettingsEditor'))

migrateLegacySettings()

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
}

/** Lightweight empty editor so CodeMirror is not downloaded until a file is opened. */
function EmptyEditor() {
  const { t } = useI18n()
  const recentFiles = useProjectStore(s => s.recentFiles)
  const projects = useProjectStore(s => s.projects)
  const switchProject = useProjectStore(s => s.switchProject)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const openFile = useEditorStore(s => s.openFile)
  const setView = useUIStore(s => s.setView)
  const openTerminalPanel = useUIStore(s => s.openTerminalPanel)
  const recent = recentFiles.slice(0, 8)
  const recentProjects = projects.filter(p => !p.hidden).slice(0, 5)

  const actions = [
    {
      icon: <FolderOpen size={14} />,
      label: t('打开项目'),
      onClick: () => void addProjectFromDialog(),
    },
    {
      icon: <TerminalIcon size={14} />,
      label: t('打开终端面板'),
      onClick: openTerminalPanel,
    },
    {
      icon: <Settings size={14} />,
      label: t('打开设置'),
      onClick: () => setView('settings'),
    },
  ]

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fg-dim bg-bg gap-5 px-6 select-none">
      <div className="flex flex-col items-center gap-2">
        <AppIcon size={48} />
        <p className="text-sm text-fg-muted">{t('从侧边栏打开文件开始编辑')}</p>
      </div>

      <div className="flex items-center gap-2">
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1.5 rounded border border-border-strong bg-bg-elevated px-3 py-1.5 text-[13px] text-fg-muted transition-colors hover:bg-bg-active hover:text-fg"
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>

      {recentProjects.length > 0 && (
        <div className="flex flex-col items-center gap-1.5">
          <p className="text-[11px] font-semibold tracking-wide text-fg-dim">{t('最近项目')}</p>
          <div className="flex flex-wrap items-center justify-center gap-1.5 max-w-[420px]">
            {recentProjects.map(project => (
              <button
                key={project.id}
                type="button"
                title={project.path}
                onClick={() => void switchProject(project)}
                className="max-w-[180px] truncate rounded-full border border-border px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-fg"
              >
                {project.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-fg-dim">{t('Ctrl+Shift+C 路径 · Alt+C 文件引用')}</p>
      {recent.length > 0 && (
        <div className="mt-2 w-full max-w-md">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            <Clock size={12} />
            {t('最近打开的文件')}
          </div>
          <ul className="space-y-0.5">
            {recent.map(file => (
              <li key={file.path}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg transition-colors"
                  onClick={() => void openFile(file.path)}
                  title={file.path}
                >
                  <FileText size={12} className="flex-shrink-0 opacity-70" />
                  <span className="truncate font-medium text-fg">
                    {file.path.split(/[/\\]/).pop() || file.path}
                  </span>
                  <span className="ml-auto truncate text-[11px] text-fg-dim max-w-[55%]">
                    {file.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Run after first paint / idle so project switch is not blocked by heavy work (e.g. PTY). */
function scheduleDeferredWork(fn: () => void, timeoutMs = 600): () => void {
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

const TERMINAL_PANEL_KEY = 'qingcode:terminal-panel'

function loadTerminalPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(TERMINAL_PANEL_KEY) ?? '{}') as {
      open?: boolean
      height?: number
    }
    const maxH = getTerminalMaxHeight()
    return {
      open: value.open ?? true,
      height: Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, value.height ?? 260)),
    }
  } catch {
    return { open: true, height: 260 }
  }
}

function App() {
  const { t } = useI18n()
  const initialTerminalPanel = useRef(loadTerminalPanelState()).current
  const initialSidebarWidth = useRef(loadSidebarWidth()).current
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const addTerminal = useTerminalStore(s => s.addTerminal)
  const activateProject = useTerminalStore(s => s.activateProject)
  const spawnRestoredTerminals = useTerminalStore(s => s.spawnRestoredTerminals)
  const initializeTerminalEvents = useTerminalStore(s => s.initializeTerminalEvents)
  const loadMissingTabContents = useEditorStore(s => s.loadMissingTabContents)
  const currentProject = useProjectStore(s => s.currentProject)
  const projects = useProjectStore(s => s.projects)
  const loadProjects = useProjectStore(s => s.loadProjects)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const [trustTick, setTrustTick] = useState(0)
  useEffect(() => {
    const sync = () => setTrustTick(n => n + 1)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
    return () => window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
  }, [])
  const projectRestricted =
    trustTick >= 0 &&
    !!currentProject &&
    !currentProject.ephemeral &&
    isProjectRestricted(currentProject)
  const projectTrusted =
    trustTick >= 0 &&
    !!currentProject &&
    (currentProject.ephemeral || isProjectTrusted(currentProject))
  const activeTabId = useEditorStore(s => s.activeTabId)
  const view = useUIStore(s => s.view)
  const sidebarOpen = useUIStore(s => s.sidebarOpen)
  const setView = useUIStore(s => s.setView)
  const toggleActivityView = useUIStore(s => s.toggleActivityView)
  const terminalOpenSignal = useUIStore(s => s.terminalOpenSignal)
  const terminalToggleSignal = useUIStore(s => s.terminalToggleSignal)
  const projectManagerOpen = useUIStore(s => s.projectManagerOpen)
  const workspaceManagerOpen = useUIStore(s => s.workspaceManagerOpen)
  const openProjectManager = useUIStore(s => s.openProjectManager)
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const togglePalette = useCommandPaletteStore(s => s.togglePalette)
  const openSymbolPicker = useSymbolPickerStore(s => s.openPicker)

  useAutoSave()
  useDraftRecovery()
  useFileWatcher()
  const fileCompare = useCompareStore(s => s.request)

  const [terminalOpen, setTerminalOpen] = useState(initialTerminalPanel.open)
  const [terminalHeight, setTerminalHeight] = useState(initialTerminalPanel.height)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth)
  const [isTerminalResizing, setIsTerminalResizing] = useState(false)
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null)
  const [projectsReady, setProjectsReady] = useState(false)

  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragStateRef.current = { startY: e.clientY, startH: terminalHeight }
      setIsTerminalResizing(true)
      const onMove = (ev: MouseEvent) => {
        const st = dragStateRef.current
        if (!st) return
        const maxH = getTerminalMaxHeight()
        const next = Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, st.startH - (ev.clientY - st.startY)))
        setTerminalHeight(next)
      }
      const onUp = () => {
        dragStateRef.current = null
        setIsTerminalResizing(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        endPanelResize('horizontal')
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      beginPanelResize('horizontal')
    },
    [terminalHeight]
  )

  useEffect(() => {
    let cancelled = false
    void loadProjects().then(() => {
      if (cancelled) return
      markWorkspaceSessionPersistReady()
      setProjectsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [loadProjects])

  useEffect(() => {
    if (!projectsReady) return
    pruneWorkspaceSessions(new Set(projects.map(p => p.id)))
  }, [projectsReady, projects])

  useEffect(() => {
    startSystemThemeListener()
    dismissStartupSplash()
  }, [])

  // Explorer "Open with" / CLI file paths — open after first paint.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listenForOpenFileRequests().then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })
    void openLaunchFiles()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      TERMINAL_PANEL_KEY,
      JSON.stringify({ open: terminalOpen, height: terminalHeight })
    )
  }, [terminalOpen, terminalHeight])

  useEffect(() => {
    saveSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  // Open the terminal panel when something (e.g. a run config) signals it.
  useEffect(() => {
    if (terminalOpenSignal > 0) setTerminalOpen(true)
  }, [terminalOpenSignal])

  useEffect(() => {
    if (terminalToggleSignal > 0) setTerminalOpen(open => !open)
  }, [terminalToggleSignal])

  useEffect(() => {
    const onResize = () => setSidebarWidth(w => clampSidebarWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    initializeTerminalEvents().then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [initializeTerminalEvents])

  useEffect(() => {
    const isCommandPaletteShortcut = (event: KeyboardEvent) => {
      if (shortcutMatchesEvent(shortcuts.openCommandPalette, event)) return true
      // Cmd+Shift+P on macOS when the remappable binding remains Ctrl+Shift+P.
      return (
        shortcuts.openCommandPalette === 'Ctrl+Shift+P' &&
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'p'
      )
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Available from inputs / terminal so the palette stays globally discoverable.
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault()
        togglePalette()
        return
      }

      if (isShortcutInputTarget(event.target)) return
      if (shortcutMatchesEvent(shortcuts.goToSymbolInEditor, event)) {
        event.preventDefault()
        openSymbolPicker()
      } else if (shortcutMatchesEvent(shortcuts.searchAllProjects, event)) {
        event.preventDefault()
        useUIStore.getState().requestGlobalSearch()
      } else if (shortcutMatchesEvent(shortcuts.toggleTerminal, event)) {
        event.preventDefault()
        useUIStore.getState().requestToggleTerminal()
      } else if (shortcutMatchesEvent(shortcuts.openSettings, event)) {
        event.preventDefault()
        setView('settings')
      } else if (shortcutMatchesEvent('Shift+Alt+F', event)) {
        // Editor keymap owns the shortcut inside CodeMirror; skip terminal focus.
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('.cm-editor, .xterm')
        ) {
          return
        }
        event.preventDefault()
        void formatDocument()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [shortcuts, setView, togglePalette, openSymbolPicker])

  const tabsNeedContentLoad = useEditorStore(s =>
    s.tabs.some(
      t => !t.openError && !t.loading && (t.content === undefined || t.diskMtime === undefined),
    ),
  )

  // After project session restore, load disk (or keep draft) bodies for open tabs.
  useEffect(() => {
    if (!currentProject || !tabsNeedContentLoad) return
    void loadMissingTabContents()
  }, [currentProject?.id, tabsNeedContentLoad, loadMissingTabContents])

  // Ensure the current project has at least one terminal, and that the active
  // terminal belongs to the current project. Defer PTY spawn so first project
  // paint is not blocked by PowerShell / ConPTY startup; skip entirely while
  // the terminal panel is closed or the workspace is restricted.
  const projectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  useEffect(() => {
    if (!currentProject || !projectTrusted) return
    const projectId = currentProject.id
    const projectPath = currentProject.path
    if (useTerminalStore.getState().terminals.some(t => t.projectId === projectId)) {
      activateProject(projectId)
      if (terminalOpen) {
        return scheduleDeferredWork(() => {
          void spawnRestoredTerminals(projectId)
        })
      }
      return
    }
    if (!terminalOpen) return
    return scheduleDeferredWork(() => {
      if (useTerminalStore.getState().terminals.some(t => t.projectId === projectId)) {
        activateProject(projectId)
        void spawnRestoredTerminals(projectId)
        return
      }
      void addTerminal(projectPath, projectId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, terminalOpen, projectTrusted])

  const handleAddProject = () => {
    setView('explorer')
    addProjectFromDialog()
  }

  const inTauri = isTauri()

  return (
    <div className="h-screen flex flex-col bg-bg text-fg">
      <TitleBar />
      {!inTauri && (
        <div className="flex-shrink-0 px-4 py-2 text-[12px] leading-relaxed bg-amber-500/10 border-b border-amber-500/30 text-amber-200">
          {t('当前为浏览器预览模式，项目、文件、终端等功能不可用。请使用')}{' '}
          <code className="px-1 py-0.5 rounded bg-black/20">pnpm tauri dev</code>{' '}
          {t('启动，并在弹出的桌面窗口中操作。')}
        </div>
      )}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        <div className="flex flex-1 min-h-0 overflow-hidden">
        <ActivityBar
          active={view}
          sidebarOpen={sidebarOpen}
          onActiveChange={toggleActivityView}
          onToggleTerminal={() => setTerminalOpen(v => !v)}
          onAddProject={handleAddProject}
          onManageProjects={openProjectManager}
          terminalOpen={terminalOpen}
        />

        {sidebarOpen && view === 'explorer' && (
          <ResizableSidebar width={sidebarWidth} onWidthChange={setSidebarWidth}>
            <Sidebar />
          </ResizableSidebar>
        )}

        {sidebarOpen && view === 'search' && (
          <ResizableSidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            className="ui-font-scaled"
          >
            <Suspense fallback={<LazyFallback className="h-full bg-bg-sidebar" />}>
              <SearchPanel />
            </Suspense>
          </ResizableSidebar>
        )}

        {sidebarOpen && view === 'sourceControl' && (
          <ResizableSidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            className="ui-font-scaled bg-bg-sidebar"
          >
            <Suspense fallback={<LazyFallback className="h-full bg-bg-sidebar" />}>
              <SourceControlPanel />
            </Suspense>
          </ResizableSidebar>
        )}

        {sidebarOpen && view === 'run' && (
          <ResizableSidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            className="ui-font-scaled bg-bg-sidebar"
          >
            <Suspense fallback={<LazyFallback className="h-full bg-bg-sidebar" />}>
              <RunPanel />
            </Suspense>
          </ResizableSidebar>
        )}

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {view === 'settings' ? (
            <Suspense fallback={<LazyFallback />}>
              <SettingsEditor />
            </Suspense>
          ) : (
            <>
              <EditorTabs />
              {projectRestricted && currentProject && (
                <div className="flex-shrink-0 flex items-center gap-3 px-3 py-1.5 text-[12px] bg-amber-500/10 border-b border-amber-500/30 text-amber-100">
                  <span className="min-w-0 flex-1">
                    {t('受限模式：只能浏览文件，无法编辑、使用终端或运行脚本。')}
                  </span>
                  <button
                    type="button"
                    className="flex-shrink-0 px-2 py-0.5 rounded bg-accent/90 hover:bg-accent text-white text-[12px]"
                    onClick={() => {
                      trustProject(currentProject)
                      void pushTrustedRootsToNative(projects)
                    }}
                  >
                    {t('信任此项目')}
                  </button>
                </div>
              )}
              {activeTabId ? (
                <Suspense fallback={<LazyFallback />}>
                  <Editor />
                </Suspense>
              ) : (
                <EmptyEditor />
              )}
            </>
          )}
        </div>
        </div>

        {terminalOpen && (
          <PanelResizer
            orientation="horizontal"
            active={isTerminalResizing}
            tooltip={terminalResizerHint(terminalHeight)}
            tooltipSide="top"
            onMouseDown={onResizerMouseDown}
            ariaValueNow={terminalHeight}
            ariaValueMin={TERMINAL_MIN_HEIGHT}
            ariaValueMax={getTerminalMaxHeight()}
          />
        )}

        <div
          className={`${terminalOpen ? 'flex' : 'hidden'} flex-col flex-shrink-0 min-h-0 overflow-hidden border-t border-border`}
          style={{ height: terminalHeight }}
        >
          <TerminalTabs />
          <div className="relative flex-1 min-w-0 bg-bg-deep overflow-hidden min-h-0">
            {projectTerminals.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-fg-dim text-sm">
                {currentProject
                  ? t('当前项目「{name}」暂无终端，点击标签栏 + 新建', { name: currentProject.name })
                  : t('请先选择或添加项目，终端将默认基于当前项目创建')}
              </div>
            )}
            {/* Only mount the current project's terminals to avoid xterm cost across projects. */}
            {projectTerminals.map(t => {
              const isActive = t.id === activeTerminalId
              return (
                <div
                  key={t.id}
                  className={`absolute inset-0 min-w-0 ${
                    isActive ? 'z-10 visible' : 'invisible pointer-events-none z-0'
                  }`}
                >
                  <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
                    <TerminalView
                      terminalId={t.id}
                      isActive={isActive}
                      layoutKey={`${terminalOpen}:${terminalHeight}`}
                    />
                  </Suspense>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <StatusBar />
      <Toaster />
      <ConfirmDialog />
      <ChoiceDialog />
      <PromptDialog />
      <CommandPalette />
      <SymbolPicker />
      {fileCompare && <FileCompareDialog {...fileCompare} />}
      {projectManagerOpen && (
        <Suspense fallback={null}>
          <ProjectManager />
        </Suspense>
      )}
      {workspaceManagerOpen && (
        <Suspense fallback={null}>
          <WorkspaceManager />
        </Suspense>
      )}
    </div>
  )
}

export default App
