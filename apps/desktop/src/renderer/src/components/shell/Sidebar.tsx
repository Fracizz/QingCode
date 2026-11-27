import { useEffect, useState, type ReactNode } from 'react'
import { Settings, Smartphone, SquarePen, Upload } from 'lucide-react'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../lib/layout'
import { LegacyBanner } from '../LegacyImport'
import { ResizeHandle } from '../ResizeHandle'
import { ErrorNote } from '../ui'
import { ProjectTree } from './ProjectTree'
import { TargetPicker, TargetSectionHeader, type TargetActions } from './TargetSwitcher'
import { sidebarTargets } from '../../store/targets'

const COLLAPSED_KEY = 'qn-sidebar-collapsed-targets'

function readCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * 侧栏（参考 Codex）：新会话 → 工作区（多个目标同时铺开，每个目标下挂项目/会话树）→ 底部入口。
 * 同时操作多台远程机器时不用来回切换：点哪个目标下的项目，主区就切到那个目标。
 */
export function Sidebar({
  onImport,
  onMobile,
  onSettings,
  ...targetActions
}: TargetActions & { onImport: () => void; onMobile: () => void; onSettings: () => void }) {
  const width = useUi((s) => s.sidebarWidth)
  const setWidth = useUi((s) => s.setSidebarWidth)
  const targets = useTargets((s) => s.targets)
  const sidebarIds = useTargets((s) => s.sidebarIds)
  const selectedId = useTargets((s) => s.selectedId)
  const loaded = useTargets((s) => s.loaded)
  const loadError = useTargets((s) => s.error)
  const shown = sidebarTargets(targets, sidebarIds, selectedId)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggleCollapsed = (id: string) =>
    setCollapsed((list) => {
      const next = list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        // 存储不可用时只在本次运行内生效。
      }
      return next
    })
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
      <div className="px-2 pt-2">
        <button
          type="button"
          className={`group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-ui-md outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent ${
            isDraft ? 'bg-qn-hover text-qn-text' : 'text-qn-text/90'
          }`}
          onClick={() => startDraft()}
        >
          <SquarePen size={16} className="text-qn-muted" />
          <span className="flex-1 text-left">新会话</span>
          <kbd className="hidden rounded-md border border-qn-border-strong px-1 font-sans text-ui-xs text-qn-dim group-hover:inline">
            Ctrl N
          </kbd>
        </button>
      </div>

      <div className="flex items-center justify-between pb-0.5 pl-4 pr-2 pt-3">
        <span className="text-ui text-qn-muted">工作区</span>
        <TargetPicker {...targetActions} />
      </div>

      <div className="qn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded && !loadError && (
          <div className="space-y-1.5 px-2 py-2">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-8 animate-pulse rounded-lg bg-qn-panel" />
            ))}
          </div>
        )}
        {shown.map((target) => {
          const isCollapsed = collapsed.includes(target.id)
          return (
            <section key={target.id} aria-label={target.name}>
              <TargetSectionHeader
                target={target}
                actions={targetActions}
                collapsed={isCollapsed}
                onToggle={() => toggleCollapsed(target.id)}
              />
              {!isCollapsed && <ProjectTree targetId={target.id} onSelectTarget={targetActions.onSelect} />}
            </section>
          )
        })}
        <ErrorNote message={loadError} variant="compact" className="mx-1 mt-1.5" />
      </div>

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
        <FooterButton label="设置" onClick={onSettings}>
          <Settings size={15} />
        </FooterButton>
        {version && <span className="ml-auto shrink-0 pr-1.5 text-ui-xs text-qn-dim">v{version}</span>}
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
      className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent"
      onClick={onClick}
    >
      {children}
      <span className="truncate">{label}</span>
    </button>
  )
}
