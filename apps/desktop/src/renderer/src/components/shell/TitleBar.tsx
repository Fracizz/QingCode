import { ChevronRight, Monitor, PanelLeft, Server } from 'lucide-react'
import { windowControlsSide } from '../../lib/layout'
import { targetDotClass } from '../../lib/targetStatus'
import { useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { RateLimitBadge } from '../RateLimitBadge'
import { Logo } from './Logo'

/**
 * 自绘标题栏（替代系统标题栏与菜单栏）。
 * 左段与侧栏同宽放品牌与侧栏开关，形成一条贯穿的列；中段是"目标 › 项目 › 会话"面包屑；右段放额度徽标，最右给系统窗口按钮留位。
 */
export function TitleBar() {
  const sidebarWidth = useUi((s) => s.sidebarWidth)
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const toggleSidebar = useUi((s) => s.toggleSidebar)

  const targets = useTargets((s) => s.targets)
  const selectedId = useTargets((s) => s.selectedId)
  const targetState = useTargets((s) => s.states[s.selectedId]?.state ?? 'idle')
  const projects = useProjects((s) => s.projects)
  const projectId = useProjects((s) => s.selectedId)
  const threads = useCodex((s) => s.threads)
  const threadId = useCodex((s) => s.currentThreadId)
  const running = useCodex((s) => {
    const targetId = s.currentTargetId
    const id = s.currentThreadId
    return Boolean(targetId && id && s.sessions[targetId]?.state.threads[id]?.status === 'running')
  })

  const side = windowControlsSide(window.qn?.platform)
  const target = targets.find((item) => item.id === selectedId)
  const project = projects.find((item) => item.id === projectId)
  const threadTitle = threadId ? (threads.find((item) => item.id === threadId)?.title ?? '新会话') : null
  const TargetIcon = target?.kind === 'ssh' ? Server : Monitor

  return (
    <header
      className="qn-drag qn-enter relative z-30 flex h-[38px] shrink-0 items-center border-b border-qn-border bg-qn-chrome text-xs select-none"
      style={{ ['--qn-enter-order' as string]: 0 }}
    >
      {side === 'left' && <div className="qn-traffic-spacer" />}

      <div
        className="flex h-full shrink-0 items-center gap-2 pl-3 pr-1.5"
        style={{ width: collapsed ? undefined : sidebarWidth }}
      >
        <Logo size={16} />
        <span className="font-semibold tracking-wide text-qn-text">QingCode</span>
        <span className="rounded border border-qn-brand/40 px-1 text-[10px] leading-4 text-qn-brand">Next</span>
        <button
          type="button"
          className={`${collapsed ? 'ml-2' : 'ml-auto'} inline-flex h-7 w-7 items-center justify-center rounded-md text-qn-muted hover:bg-qn-hover hover:text-qn-text`}
          title={collapsed ? '展开侧栏 (Ctrl+B)' : '收起侧栏 (Ctrl+B)'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-pressed={!collapsed}
          onClick={toggleSidebar}
        >
          <PanelLeft size={15} strokeWidth={1.6} />
        </button>
      </div>

      <nav className="flex min-w-0 flex-1 items-center gap-1 px-3 text-qn-muted" aria-label="当前位置">
        <span className="flex shrink-0 items-center gap-1.5 text-qn-text">
          <span className={`h-1.5 w-1.5 rounded-full ${targetDotClass[targetState]}`} />
          <TargetIcon size={13} strokeWidth={1.7} className="text-qn-muted" />
          {target?.name ?? '本机'}
        </span>
        {project && (
          <>
            <ChevronRight size={12} className="shrink-0 text-qn-dim" />
            <span className="max-w-[16rem] shrink-0 truncate" title={project.path}>
              {project.name}
            </span>
          </>
        )}
        {threadTitle && (
          <>
            <ChevronRight size={12} className="shrink-0 text-qn-dim" />
            <span className="min-w-0 truncate text-qn-text">{threadTitle}</span>
          </>
        )}
        {running && (
          <span className="ml-2 flex shrink-0 items-center gap-1 rounded-full bg-qn-brand/10 px-2 py-0.5 text-[10px] text-qn-brand">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-qn-brand" /> 运行中
          </span>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-1.5 pr-2" data-no-drag>
        <RateLimitBadge targetId={selectedId} />
      </div>

      {side === 'right' && <div className="qn-wco-spacer" />}
    </header>
  )
}
