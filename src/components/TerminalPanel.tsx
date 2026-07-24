import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { Terminal as TerminalIcon } from 'lucide-react'
import PanelResizer from './PanelResizer'
import TerminalTabs from './TerminalTabs'
import EmptyState from './EmptyState'
import {
  TERMINAL_FOCUS_PANES,
  useTerminalStore,
  type TerminalFocusPane,
} from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import { useI18n } from '../lib/i18n'
import {
  getTerminalMaxHeight,
  getTerminalMaxWidth,
  getTerminalMinWidth,
  TERMINAL_MIN_HEIGHT,
  terminalResizerHint,
  terminalWidthResizerHint,
} from '../lib/panelLayout'
import { beginPanelResize, settlePanelResize } from '../lib/panelResize'

const TerminalView = lazy(() => import('./Terminal'))

const DUAL_RATIO_KEY = 'qingcode:dual-terminal-ratio'
const QUAD_RATIO_KEY = 'qingcode:quad-terminal-ratio'
/** Either dual pane may grow up to 90% of the dual band. */
const DUAL_RATIO_MIN = 0.1
const DUAL_RATIO_MAX = 0.9
/** Fixed sash width between terminal panes (no negative margin overlap). */
const DUAL_RESIZER_PX = 8

type QuadRatios = { col: number; row: number }

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
}

function clampRatio(value: number): number {
  return Math.min(DUAL_RATIO_MAX, Math.max(DUAL_RATIO_MIN, value))
}

/** 聚焦格整框（标签栏+内容）画 inset 边；未聚焦不画，避免多格都套边显得吵 */
function paneFrameClass(focused: boolean): string {
  return focused ? 'ring-2 ring-inset ring-brand' : ''
}

function loadDualRatio(): number {
  try {
    const raw = Number(localStorage.getItem(DUAL_RATIO_KEY))
    if (!Number.isFinite(raw)) return 0.5
    return clampRatio(raw)
  } catch {
    return 0.5
  }
}

function loadQuadRatios(): QuadRatios {
  try {
    const raw = JSON.parse(localStorage.getItem(QUAD_RATIO_KEY) ?? '')
    if (!raw || typeof raw !== 'object') return { col: 0.5, row: 0.5 }
    const col = Number((raw as { col?: unknown }).col)
    const row = Number((raw as { row?: unknown }).row)
    return {
      col: Number.isFinite(col) ? clampRatio(col) : 0.5,
      row: Number.isFinite(row) ? clampRatio(row) : 0.5,
    }
  } catch {
    return { col: 0.5, row: 0.5 }
  }
}

export type TerminalPanelPosition = 'bottom' | 'side'

export interface TerminalPanelProps {
  position?: TerminalPanelPosition
  terminalOpen: boolean
  terminalHeight: number
  terminalWidth: number
  sideSplit?: 'equal' | 'custom'
  /** Side layout: show a second independent terminal column. */
  dualTerminal?: boolean
  /** Side layout: 2×2 田 terminal grid. */
  quadTerminal?: boolean
  /** Side layout: editor column is visible (outer terminal|editor drag applies). */
  editorVisible?: boolean
  isTerminalResizing: boolean
  layoutSwitching?: boolean
  onResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onWidthResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  terminalPanelRef: RefObject<HTMLDivElement | null>
}

export default function TerminalPanel({
  position = 'bottom',
  terminalOpen,
  terminalHeight,
  terminalWidth,
  sideSplit = 'equal',
  dualTerminal = false,
  quadTerminal = false,
  editorVisible = true,
  isTerminalResizing,
  layoutSwitching = false,
  onResizerPointerDown,
  onWidthResizerPointerDown,
  terminalPanelRef,
}: TerminalPanelProps) {
  const skipDockTransition = isTerminalResizing || layoutSwitching
  const dualMode = position === 'side' && dualTerminal && !quadTerminal
  const quadMode = position === 'side' && quadTerminal
  const multiPane = dualMode || quadMode
  const sideWidthEqual = sideSplit === 'equal' || !editorVisible
  const { t } = useI18n()
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const secondaryTerminalId = useTerminalStore(s => s.secondaryTerminalId)
  const blTerminalId = useTerminalStore(s => s.blTerminalId)
  const brTerminalId = useTerminalStore(s => s.brTerminalId)
  const terminalFocusPane = useTerminalStore(s => s.terminalFocusPane)
  const setTerminalFocusPane = useTerminalStore(s => s.setTerminalFocusPane)
  const ensureSecondaryTerminal = useTerminalStore(s => s.ensureSecondaryTerminal)
  const ensureQuadTerminals = useTerminalStore(s => s.ensureQuadTerminals)
  const currentProject = useProjectStore(s => s.currentProject)
  const projectTerminals = terminals.filter(term => term.projectId === currentProject?.id)
  const isSide = position === 'side'
  const [dualRatio, setDualRatio] = useState(loadDualRatio)
  const [quadRatios, setQuadRatios] = useState(loadQuadRatios)
  const [dualResizing, setDualResizing] = useState(false)
  const [quadColResizing, setQuadColResizing] = useState(false)
  const [quadRowResizing, setQuadRowResizing] = useState(false)
  const dualSplitRef = useRef<HTMLDivElement>(null)
  const quadSplitRef = useRef<HTMLDivElement>(null)

  const paneId = (pane: TerminalFocusPane) => {
    switch (pane) {
      case 'primary':
        return activeTerminalId
      case 'secondary':
        return secondaryTerminalId
      case 'bl':
        return blTerminalId
      case 'br':
        return brTerminalId
    }
  }

  useEffect(() => {
    if (!dualMode || !currentProject) return
    ensureSecondaryTerminal(currentProject.id)
  }, [dualMode, currentProject, ensureSecondaryTerminal, projectTerminals.length, activeTerminalId])

  useEffect(() => {
    if (!quadMode || !currentProject) return
    ensureQuadTerminals(currentProject.id)
  }, [
    quadMode,
    currentProject,
    ensureQuadTerminals,
    projectTerminals.length,
    activeTerminalId,
    secondaryTerminalId,
    blTerminalId,
    brTerminalId,
  ])

  useEffect(() => {
    if (quadMode) return
    if (terminalFocusPane === 'bl' || terminalFocusPane === 'br') {
      setTerminalFocusPane('primary')
    }
  }, [quadMode, terminalFocusPane, setTerminalFocusPane])

  useEffect(() => {
    try {
      localStorage.setItem(DUAL_RATIO_KEY, String(dualRatio))
    } catch {
      /* ignore */
    }
  }, [dualRatio])

  useEffect(() => {
    try {
      localStorage.setItem(QUAD_RATIO_KEY, JSON.stringify(quadRatios))
    } catch {
      /* ignore */
    }
  }, [quadRatios])

  const onDualResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const split = dualSplitRef.current
    if (!split) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    handle.setPointerCapture(pointerId)
    setDualResizing(true)
    beginPanelResize('vertical')

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const rect = split.getBoundingClientRect()
      const band = rect.width - DUAL_RESIZER_PX
      if (band <= 0) return
      const next = (ev.clientX - rect.left) / band
      setDualRatio(clampRatio(next))
    }
    const finish = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setDualResizing(false)
      settlePanelResize('vertical')
    }
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish()
    }
    const onLostCapture = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish()
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
    handle.addEventListener('lostpointercapture', onLostCapture)
  }

  const onQuadColResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const split = quadSplitRef.current
    if (!split) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    handle.setPointerCapture(pointerId)
    setQuadColResizing(true)
    beginPanelResize('vertical')

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const rect = split.getBoundingClientRect()
      const band = rect.width - DUAL_RESIZER_PX
      if (band <= 0) return
      const next = (ev.clientX - rect.left) / band
      setQuadRatios(prev => ({ ...prev, col: clampRatio(next) }))
    }
    const finish = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setQuadColResizing(false)
      settlePanelResize('vertical')
    }
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish()
    }
    const onLostCapture = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish()
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
    handle.addEventListener('lostpointercapture', onLostCapture)
  }

  const onQuadRowResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const split = quadSplitRef.current
    if (!split) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    handle.setPointerCapture(pointerId)
    setQuadRowResizing(true)
    beginPanelResize('horizontal')

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const rect = split.getBoundingClientRect()
      // Pane shells include their own tab rows; ratio is between the two stacked panes.
      const band = rect.height - DUAL_RESIZER_PX
      if (band <= 0) return
      const next = (ev.clientY - rect.top) / band
      setQuadRatios(prev => ({ ...prev, row: clampRatio(next) }))
    }
    const finish = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setQuadRowResizing(false)
      settlePanelResize('horizontal')
    }
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish()
    }
    const onLostCapture = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish()
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
    handle.addEventListener('lostpointercapture', onLostCapture)
  }

  const layoutKey = `${position}:${terminalOpen}:${terminalHeight}:${sideSplit}:${dualTerminal}:${quadTerminal}:${editorVisible}:${terminalWidth}:${
    quadMode ? `q${quadRatios.col}:${quadRatios.row}` : dualMode ? dualRatio : 'single'
  }`

  const primaryEmpty = currentProject
    ? t('当前项目「{name}」暂无终端，点击标签栏 + 新建', { name: currentProject.name })
    : t('请先选择或添加项目，终端将默认基于当前项目创建')

  const emptyTitleForPane = (pane: TerminalFocusPane) => {
    if (pane === 'primary') return primaryEmpty
    if (pane === 'secondary') {
      return quadMode ? t('选择或新建终端显示在右上') : t('选择或新建终端显示在右侧')
    }
    if (pane === 'bl') return t('选择或新建终端显示在左下')
    return t('选择或新建终端显示在右下')
  }

  const resolvePane = (termId: string): TerminalFocusPane | null => {
    for (const pane of TERMINAL_FOCUS_PANES) {
      if (paneId(pane) === termId) {
        if (pane === 'primary') return 'primary'
        if (dualMode && pane === 'secondary') return 'secondary'
        if (quadMode) return pane
        return null
      }
    }
    return null
  }

  const multiPaneList: readonly TerminalFocusPane[] = quadMode
    ? TERMINAL_FOCUS_PANES
    : dualMode
      ? ['primary', 'secondary']
      : ['primary']
  const visiblePaneIds = new Set(
    multiPaneList.map(paneId).filter((id): id is string => Boolean(id)),
  )

  /** Keep every project terminal mounted; park ones not shown in a visible pane. */
  const parkedTerminalViews = projectTerminals
    .filter(term => !visiblePaneIds.has(term.id))
    .map(term => (
      <div key={term.id} className="hidden" aria-hidden="true">
        <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
          <TerminalView terminalId={term.id} isActive={false} layoutKey={layoutKey} />
        </Suspense>
      </div>
    ))

  const renderPaneTerminal = (pane: TerminalFocusPane) => {
    const termId = paneId(pane)
    const term = termId ? projectTerminals.find(t => t.id === termId) : undefined
    const focused = !multiPane || terminalFocusPane === pane
    if (!term) {
      return (
        <EmptyState
          className="h-full"
          icon={<TerminalIcon size={28} strokeWidth={1.2} />}
          title={emptyTitleForPane(pane)}
        />
      )
    }
    return (
      <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
        <TerminalView terminalId={term.id} isActive={focused} layoutKey={layoutKey} />
      </Suspense>
    )
  }

  const paneShell = (
    pane: TerminalFocusPane,
    options: { showPanelActions: boolean; className?: string; style?: CSSProperties },
  ) => {
    const focused = terminalFocusPane === pane
    return (
      <div
        data-terminal-pane={pane}
        data-terminal-active={focused ? 'true' : undefined}
        className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${paneFrameClass(focused)} ${
          options.className ?? ''
        }`}
        style={options.style}
        onPointerDown={() => setTerminalFocusPane(pane)}
      >
        <TerminalTabs
          pane={pane}
          focused={focused}
          showPanelActions={options.showPanelActions}
        />
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-deep">
          {renderPaneTerminal(pane)}
        </div>
      </div>
    )
  }

  const singleTerminalViews = projectTerminals.map(term => {
    const pane = resolvePane(term.id)
    const isFocused = pane === 'primary'
    return (
      <div
        key={term.id}
        data-terminal-active={isFocused ? 'true' : undefined}
        data-terminal-pane={pane ?? undefined}
        className={`absolute inset-0 min-w-0 ${
          pane === 'primary' ? 'z-10 visible' : 'invisible pointer-events-none z-0'
        }`}
      >
        <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
          <TerminalView terminalId={term.id} isActive={isFocused} layoutKey={layoutKey} />
        </Suspense>
      </div>
    )
  })

  const dualBody = (
    <>
      <div
        ref={dualSplitRef}
        className="grid min-h-0 flex-1 overflow-hidden bg-bg-deep"
        style={{
          gridTemplateColumns: `minmax(0, ${dualRatio}fr) ${DUAL_RESIZER_PX}px minmax(0, ${1 - dualRatio}fr)`,
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
        {paneShell('primary', { showPanelActions: false })}
        <div className="relative z-30 min-h-0">
          <PanelResizer
            orientation="vertical"
            active={dualResizing}
            tooltip={t('拖动调整双终端比例')}
            tooltipSide="right"
            onPointerDown={onDualResizerPointerDown}
            ariaValueNow={Math.round(dualRatio * 100)}
            ariaValueMin={Math.round(DUAL_RATIO_MIN * 100)}
            ariaValueMax={Math.round(DUAL_RATIO_MAX * 100)}
            className="!m-0 h-full w-full"
          />
        </div>
        {paneShell('secondary', { showPanelActions: true })}
      </div>
      {parkedTerminalViews}
    </>
  )

  const quadBody = (
    <>
      <div
        ref={quadSplitRef}
        className="grid min-h-0 flex-1 overflow-hidden bg-bg-deep"
        style={{
          gridTemplateColumns: `minmax(0, ${quadRatios.col}fr) ${DUAL_RESIZER_PX}px minmax(0, ${1 - quadRatios.col}fr)`,
          gridTemplateRows: `minmax(0, ${quadRatios.row}fr) ${DUAL_RESIZER_PX}px minmax(0, ${1 - quadRatios.row}fr)`,
        }}
      >
        {paneShell('primary', {
          showPanelActions: false,
          style: { gridColumn: 1, gridRow: 1 },
        })}
        {paneShell('secondary', {
          showPanelActions: true,
          style: { gridColumn: 3, gridRow: 1 },
        })}
        {paneShell('bl', {
          showPanelActions: false,
          style: { gridColumn: 1, gridRow: 3 },
        })}
        {paneShell('br', {
          showPanelActions: false,
          style: { gridColumn: 3, gridRow: 3 },
        })}
        <div style={{ gridColumn: 2, gridRow: '1 / -1' }} className="relative z-30 min-h-0">
          <PanelResizer
            orientation="vertical"
            active={quadColResizing}
            tooltip={t('拖动调整四终端列比例')}
            tooltipSide="right"
            onPointerDown={onQuadColResizerPointerDown}
            ariaValueNow={Math.round(quadRatios.col * 100)}
            ariaValueMin={Math.round(DUAL_RATIO_MIN * 100)}
            ariaValueMax={Math.round(DUAL_RATIO_MAX * 100)}
            className="!m-0 h-full w-full"
          />
        </div>
        <div style={{ gridColumn: '1 / -1', gridRow: 2 }} className="relative z-20 min-w-0">
          <PanelResizer
            orientation="horizontal"
            active={quadRowResizing}
            tooltip={t('拖动调整四终端行比例')}
            tooltipSide="top"
            onPointerDown={onQuadRowResizerPointerDown}
            ariaValueNow={Math.round(quadRatios.row * 100)}
            ariaValueMin={Math.round(DUAL_RATIO_MIN * 100)}
            ariaValueMax={Math.round(DUAL_RATIO_MAX * 100)}
            className="!m-0 h-full w-full"
          />
        </div>
      </div>
      {parkedTerminalViews}
    </>
  )

  const body = quadMode ? (
    quadBody
  ) : dualMode ? (
    dualBody
  ) : (
    <>
      <TerminalTabs />
      <div className="relative flex-1 min-w-0 bg-bg-deep overflow-hidden min-h-0">
        {projectTerminals.length === 0 && (
          <div className="absolute inset-0">
            <EmptyState
              className="h-full"
              icon={<TerminalIcon size={28} strokeWidth={1.2} />}
              title={primaryEmpty}
            />
          </div>
        )}
        {singleTerminalViews}
      </div>
    </>
  )

  if (isSide) {
    return (
      <div
        ref={terminalPanelRef}
        data-terminal-panel
        data-terminal-dock="side"
        data-terminal-position="side"
        data-terminal-dual={dualMode ? 'true' : undefined}
        data-terminal-quad={quadMode ? 'true' : undefined}
        className={`flex h-full min-h-0 overflow-hidden ${
          sideWidthEqual ? 'min-w-0 w-full' : 'flex-shrink-0'
        } ${
          skipDockTransition ? '' : 'transition-[width,opacity] duration-200 ease-out'
        } ${terminalOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{
          width: terminalOpen ? (sideWidthEqual ? '100%' : terminalWidth) : 0,
        }}
      >
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-r border-border">
          {body}
        </div>
        {terminalOpen && editorVisible && (
          <PanelResizer
            orientation="vertical"
            active={isTerminalResizing}
            tooltip={terminalWidthResizerHint(terminalWidth, t)}
            tooltipSide="right"
            onPointerDown={onWidthResizerPointerDown}
            ariaValueNow={terminalWidth}
            ariaValueMin={getTerminalMinWidth()}
            ariaValueMax={getTerminalMaxWidth()}
          />
        )}
      </div>
    )
  }

  return (
    <div
      ref={terminalPanelRef}
      data-terminal-panel
      data-terminal-dock="bottom"
      data-terminal-position="bottom"
      className={`flex flex-col flex-shrink-0 min-h-0 overflow-hidden ${
        skipDockTransition ? '' : 'transition-[height,opacity] duration-200 ease-out'
      } ${terminalOpen ? 'opacity-100' : 'opacity-0 pointer-events-none h-0'}`}
      style={{ height: terminalOpen ? terminalHeight : 0 }}
    >
      {terminalOpen && (
        <PanelResizer
          orientation="horizontal"
          active={isTerminalResizing}
          tooltip={terminalResizerHint(terminalHeight, t)}
          tooltipSide="top"
          onPointerDown={onResizerPointerDown}
          ariaValueNow={terminalHeight}
          ariaValueMin={TERMINAL_MIN_HEIGHT}
          ariaValueMax={getTerminalMaxHeight()}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border">
        {body}
      </div>
    </div>
  )
}
