import { lazy, Suspense, type RefObject } from 'react'
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
  sideSplit?: 'equal' | 'custom'
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
  isTerminalResizing,
  layoutSwitching = false,
  onResizerPointerDown,
  onWidthResizerPointerDown,
  terminalPanelRef,
}: TerminalPanelProps) {
  const skipDockTransition = isTerminalResizing || layoutSwitching
  const sideWidthEqual = sideSplit === 'equal'
  const { t } = useI18n()
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const currentProject = useProjectStore(s => s.currentProject)
  const projectTerminals = terminals.filter(term => term.projectId === currentProject?.id)
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
        {projectTerminals.map(term => {
          const isActive = term.id === activeTerminalId
          return (
            <div
              key={term.id}
              data-terminal-active={isActive ? 'true' : undefined}
              className={`absolute inset-0 min-w-0 ${
                isActive ? 'z-10 visible' : 'invisible pointer-events-none z-0'
              }`}
            >
              <Suspense fallback={<LazyFallback className="h-full bg-bg-deep" />}>
                <TerminalView
                  terminalId={term.id}
                  isActive={isActive}
                  layoutKey={`${position}:${terminalOpen}:${terminalHeight}:${sideSplit}:${terminalWidth}`}
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
        data-terminal-dock="side"
        data-terminal-position="side"
        className={`flex h-full min-h-0 overflow-hidden ${
          sideWidthEqual ? 'min-w-0 w-full' : 'flex-shrink-0'
        } ${
          skipDockTransition ? '' : 'transition-[width,opacity] duration-200 ease-out'
        } ${terminalOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{
          width: terminalOpen ? (sideWidthEqual ? '100%' : terminalWidth) : 0,
        }}
      >
        <div
          className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-r border-border"
        >
          {body}
        </div>
        {terminalOpen && (
          <PanelResizer
            orientation="vertical"
            active={isTerminalResizing}
            tooltip={terminalWidthResizerHint(terminalWidth, t)}
            tooltipSide="right"
            onPointerDown={onWidthResizerPointerDown}
            ariaValueNow={terminalWidth}
            ariaValueMin={TERMINAL_MIN_WIDTH}
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
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border"
      >
        {body}
      </div>
    </div>
  )
}
