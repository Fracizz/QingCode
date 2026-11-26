import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Smartphone, SquarePen, Upload } from 'lucide-react'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { LegacyBanner } from '../LegacyImport'
import { ProjectTree } from './ProjectTree'
import { TargetSwitcher, type TargetActions } from './TargetSwitcher'

/** 侧栏（参考 Codex）：目标切换 → 新会话 → 项目/会话树 → 底部入口。 */
export function Sidebar({
  onImport,
  onMobile,
  ...targetActions
}: TargetActions & { onImport: () => void; onMobile: () => void }) {
  const width = useUi((s) => s.sidebarWidth)
  const setWidth = useUi((s) => s.setSidebarWidth)
  const selectedId = useTargets((s) => s.selectedId)
  const startDraft = useCodex((s) => s.startDraft)
  const isDraft = useCodex((s) => s.currentThreadId === null)
  const [resizing, setResizing] = useState(false)
  const [version, setVersion] = useState('')
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    void window.qn?.version().then(setVersion).catch(() => undefined)
  }, [])

  // 指针捕获拖宽：move 期间直接写 store，松手时 store 已持久化。
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width }
    setResizing(true)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setWidth(drag.current.startWidth + event.clientX - drag.current.startX)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    setResizing(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <aside
      className="qn-enter relative flex shrink-0 flex-col border-r border-qn-border bg-qn-sidebar"
      style={{ width, ['--qn-enter-order' as string]: 1 }}
    >
      <TargetSwitcher {...targetActions} />

      <div className="px-2 pt-1">
        <button
          type="button"
          className={`group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent ${
            isDraft ? 'bg-qn-hover text-qn-text' : 'text-qn-text/90'
          }`}
          onClick={() => startDraft()}
        >
          <SquarePen size={16} className="text-qn-muted" />
          <span className="flex-1 text-left">新会话</span>
          <kbd className="hidden rounded border border-qn-border-strong px-1 font-sans text-[11px] text-qn-dim group-hover:inline">
            Ctrl N
          </kbd>
        </button>
      </div>

      <ProjectTree targetId={selectedId} />

      <div className="px-2 pb-1">
        <LegacyBanner />
      </div>

      <div className="flex items-center gap-0.5 border-t border-qn-border px-2 py-1.5">
        <FooterButton label="手机连接" onClick={onMobile}>
          <Smartphone size={15} />
        </FooterButton>
        <FooterButton label="导入旧版" onClick={onImport}>
          <Upload size={15} />
        </FooterButton>
        {version && <span className="ml-auto shrink-0 pr-1.5 text-[11px] text-qn-dim">v{version}</span>}
      </div>

      <div
        className="qn-resizer"
        data-active={resizing}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setWidth(Number.NaN)}
      />
    </aside>
  )
}

function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent"
      onClick={onClick}
    >
      {children}
      <span className="truncate">{label}</span>
    </button>
  )
}
