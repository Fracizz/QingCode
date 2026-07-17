import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import './App.css'
import ActivityBar from './components/ActivityBar'
import Sidebar from './components/Sidebar'
import EditorTabs from './components/EditorTabs'
import TerminalTabs from './components/TerminalTabs'
import StatusBar from './components/StatusBar'
import TitleBar from './components/TitleBar'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import PromptDialog from './components/PromptDialog'
import SettingsPanel from './components/SettingsPanel'
import { useTerminalStore } from './store/terminalStore'
import { useProjectStore } from './store/projectStore'
import { useUIStore } from './store/uiStore'
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
import { useI18n } from './lib/i18n'
import { isShortcutInputTarget, shortcutMatchesEvent } from './lib/shortcuts'
import { useShortcutStore } from './store/shortcutStore'

const Editor = lazy(() => import('./components/Editor'))
const TerminalView = lazy(() => import('./components/Terminal'))
const SearchPanel = lazy(() => import('./components/SearchPanel'))
const RunPanel = lazy(() => import('./components/RunPanel'))
const ProjectManager = lazy(() => import('./components/ProjectManager'))

migrateLegacySettings()

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
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
  const initializeTerminalEvents = useTerminalStore(s => s.initializeTerminalEvents)
  const currentProject = useProjectStore(s => s.currentProject)
  const loadProjects = useProjectStore(s => s.loadProjects)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const view = useUIStore(s => s.view)
  const sidebarOpen = useUIStore(s => s.sidebarOpen)
  const setView = useUIStore(s => s.setView)
  const toggleActivityView = useUIStore(s => s.toggleActivityView)
  const terminalOpenSignal = useUIStore(s => s.terminalOpenSignal)
  const projectManagerOpen = useUIStore(s => s.projectManagerOpen)
  const openProjectManager = useUIStore(s => s.openProjectManager)
  const shortcuts = useShortcutStore(s => s.shortcuts)

  const [terminalOpen, setTerminalOpen] = useState(initialTerminalPanel.open)
  const [terminalHeight, setTerminalHeight] = useState(initialTerminalPanel.height)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth)
  const [isTerminalResizing, setIsTerminalResizing] = useState(false)
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null)

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
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    startSystemThemeListener()
    dismissStartupSplash()
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isShortcutInputTarget(event.target)) return
      if (shortcutMatchesEvent(shortcuts.searchAllProjects, event)) {
        event.preventDefault()
        useUIStore.getState().requestGlobalSearch()
      } else if (shortcutMatchesEvent(shortcuts.toggleTerminal, event)) {
        event.preventDefault()
        setTerminalOpen(open => !open)
      } else if (shortcutMatchesEvent(shortcuts.openSettings, event)) {
        event.preventDefault()
        setView('settings')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [shortcuts, setView])

  // Ensure the current project has at least one terminal, and that the active
  // terminal belongs to the current project.
  const projectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  useEffect(() => {
    if (!currentProject) return
    if (projectTerminals.length === 0) {
      addTerminal(currentProject.path, currentProject.id)
    } else {
      activateProject(currentProject.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id])

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

        {sidebarOpen && view === 'settings' && (
          <ResizableSidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            className="ui-font-scaled"
          >
            <SettingsPanel />
          </ResizableSidebar>
        )}

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <EditorTabs />
          <Suspense fallback={<LazyFallback />}>
            <Editor />
          </Suspense>
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
            {terminals.map(t => {
              const inCurrentProject = t.projectId === currentProject?.id
              const isActive = inCurrentProject && t.id === activeTerminalId
              return (
                <div
                  key={t.id}
                  className={
                    inCurrentProject
                      ? `absolute inset-0 min-w-0 ${
                          isActive ? 'z-10 visible' : 'invisible pointer-events-none z-0'
                        }`
                      : 'hidden'
                  }
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
      <PromptDialog />
      {projectManagerOpen && (
        <Suspense fallback={null}>
          <ProjectManager />
        </Suspense>
      )}
    </div>
  )
}

export default App
