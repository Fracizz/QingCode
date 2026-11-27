import { useEffect, useState, type ReactNode } from 'react'
import { Settings, Smartphone, SquarePen, Upload } from 'lucide-react'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../lib/layout'
import { LegacyBanner } from '../LegacyImport'
import { ResizeHandle } from '../ResizeHandle'
import { ProjectTree } from './ProjectTree'
import { TargetSwitcher, type TargetActions } from './TargetSwitcher'

/** 侧栏（参考 Codex）：目标切换 → 新会话 → 项目/会话树 → 底部入口。 */
export function Sidebar({
  onImport,
  onMobile,
  onSettings,
  ...targetActions
}: TargetActions & { onImport: () => void; onMobile: () => void; onSettings: () => void }) {
  const width = useUi((s) => s.sidebarWidth)
  const setWidth = useUi((s) => s.setSidebarWidth)
  const selectedId = useTargets((s) => s.selectedId)
  const startDraft = useCodex((s) => s.startDraft)
  const isDraft = useCodex((s) => s.currentThreadId === null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.qn?.version().then(setVersion).catch(() => undefined)
  }, [])

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
          <kbd className="hidden rounded-md border border-qn-border-strong px-1 font-sans text-[11px] text-qn-dim group-hover:inline">
            Ctrl N
          </kbd>
        </button>
      </div>

      <ProjectTree targetId={selectedId} />

      <div className="px-2 pb-1">
        <LegacyBanner />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-qn-border px-2 py-1.5">
        <div className="flex max-w-full flex-wrap gap-0.5">
          <FooterButton label="手机连接" onClick={onMobile}>
            <Smartphone size={14} />
          </FooterButton>
          <FooterButton label="导入旧版" onClick={onImport}>
            <Upload size={14} />
          </FooterButton>
          <FooterButton label="设置" onClick={onSettings}>
            <Settings size={14} />
          </FooterButton>
        </div>
        {version && (
          <span className="ml-auto max-w-full truncate px-1 text-[11px] text-qn-dim" title={`v${version}`}>
            v{version}
          </span>
        )}
      </div>

      <ResizeHandle
        orientation="vertical"
        className="absolute inset-y-0 -right-1"
        label="调整侧栏宽度"
        value={width}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        onChange={setWidth}
        onReset={() => setWidth(Number.NaN)}
      />
    </aside>
  )
}

function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 rounded-lg px-1 py-1.5 text-xs whitespace-nowrap text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent"
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}
