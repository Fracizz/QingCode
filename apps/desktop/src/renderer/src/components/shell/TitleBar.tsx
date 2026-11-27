import { FolderOpen, MessageSquare, PanelLeft } from 'lucide-react'
import { t } from '@qn/codex-client'
import { windowControlsSide } from '../../lib/layout'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { useDock } from '../../store/dock'
import { useUi } from '../../store/ui'
import { RateLimitBadge } from '../RateLimitBadge'
import { targetDisplayName } from '../targetName'
import { IconButton } from '../ui'
import { Logo } from './Logo'

/**
 * 自绘标题栏（参考 Codex Windows 版）：通栏一条，左侧侧栏开关 + 品牌，右侧"目标 · 额度"胶囊，最右给系统窗口按钮留位。
 * 会话标题不放这里，放主区顶栏，这样侧栏收起/展开时标题位置不跳。
 */
export function TitleBar({ showWorkspace = true }: { showWorkspace?: boolean }) {
  const view = useDock((s) => s.view)
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const targets = useTargets((s) => s.targets)
  const selectedId = useTargets((s) => s.selectedId)
  const agent = useCodex((s) => s.currentAgent)
  const threadId = useCodex((s) => s.currentThreadId)

  const side = windowControlsSide(window.qn?.platform)
  const target = targets.find((item) => item.id === selectedId)

  return (
    <header
      className="qn-drag qn-enter relative z-30 flex h-[38px] shrink-0 items-center gap-1 bg-qn-chrome pl-2 text-ui select-none"
      style={{ ['--qn-enter-order' as string]: 0 }}
    >
      {side === 'left' && <div className="qn-traffic-spacer" />}
      {showWorkspace && (
        <IconButton
          label={collapsed ? t('展开侧栏 (Ctrl+B)') : t('收起侧栏 (Ctrl+B)')}
          className="h-7 w-7"
          aria-pressed={!collapsed}
          onClick={toggleSidebar}
        >
          <PanelLeft size={16} strokeWidth={1.6} />
        </IconButton>
      )}
      <div className="ml-1.5 flex items-center gap-2">
        <Logo size={16} />
        <span className="font-semibold tracking-wide text-qn-text">QingCode</span>
        <span className="rounded-md border border-qn-border px-1 text-ui-xs leading-4 text-qn-brand">Next</span>
      </div>

      {showWorkspace && (
        <nav aria-label={t('工作视图')} className="ml-4 flex gap-0.5 rounded-md bg-qn-sidebar p-0.5" data-no-drag>
          {(['chat', 'files'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={view === mode}
              className={`flex items-center gap-1.5 rounded px-2.5 py-0.5 hover:bg-qn-hover ${view === mode ? 'bg-qn-active text-qn-text' : 'text-qn-muted'}`}
              onClick={() => useDock.getState().toggleView(mode)}
            >
              {mode === 'chat' ? <MessageSquare size={13} /> : <FolderOpen size={13} />}
              {mode === 'chat' ? t('对话') : t('文件')}
            </button>
          ))}
        </nav>
      )}
      <div className="flex-1" />

      {showWorkspace && (
        <div className="flex shrink-0 items-center pr-2" data-no-drag>
          <RateLimitBadge targetId={selectedId} agent={agent} threadId={threadId} prefix={target ? targetDisplayName(target) : undefined} />
        </div>
      )}

      {side === 'right' && <div className="qn-wco-spacer" />}
    </header>
  )
}
