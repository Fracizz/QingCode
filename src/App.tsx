import { useEffect, useLayoutEffect, useState, lazy, Suspense } from 'react'
import './App.css'
import ActivityBar from './components/ActivityBar'
import Sidebar from './components/Sidebar'
import EditorTabs from './components/EditorTabs'
import EditorBreadcrumbs from './components/EditorBreadcrumbs'
import StatusBar from './components/StatusBar'
import TitleBar from './components/TitleBar'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import ChoiceDialog from './components/ChoiceDialog'
import PromptDialog from './components/PromptDialog'
import ExplorerConflictDialog from './components/ExplorerConflictDialog'
import PropertiesDialog from './components/PropertiesDialog'
import CommandPalette from './components/CommandPalette'
import SymbolPicker from './components/SymbolPicker'
import DefinitionPicker from './components/DefinitionPicker'
import FileCompareDialog from './components/FileCompareDialog'
import EmptyEditor from './components/EmptyEditor'
import TerminalPanel from './components/TerminalPanel'
import { useTerminalStore } from './store/terminalStore'
import { useProjectStore } from './store/projectStore'
import { useEditorStore } from './store/editorStore'
import { useUIStore } from './store/uiStore'
import { useCompareStore } from './store/compareStore'
import { useCommandPaletteStore } from './store/commandPaletteStore'
import { useSymbolPickerStore } from './store/symbolPickerStore'
import { isTauri } from './lib/tauri'
import { tabNeedsDiskContent } from './lib/openFileError'
import ResizableSidebar from './components/ResizableSidebar'
import { startSystemThemeListener } from './lib/themeSettings'
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from './lib/sidebarLayout'
import { dismissStartupSplash } from './lib/startupSplash'
import { migrateLegacySettings } from './lib/migrateLegacySettings'
import { listenForOpenFileRequests, openLaunchFiles } from './lib/launchFiles'
import { listenForCliRequests } from './lib/cliBridge'
import { useI18n } from './lib/i18n'
import { useShortcutStore } from './store/shortcutStore'
import { useAutoSave } from './hooks/useAutoSave'
import { useFileWatcher } from './hooks/useFileWatcher'
import { useDraftRecovery } from './hooks/useDraftRecovery'
import { useAppUpdateCheck } from './hooks/useAppUpdateCheck'
import { useTerminalPanel } from './hooks/useTerminalPanel'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import {
  terminalPositionForTemplate,
} from './lib/panelLayoutTemplate'
import {
  beginPanelResize,
  settlePanelResize,
} from './lib/panelResize'
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
const SearchPanel = lazy(() => import('./components/SearchPanel'))
const SourceControlPanel = lazy(() => import('./components/SourceControlPanel'))
const RunPanel = lazy(() => import('./components/RunPanel'))
const ProjectManager = lazy(() => import('./components/ProjectManager'))
const WorkspaceManager = lazy(() => import('./components/WorkspaceManager'))
const SettingsEditor = lazy(() => import('./components/SettingsEditor'))

migrateLegacySettings()
void import('./lib/minimapSettings').then(m => m.migrateLegacyMinimapSetting())

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
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

function App() {
  const { t } = useI18n()
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
  const panelLayout = useUIStore(s => s.panelLayout)
  const panelLayoutSwitching = useUIStore(s => s.panelLayoutSwitching)
  const sideDualTerminal = useUIStore(s => s.sideDualTerminal)
  const sideQuadTerminal = useUIStore(s => s.sideQuadTerminal)
  const sideEditorVisible = useUIStore(s => s.sideEditorVisible)
  const projectManagerOpen = useUIStore(s => s.projectManagerOpen)
  const workspaceManagerOpen = useUIStore(s => s.workspaceManagerOpen)
  const openProjectManager = useUIStore(s => s.openProjectManager)
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const openPalette = useCommandPaletteStore(s => s.openPalette)
  const openSymbolPicker = useSymbolPickerStore(s => s.openPicker)

  useAutoSave()
  useDraftRecovery()
  useFileWatcher()
  useAppUpdateCheck()
  const fileCompare = useCompareStore(s => s.request)

  const {
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
  terminalWidth,
  sideSplit,
  isTerminalResizing,
    onResizerPointerDown,
    onWidthResizerPointerDown,
    terminalPanelRef,
  } = useTerminalPanel()

  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [projectsReady, setProjectsReady] = useState(false)
  const terminalPosition = terminalPositionForTemplate(panelLayout)
  const sideEditorSlotVisible = panelLayout !== 'sideTerminal' || sideEditorVisible
  const sideDualActive = panelLayout === 'sideTerminal' && sideDualTerminal && !sideQuadTerminal
  const sideQuadActive = panelLayout === 'sideTerminal' && sideQuadTerminal
  const sidebarSlotVisible =
    sidebarOpen && (view === 'explorer' || view === 'search' || view === 'run')

  useLayoutEffect(() => {
    if (!panelLayoutSwitching) return
    document.body.dataset.panelLayoutSwitch = '1'
    beginPanelResize(terminalPosition === 'side' ? 'vertical' : 'horizontal')
  }, [panelLayoutSwitching, terminalPosition])

  useEffect(() => {
    if (!panelLayoutSwitching) return
    const orientation = terminalPosition === 'side' ? 'vertical' : 'horizontal'
    settlePanelResize(orientation)
    delete document.body.dataset.panelLayoutSwitch
    useUIStore.setState({ panelLayoutSwitching: false })
  }, [panelLayoutSwitching, terminalPosition])

  useAppKeyboardShortcuts({ shortcuts, setView, openPalette, openSymbolPicker })

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
    let unlistenOpen: (() => void) | undefined
    let unlistenCli: (() => void) | undefined
    void listenForOpenFileRequests().then(fn => {
      if (cancelled) fn()
      else unlistenOpen = fn
    })
    void listenForCliRequests().then(fn => {
      if (cancelled) fn()
      else unlistenCli = fn
    })
    void openLaunchFiles()
    return () => {
      cancelled = true
      unlistenOpen?.()
      unlistenCli?.()
    }
  }, [])

  useEffect(() => {
    saveSidebarWidth(sidebarWidth)
  }, [sidebarWidth])

  // Open the terminal panel when something (e.g. a run config) signals it.
  useEffect(() => {
    if (terminalOpenSignal > 0) setTerminalOpen(true)
  }, [terminalOpenSignal, setTerminalOpen])

  useEffect(() => {
    if (terminalToggleSignal > 0) setTerminalOpen(open => !open)
  }, [terminalToggleSignal, setTerminalOpen])

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

  const tabsNeedContentLoad = useEditorStore(s => s.tabs.some(tabNeedsDiskContent))

  // After project session restore, load disk (or keep draft) bodies for open tabs.
  useEffect(() => {
    if (!currentProject || !tabsNeedContentLoad) return
    void loadMissingTabContents()
  }, [currentProject, tabsNeedContentLoad, loadMissingTabContents])

  // When the current project already has terminal tabs, activate them and spawn
  // restored PTYs once the panel is open. Do not auto-create a terminal just
  // because the project has none.
  useEffect(() => {
    if (!currentProject || !projectTrusted) return
    const projectId = currentProject.id
    if (!useTerminalStore.getState().terminals.some(t => t.projectId === projectId)) {
      return
    }
    activateProject(projectId)
    if (!terminalOpen) return
    return scheduleDeferredWork(() => {
      void spawnRestoredTerminals(projectId)
    })
  }, [
    activateProject,
    currentProject,
    projectTrusted,
    spawnRestoredTerminals,
    terminalOpen,
  ])

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
        <div
          className="workspace-grid flex-1 min-h-0 overflow-hidden"
          data-panel-layout={panelLayout}
          data-sidebar-slot={sidebarSlotVisible ? 'visible' : 'hidden'}
          data-editor-slot={sideEditorSlotVisible ? 'visible' : 'collapsed'}
          data-terminal-dual={sideDualActive ? 'true' : undefined}
          data-terminal-quad={sideQuadActive ? 'true' : undefined}
          data-terminal-split={
            panelLayout === 'sideTerminal' && sideEditorSlotVisible ? sideSplit : undefined
          }
        >
          <div className="workspace-grid-activity">
            <ActivityBar
              active={view}
              sidebarOpen={sidebarOpen}
              onActiveChange={toggleActivityView}
              onToggleTerminal={() => setTerminalOpen(v => !v)}
              onAddProject={handleAddProject}
              onManageProjects={openProjectManager}
              terminalOpen={terminalOpen}
            />
          </div>

          {sidebarSlotVisible && view === 'explorer' && (
            <div className="workspace-grid-sidebar">
              <ResizableSidebar width={sidebarWidth} onWidthChange={setSidebarWidth}>
                <Sidebar />
              </ResizableSidebar>
            </div>
          )}

          {sidebarSlotVisible && view === 'search' && (
            <div className="workspace-grid-sidebar">
              <ResizableSidebar
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                className="ui-font-scaled"
              >
                <Suspense fallback={<LazyFallback className="h-full bg-bg-sidebar" />}>
                  <SearchPanel />
                </Suspense>
              </ResizableSidebar>
            </div>
          )}

          {sidebarSlotVisible && view === 'run' && (
            <div className="workspace-grid-sidebar">
              <ResizableSidebar
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                className="ui-font-scaled bg-bg-sidebar"
              >
                <Suspense fallback={<LazyFallback className="h-full bg-bg-sidebar" />}>
                  <RunPanel />
                </Suspense>
              </ResizableSidebar>
            </div>
          )}

          <TerminalPanel
            position={terminalPosition}
            terminalOpen={terminalOpen}
            terminalHeight={terminalHeight}
            terminalWidth={terminalWidth}
            sideSplit={sideSplit}
            dualTerminal={sideDualActive}
            quadTerminal={sideQuadActive}
            editorVisible={sideEditorSlotVisible}
            isTerminalResizing={isTerminalResizing}
            layoutSwitching={panelLayoutSwitching}
            onResizerPointerDown={onResizerPointerDown}
            onWidthResizerPointerDown={onWidthResizerPointerDown}
            terminalPanelRef={terminalPanelRef}
          />

          <div className="workspace-grid-editor flex flex-col overflow-hidden min-w-0" data-editor-column>
            {view === 'settings' ? (
              <Suspense fallback={<LazyFallback />}>
                <SettingsEditor />
              </Suspense>
            ) : view === 'sourceControl' ? (
              <Suspense fallback={<LazyFallback className="h-full bg-bg-sidebar" />}>
                <SourceControlPanel />
              </Suspense>
            ) : (
              <>
                <EditorTabs />
                <EditorBreadcrumbs />
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
      </div>

      <StatusBar />
      <Toaster />
      <ConfirmDialog />
      <ChoiceDialog />
      <PromptDialog />
      <ExplorerConflictDialog />
      <PropertiesDialog />
      <CommandPalette />
      <SymbolPicker />
      <DefinitionPicker />
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
