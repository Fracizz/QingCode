import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Smartphone, Upload } from 'lucide-react'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { LegacyBanner } from '../LegacyImport'
import { ProjectTree } from './ProjectTree'
import { TargetSwitcher, type TargetActions } from './TargetSwitcher'

export function Sidebar({
  onImport,
  onMobile,
  ...targetActions
}: TargetActions & { onImport: () => void; onMobile: () => void }) {
  const width = useUi((s) => s.sidebarWidth)
  const setWidth = useUi((s) => s.setSidebarWidth)
  const selectedId = useTargets((s) => s.selectedId)
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

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
      <ProjectTree targetId={selectedId} />

      <div className="px-2 pb-1">
        <LegacyBanner />
      </div>

      <div className="flex items-center gap-1 border-t border-qn-border px-2 py-1.5">
        <FooterButton label="手机连接" onClick={onMobile}>
          <Smartphone size={14} />
        </FooterButton>
        <FooterButton label="导入旧版 QingCode" onClick={onImport}>
          <Upload size={14} />
        </FooterButton>
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

function FooterButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-qn-muted hover:bg-qn-hover hover:text-qn-text"
      onClick={onClick}
    >
      {children}
      <span className="truncate">{label}</span>
    </button>
  )
}
