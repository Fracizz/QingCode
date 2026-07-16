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
import FontSettings from './components/FontSettings'
import ThemeSettings from './components/ThemeSettings'
import { Settings } from 'lucide-react'
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

const Editor = lazy(() => import('./components/Editor'))
const TerminalView = lazy(() => import('./components/Terminal'))
const SearchPanel = lazy(() => import('./components/SearchPanel'))
const RunPanel = lazy(() => import('./components/RunPanel'))

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
  const setView = useUIStore(s => s.setView)
  const terminalOpenSignal = useUIStore(s => s.terminalOpenSignal)

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
        endPanelResize()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      beginPanelResize()
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
          当前为浏览器预览模式，项目、文件、终端等功能不可用。请使用{' '}
          <code className="px-1 py-0.5 rounded bg-black/20">pnpm tauri dev</code>{' '}
          启动，并在弹出的桌面窗口中操作。
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <ActivityBar
          active={view}
          onActiveChange={setView}
          onToggleTerminal={() => setTerminalOpen(v => !v)}
          onAddProject={handleAddProject}
          terminalOpen={terminalOpen}
        />

        {view === 'explorer' && (
          <ResizableSidebar width={sidebarWidth} onWidthChange={setSidebarWidth}>
            <Sidebar />
          </ResizableSidebar>
        )}

        {view === 'search' && (
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

        {view === 'run' && (
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

        {view === 'settings' && (
          <ResizableSidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            className="ui-font-scaled bg-bg-sidebar"
          >
            <div className="px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
              <Settings size={13} /> 设置
            </div>
            <FontSettings />
            <div className="border-t border-border-strong" />
            <ThemeSettings />
          </ResizableSidebar>
        )}

        <div className="flex-1 flex flex-col overflow-hidden">
          <EditorTabs />
          <Suspense fallback={<LazyFallback />}>
            <Editor />
          </Suspense>
        </div>
      </div>

      <div
        className={`${terminalOpen ? 'flex' : 'hidden'} flex-col flex-shrink-0`}
        style={{ height: terminalHeight }}
      >
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
        <TerminalTabs />
        <div className="flex-1 bg-bg-deep overflow-hidden">
          {projectTerminals.length === 0 && (
              <div className="h-full flex items-center justify-center text-fg-dim text-sm">
                {currentProject
                  ? `当前项目「${currentProject.name}」暂无终端，点击右上角 + 新建`
                  : '请先选择或添加项目，终端将默认基于当前项目创建'}
              </div>
          )}
          {terminals.map(t => (
            <div
              key={t.id}
              className={`h-full ${
                t.projectId === currentProject?.id && t.id === activeTerminalId ? '' : 'hidden'
              }`}
            >
              <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
                <TerminalView terminalId={t.id} />
              </Suspense>
            </div>
          ))}
        </div>
      </div>

      <StatusBar />
      <Toaster />
      <ConfirmDialog />
      <PromptDialog />
    </div>
  )
}

export default App
