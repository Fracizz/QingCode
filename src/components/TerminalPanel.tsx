import { lazy, Suspense, type MutableRefObject, type RefObject } from 'react'
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
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
  terminalResizerHint,
  terminalWidthResizerHint,
} from '../lib/panelLayout'

const TerminalView = lazy(() => import('./Terminal'))

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
}

export type TerminalPanelPosition = 'bottom' | 'side'

export interface TerminalPanelProps {
  position?: TerminalPanelPosition
  terminalOpen: boolean
  terminalHeight: number
  terminalWidth: number
  isTerminalResizing: boolean
  /** Same ref the drag handler updates — keeps React style in sync mid-drag. */
  dragHeightRef: MutableRefObject<number>
  dragWidthRef: MutableRefObject<number>
  onResizerMouseDown: (e: React.MouseEvent) => void
  onWidthResizerMouseDown: (e: React.MouseEvent) => void
  terminalPanelRef: RefObject<HTMLDivElement | null>
}

export default function TerminalPanel({
  position = 'bottom',
  terminalOpen,
  terminalHeight,
  terminalWidth,
  isTerminalResizing,
  dragHeightRef,
  dragWidthRef,
  onResizerMouseDown,
  onWidthResizerMouseDown,
  terminalPanelRef,
}: TerminalPanelProps) {
  const { t } = useI18n()
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const currentProject = useProjectStore(s => s.currentProject)
  const projectTerminals = terminals.filter(term => term.projectId === currentProject?.id)
  const liveHeight = isTerminalResizing ? dragHeightRef.current : terminalHeight
  const liveWidth = isTerminalResizing ? dragWidthRef.current : terminalWidth
  const isSide = position === 'side'

  const body = (
    <>
      <TerminalTabs />
      <div className="relative flex-1 min-w-0 bg-bg-deep overflow-hidden min-h-0">
        {projectTerminals.length === 0 && (
          <div className="absolute inset-0">
            <EmptyState
              className="h-full"
              icon={<TerminalIcon size={28} strokeWidth={1.2} />}
              title={
                currentProject
                  ? t('当前项目「{name}」暂无终端，点击标签栏 + 新建', { name: currentProject.name })
                  : t('请先选择或添加项目，终端将默认基于当前项目创建')
              }
            />
          </div>
        )}
        {/* Only mount the current project's terminals to avoid xterm cost across projects. */}
        {projectTerminals.map(term => {
          const isActive = term.id === activeTerminalId
          return (
            <div
              key={term.id}
              className={`absolute inset-0 min-w-0 ${
                isActive ? 'z-10 visible' : 'invisible pointer-events-none z-0'
              }`}
            >
              <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
                <TerminalView
                  terminalId={term.id}
                  isActive={isActive}
                  layoutKey={`${position}:${terminalOpen}:${terminalHeight}:${terminalWidth}`}
                />
              </Suspense>
            </div>
          )
        })}
      </div>
    </>
  )

  if (isSide) {
    return (
      <div
        ref={terminalPanelRef}
        data-terminal-panel
        data-terminal-position="side"
        className={`flex flex-shrink-0 h-full min-h-0 overflow-hidden ${
          isTerminalResizing ? '' : 'transition-[width,opacity] duration-200 ease-out'
        } ${
          terminalOpen
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
        style={{ width: terminalOpen ? liveWidth : 0 }}
      >
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-r border-border">
          {body}
        </div>
        {terminalOpen && (
          <PanelResizer
            orientation="vertical"
            active={isTerminalResizing}
            tooltip={terminalWidthResizerHint(liveWidth, t)}
            tooltipSide="right"
            onMouseDown={onWidthResizerMouseDown}
            ariaValueNow={liveWidth}
            ariaValueMin={TERMINAL_MIN_WIDTH}
            ariaValueMax={getTerminalMaxWidth()}
          />
        )}
      </div>
    )
  }

  return (
    <>
      {terminalOpen && (
        <PanelResizer
          orientation="horizontal"
          active={isTerminalResizing}
          tooltip={terminalResizerHint(liveHeight, t)}
          tooltipSide="top"
          onMouseDown={onResizerMouseDown}
          ariaValueNow={liveHeight}
          ariaValueMin={TERMINAL_MIN_HEIGHT}
          ariaValueMax={getTerminalMaxHeight()}
        />
      )}

      <div
        ref={terminalPanelRef}
        data-terminal-panel
        data-terminal-position="bottom"
        className={`flex-col flex-shrink-0 min-h-0 overflow-hidden border-t border-border ${
          isTerminalResizing ? '' : 'transition-[height,opacity] duration-200 ease-out'
        } ${
          terminalOpen ? 'flex opacity-100' : 'opacity-0 pointer-events-none h-0 border-t-0'
        }`}
        style={{
          height: terminalOpen ? liveHeight : 0,
        }}
      >
        {body}
      </div>
    </>
  )
}
