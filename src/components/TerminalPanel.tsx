import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react'
import { Terminal as TerminalIcon } from 'lucide-react'
import PanelResizer from './PanelResizer'
import TerminalTabs from './TerminalTabs'
import EmptyState from './EmptyState'
import { useTerminalStore } from '../store/terminalStore'
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
/** Either dual pane may grow up to 90% of the dual band. */
const DUAL_RATIO_MIN = 0.1
const DUAL_RATIO_MAX = 0.9
/** Fixed sash width between the two terminal panes (no negative margin overlap). */
const DUAL_RESIZER_PX = 8

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
}

function loadDualRatio(): number {
  try {
    const raw = Number(localStorage.getItem(DUAL_RATIO_KEY))
    if (!Number.isFinite(raw)) return 0.5
    return Math.min(DUAL_RATIO_MAX, Math.max(DUAL_RATIO_MIN, raw))
  } catch {
    return 0.5
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
  editorVisible = true,
  isTerminalResizing,
  layoutSwitching = false,
  onResizerPointerDown,
  onWidthResizerPointerDown,
  terminalPanelRef,
}: TerminalPanelProps) {
  const skipDockTransition = isTerminalResizing || layoutSwitching
  const dualMode = position === 'side' && dualTerminal
  const sideWidthEqual = sideSplit === 'equal' || !editorVisible
  const { t } = useI18n()
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const secondaryTerminalId = useTerminalStore(s => s.secondaryTerminalId)
  const terminalFocusPane = useTerminalStore(s => s.terminalFocusPane)
  const setTerminalFocusPane = useTerminalStore(s => s.setTerminalFocusPane)
  const ensureSecondaryTerminal = useTerminalStore(s => s.ensureSecondaryTerminal)
  const currentProject = useProjectStore(s => s.currentProject)
  const projectTerminals = terminals.filter(term => term.projectId === currentProject?.id)
  const isSide = position === 'side'
  const [dualRatio, setDualRatio] = useState(loadDualRatio)
  const [dualResizing, setDualResizing] = useState(false)
  const dualSplitRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dualMode || !currentProject) return
    ensureSecondaryTerminal(currentProject.id)
  }, [dualMode, currentProject, ensureSecondaryTerminal, projectTerminals.length, activeTerminalId])

  useEffect(() => {
    try {
      localStorage.setItem(DUAL_RATIO_KEY, String(dualRatio))
    } catch {
      /* ignore */
    }
  }, [dualRatio])

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
      setDualRatio(Math.min(DUAL_RATIO_MAX, Math.max(DUAL_RATIO_MIN, next)))
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

  const layoutKey = `${position}:${terminalOpen}:${terminalHeight}:${sideSplit}:${dualTerminal}:${editorVisible}:${terminalWidth}:${dualMode ? dualRatio : 'single'}`

  const primaryEmpty = currentProject
    ? t('当前项目「{name}」暂无终端，点击标签栏 + 新建', { name: currentProject.name })
    : t('请先选择或添加项目，终端将默认基于当前项目创建')

  const terminalViews = projectTerminals.map(term => {
    const pane =
      term.id === activeTerminalId
        ? 'primary'
        : dualMode && term.id === secondaryTerminalId
          ? 'secondary'
          : null
    const isFocused =
      pane != null && (!dualMode || terminalFocusPane === pane)
    return (
      <div
        key={term.id}
        data-terminal-active={isFocused ? 'true' : undefined}
        data-terminal-pane={pane ?? undefined}
        className={
          dualMode
            ? pane
              ? `min-h-0 min-w-0 overflow-hidden ${
                  isFocused ? 'ring-2 ring-inset ring-brand/60' : ''
                }`
              : 'hidden'
            : `absolute inset-0 min-w-0 ${
                pane === 'primary' ? 'z-10 visible' : 'invisible pointer-events-none z-0'
              }`
        }
        style={
          dualMode && pane
            ? { gridArea: pane === 'primary' ? 'leftBody' : 'rightBody' }
            : undefined
        }
        onPointerDown={() => {
          if (dualMode && pane) setTerminalFocusPane(pane)
        }}
      >
        <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
          <TerminalView terminalId={term.id} isActive={isFocused} layoutKey={layoutKey} />
        </Suspense>
      </div>
    )
  })

  const body = dualMode ? (
    <div
      ref={dualSplitRef}
      className="grid min-h-0 flex-1 overflow-hidden bg-bg-deep"
      style={{
        gridTemplateColumns: `minmax(0, ${dualRatio}fr) ${DUAL_RESIZER_PX}px minmax(0, ${1 - dualRatio}fr)`,
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: `
          "leftTabs resizer rightTabs"
          "leftBody resizer rightBody"
        `,
      }}
    >
      <div style={{ gridArea: 'leftTabs' }} className="min-w-0 overflow-hidden">
        <TerminalTabs
          pane="primary"
          focused={terminalFocusPane === 'primary'}
          showPanelActions={false}
        />
      </div>
      <div style={{ gridArea: 'rightTabs' }} className="min-w-0 overflow-hidden">
        <TerminalTabs
          pane="secondary"
          focused={terminalFocusPane === 'secondary'}
          showPanelActions
        />
      </div>
      <div
        style={{ gridArea: 'resizer', gridRow: '1 / -1' }}
        className="relative z-30 min-h-0"
      >
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
      {!activeTerminalId && (
        <div
          className={`min-h-0 min-w-0 overflow-hidden ${
            terminalFocusPane === 'primary' ? 'ring-2 ring-inset ring-brand/55' : ''
          }`}
          style={{ gridArea: 'leftBody' }}
          onPointerDown={() => setTerminalFocusPane('primary')}
        >
          <EmptyState
            className="h-full"
            icon={<TerminalIcon size={28} strokeWidth={1.2} />}
            title={primaryEmpty}
          />
        </div>
      )}
      {!secondaryTerminalId && (
        <div
          className={`min-h-0 min-w-0 overflow-hidden ${
            terminalFocusPane === 'secondary' ? 'ring-2 ring-inset ring-brand/55' : ''
          }`}
          style={{ gridArea: 'rightBody' }}
          onPointerDown={() => setTerminalFocusPane('secondary')}
        >
          <EmptyState
            className="h-full"
            icon={<TerminalIcon size={28} strokeWidth={1.2} />}
            title={t('选择或新建终端显示在右侧')}
          />
        </div>
      )}
      {terminalViews}
    </div>
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
        {terminalViews}
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
