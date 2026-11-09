import {
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
import { TerminalHosts, TerminalSlot, type TerminalHostEntry } from './TerminalHost'
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
import { parseTerminalPaneRatio } from '../lib/terminalPaneRatio'

const DUAL_RATIO_KEY = 'qingcode:dual-terminal-ratio'
const QUAD_RATIO_KEY = 'qingcode:quad-terminal-ratio'
/** Either dual pane may grow up to 90% of the dual band. */
const DUAL_RATIO_MIN = 0.1
const DUAL_RATIO_MAX = 0.9
/** Fixed sash width between terminal panes (no negative margin overlap). */
const DUAL_RESIZER_PX = 8

type QuadRatios = { col: number; row: number }

function clampRatio(value: number): number {
  return Math.min(DUAL_RATIO_MAX, Math.max(DUAL_RATIO_MIN, value))
}

/** 聚焦格整框（标签栏+内容）画 inset 边；未聚焦不画，避免多格都套边显得吵 */
function paneFrameClass(focused: boolean): string {
  return focused ? 'ring-2 ring-inset ring-brand' : ''
}

function loadDualRatio(): number {
  try {
    return parseTerminalPaneRatio(localStorage.getItem(DUAL_RATIO_KEY))
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
  /** Side layout: which edge carries the terminal|editor width sash. */
  widthResizerEdge?: 'start' | 'end'
  /** 终端工作台列表可见时由列表切换终端，隐藏横向标签栏。 */
  hideTabs?: boolean
  isTerminalResizing: boolean
  layoutSwitching?: boolean
  onResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onWidthResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onHeightChange?: (value: number) => void
  onWidthChange?: (value: number) => void
  onHeightReset?: () => void
  onWidthReset?: () => void
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
  widthResizerEdge = 'start',
  hideTabs = false,
  isTerminalResizing,
  layoutSwitching = false,
  onResizerPointerDown,
  onWidthResizerPointerDown,
  onHeightChange,
  onWidthChange,
  onHeightReset,
  onWidthReset,
  terminalPanelRef,
}: TerminalPanelProps) {
  const skipDockTransition = isTerminalResizing || layoutSwitching
  const dualMode = position === 'side' && dualTerminal && !quadTerminal
  const quadMode = position === 'side' && quadTerminal
  const multiPane = dualMode || quadMode
  const sideWidthEqual = sideSplit === 'equal' || !editorVisible
  const [measuredSideWidth, setMeasuredSideWidth] = useState(terminalWidth)
  useEffect(() => {
    const panel = terminalPanelRef.current
    if (position !== 'side' || !terminalOpen || !sideWidthEqual || !panel) return
    const measure = () => setMeasuredSideWidth(Math.round(panel.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [position, terminalOpen, sideWidthEqual, terminalPanelRef])
  const currentSideWidth = sideWidthEqual ? measuredSideWidth : terminalWidth
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
  // 打开过的项目的终端视图一直常驻（见 TerminalHost），切回来不重建 xterm；
  // 没打开过的项目不提前创建，保持原来的按需挂载。
  const [visitedTerminalIds, setVisitedTerminalIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  if (projectTerminals.some(term => !visitedTerminalIds.has(term.id))) {
    setVisitedTerminalIds(previous => {
      const next = new Set(previous)
      for (const term of projectTerminals) next.add(term.id)
      return next
    })
  }
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

  // 单窗格与分屏的窗格归属判定不同（见 terminalPaneOf），切换时按新规则重选各窗格的当前终端。
  const activateProject = useTerminalStore(s => s.activateProject)
  const previousMultiPane = useRef(multiPane)
  useEffect(() => {
    if (previousMultiPane.current === multiPane) return
    previousMultiPane.current = multiPane
    const projectId = useProjectStore.getState().currentProject?.id
    if (projectId) activateProject(projectId)
  }, [multiPane, activateProject])

  useEffect(() => {
    if (quadMode) return
    if (terminalFocusPane === 'bl' || terminalFocusPane === 'br') {
      setTerminalFocusPane('primary')
    }
  }, [quadMode, terminalFocusPane, setTerminalFocusPane])

  useEffect(() => {
    if (multiPane) return
    if (terminalFocusPane !== 'primary') setTerminalFocusPane('primary')
  }, [multiPane, terminalFocusPane, setTerminalFocusPane])

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

  // 列表显隐会带出/收起标签栏，改变终端高度，也要触发重新适配行列。
  const layoutKey = `${position}:${terminalOpen}:${terminalHeight}:${sideSplit}:${dualTerminal}:${quadTerminal}:${editorVisible}:${terminalWidth}:${hideTabs}:${
    quadMode ? `q${quadRatios.col}:${quadRatios.row}` : dualMode ? dualRatio : 'single'
  }`

  const primaryEmpty = currentProject
    ? hideTabs
      ? t('当前项目「{name}」暂无终端，点击上方 + 新建', { name: currentProject.name })
      : t('当前项目「{name}」暂无终端，点击标签栏 + 新建', { name: currentProject.name })
    : t('请先选择或添加项目，终端将默认基于当前项目创建')

  const emptyTitleForPane = (pane: TerminalFocusPane) => {
    if (pane === 'primary') return primaryEmpty
    if (pane === 'secondary') {
      return quadMode
        ? t('右上窗格暂无终端，点击标签栏 + 新建')
        : t('右侧窗格暂无终端，点击标签栏 + 新建')
    }
    if (pane === 'bl') return t('左下窗格暂无终端，点击标签栏 + 新建')
    return t('右下窗格暂无终端，点击标签栏 + 新建')
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

  const focusedTerminalId = multiPane
    ? visiblePaneIds.has(paneId(terminalFocusPane) ?? '')
      ? paneId(terminalFocusPane)
      : null
    : activeTerminalId
  const hostEntries: TerminalHostEntry[] = terminals
    .filter(term => term.projectId === currentProject?.id || visitedTerminalIds.has(term.id))
    .map(term => ({
      terminalId: term.id,
      isActive: term.id === focusedTerminalId && term.projectId === currentProject?.id,
    }))
  const terminalHosts = <TerminalHosts entries={hostEntries} layoutKey={layoutKey} />

  const renderPaneTerminal = (pane: TerminalFocusPane) => {
    const termId = paneId(pane)
    const term = termId ? projectTerminals.find(t => t.id === termId) : undefined
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
      <TerminalSlot terminalId={term.id} onPointerDown={() => setTerminalFocusPane(pane)} />
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
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-terminal">
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
        <TerminalSlot terminalId={term.id} />
      </div>
    )
  })

  const dualBody = (
    <>
      <div
        ref={dualSplitRef}
        className="grid min-h-0 flex-1 overflow-hidden bg-bg-terminal"
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
            onValueChange={value => setDualRatio(clampRatio(value / 100))}
            onReset={() => setDualRatio(0.5)}
            keyboardStep={2}
            ariaValueNow={Math.round(dualRatio * 100)}
            ariaValueMin={Math.round(DUAL_RATIO_MIN * 100)}
            ariaValueMax={Math.round(DUAL_RATIO_MAX * 100)}
            className="!m-0 h-full w-full"
          />
        </div>
        {paneShell('secondary', { showPanelActions: true })}
      </div>
    </>
  )

  const quadBody = (
    <>
      <div
        ref={quadSplitRef}
        className="grid min-h-0 flex-1 overflow-hidden bg-bg-terminal"
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
            onValueChange={value => setQuadRatios(previous => ({ ...previous, col: clampRatio(value / 100) }))}
            onReset={() => setQuadRatios(previous => ({ ...previous, col: 0.5 }))}
            keyboardStep={2}
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
            onValueChange={value => setQuadRatios(previous => ({ ...previous, row: clampRatio(value / 100) }))}
            onReset={() => setQuadRatios(previous => ({ ...previous, row: 0.5 }))}
            keyboardStep={2}
            ariaValueNow={Math.round(quadRatios.row * 100)}
            ariaValueMin={Math.round(DUAL_RATIO_MIN * 100)}
            ariaValueMax={Math.round(DUAL_RATIO_MAX * 100)}
            className="!m-0 h-full w-full"
          />
        </div>
      </div>
    </>
  )

  const body = quadMode ? (
    quadBody
  ) : dualMode ? (
    dualBody
  ) : (
    <>
      {!hideTabs && <TerminalTabs />}
      <div className="relative flex-1 min-w-0 bg-bg-terminal overflow-hidden min-h-0">
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

  // 宿主固定在片段首位：侧边/底部切换只换外层 div，常驻终端视图不受影响。
  if (isSide) {
    const atEnd = widthResizerEdge === 'end'
    const widthResizer = terminalOpen && editorVisible && (
      <PanelResizer
        orientation="vertical"
        active={isTerminalResizing}
        tooltip={terminalWidthResizerHint(currentSideWidth, t)}
        tooltipSide={atEnd ? 'right' : 'left'}
        onPointerDown={onWidthResizerPointerDown}
        onValueChange={onWidthChange}
        onReset={onWidthReset}
        keyboardDirection={atEnd ? 1 : -1}
        ariaValueNow={currentSideWidth}
        ariaValueMin={getTerminalMinWidth()}
        ariaValueMax={getTerminalMaxWidth()}
      />
    )
    return (
      <>
      {terminalHosts}
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
        {widthResizerEdge === 'start' && widthResizer}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-l border-border">
          {body}
        </div>
        {widthResizerEdge === 'end' && widthResizer}
      </div>
      </>
    )
  }

  return (
    <>
    {terminalHosts}
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
          onValueChange={onHeightChange}
          onReset={onHeightReset}
          keyboardDirection={-1}
          ariaValueNow={terminalHeight}
          ariaValueMin={TERMINAL_MIN_HEIGHT}
          ariaValueMax={getTerminalMaxHeight()}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border">
        {body}
      </div>
    </div>
    </>
  )
}
