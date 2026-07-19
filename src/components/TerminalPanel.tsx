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
  TERMINAL_MIN_HEIGHT,
  terminalResizerHint,
} from '../lib/panelLayout'

const TerminalView = lazy(() => import('./Terminal'))

function LazyFallback({ className = 'flex-1 bg-bg' }: { className?: string }) {
  return <div className={className} aria-hidden="true" />
}

export interface TerminalPanelProps {
  terminalOpen: boolean
  terminalHeight: number
  isTerminalResizing: boolean
  /** Same ref the drag handler updates — keeps React style.height in sync mid-drag. */
  dragHeightRef: MutableRefObject<number>
  onResizerMouseDown: (e: React.MouseEvent) => void
  terminalPanelRef: RefObject<HTMLDivElement | null>
}

export default function TerminalPanel({
  terminalOpen,
  terminalHeight,
  isTerminalResizing,
  dragHeightRef,
  onResizerMouseDown,
  terminalPanelRef,
}: TerminalPanelProps) {
  const { t } = useI18n()
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const currentProject = useProjectStore(s => s.currentProject)
  const projectTerminals = terminals.filter(term => term.projectId === currentProject?.id)
  const liveHeight = isTerminalResizing ? dragHeightRef.current : terminalHeight

  return (
    <>
      {terminalOpen && (
        <PanelResizer
          orientation="horizontal"
          active={isTerminalResizing}
          tooltip={terminalResizerHint(liveHeight)}
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
        className={`flex-col flex-shrink-0 min-h-0 overflow-hidden border-t border-border ${
          isTerminalResizing ? '' : 'transition-[height,opacity] duration-200 ease-out'
        } ${
          terminalOpen ? 'flex opacity-100' : 'opacity-0 pointer-events-none h-0 border-t-0'
        }`}
        style={{
          height: terminalOpen ? liveHeight : 0,
        }}
      >
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
    </>
  )
}
