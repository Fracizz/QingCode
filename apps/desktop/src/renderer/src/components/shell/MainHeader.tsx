import { sessionStatus } from '@qn/codex-client'
import { Check, FileText, FolderGit2, MessageCircleMore, MoreHorizontal, PanelRightOpen, RotateCw, SquarePen, Terminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useFiles } from '../../features/files'
import { TERMINAL_SHORTCUT, useTerminalDock } from '../../features/terminal/dockState'
import { useDock } from '../../store/dock'
import { sideChatExcerpt } from '../../lib/annotations'
import { sessionKey } from '../../lib/agents'
import { currentSideChat, useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useUi } from '../../store/ui'
import { AgentIcon } from '../AgentIcon'
import { Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../primitives'
import { IconButton } from '../ui'
import { SessionStatusBadge } from './SessionStatusBadge'
import { DOCK_TOOLS } from './WorkspaceDock'

const CHAT_WIDTH_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'wide', label: '宽屏' },
] as const

/** 主区顶栏（参考 Codex）：当前会话标题 + 所在项目，右侧会话级操作。 */
export function MainHeader({ subagents }: { subagents?: ReactNode }) {
  const projects = useProjects((s) => s.projects)
  const projectId = useProjects((s) => s.selectedId)
  const agent = useCodex((s) => s.currentAgent)
  const threadId = useCodex((s) => s.currentThreadId)
  const side = useCodex(currentSideChat)
  const sideView = useCodex((s) => side?.threadId
    ? s.sessions[sessionKey(side.targetId, side.agent)]?.state.threads[side.threadId] : undefined)
  const threads = useCodex((s) => s.threads)
  const startDraft = useCodex((s) => s.startDraft)
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const view = useCodex((s) => {
    if (!s.currentTargetId || !s.currentThreadId) return undefined
    return s.sessions[sessionKey(s.currentTargetId, s.currentAgent)]?.state.threads[s.currentThreadId]
  })

  const dockTool = useDock((s) => s.tool)
  const terminalOpen = useTerminalDock((s) => s.open)
  const filesOpen = useFiles((s) => s.open)
  const fileTabs = useFiles((s) => s.tabs.length)
  const chatWidth = useUi((s) => s.chatWidth)
  const setChatWidth = useUi((s) => s.setChatWidth)
  const project = projects.find((item) => item.id === projectId)
  const thread = threads.find((item) => item.id === threadId && item.agent === agent)
  const title = thread?.title ?? '新会话'

  const sideStatus = side?.expired ? '已结束'
    : sideView?.pendingApprovals.length ? '待审批' : sideView?.status === 'running' ? '运行中' : null

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-4 text-ui-md">
      <MessageCircleMore size={16} strokeWidth={1.75} className="shrink-0 text-qn-muted" aria-hidden />
      <span className="min-w-0 truncate font-medium text-qn-text">{title}</span>
      {project && (
        <span className="hidden max-w-[16rem] shrink-0 items-center gap-1 truncate text-ui text-qn-dim sm:flex" title={project.path}>
          <FolderGit2 size={13} /> {project.name}
        </span>
      )}
      {threadId && <span role="status"><SessionStatusBadge status={sessionStatus(view, thread?.activity)} /></span>}
      <div className="flex-1" />
      {threadId && <AgentIcon agent={agent} size={13} label />}
      {subagents}
      {threadId && (
        <>
          {sideStatus && <span role="status" className="text-ui-sm text-qn-muted">侧聊{sideStatus}</span>}
          <IconButton
            label="侧边对话"
            tooltipSide="bottom"
            aria-expanded={!!side?.open}
            onClick={() => useCodex.getState().openSideChat(side ? undefined : sideChatExcerpt(view?.items ?? []))}
          >
            <PanelRightOpen size={15} />
          </IconButton>
        </>
      )}
      {fileTabs > 0 && (
        <IconButton
          label={filesOpen ? '收起文件面板' : '打开文件面板'}
          tooltipSide="bottom"
          onClick={() => useFiles.getState().setOpen(!filesOpen)}
          className={filesOpen ? 'bg-qn-active text-qn-text' : undefined}
        >
          <FileText size={15} />
        </IconButton>
      )}
      {DOCK_TOOLS.map((tool) => (
        <IconButton
          key={tool.id}
          label={`${tool.label}（${tool.hint}）`}
          tooltipSide="bottom"
          onClick={() => useDock.getState().toggleTool(tool.id)}
          className={dockTool === tool.id ? 'bg-qn-active text-qn-text' : undefined}
        >
          {tool.icon}
        </IconButton>
      ))}
      <IconButton
        label={`终端（${TERMINAL_SHORTCUT}）`}
        tooltipSide="bottom"
        aria-expanded={terminalOpen}
        className={terminalOpen ? 'bg-qn-active text-qn-text' : undefined}
        onClick={useTerminalDock.getState().toggle}
      >
        <Terminal size={15} />
      </IconButton>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label="会话操作" tooltipSide="bottom">
            <MoreHorizontal size={16} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<SquarePen size={14} />} hint="Ctrl N" onSelect={() => startDraft()}>
            新会话
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<RotateCw size={14} />} onSelect={() => void refreshThreads()}>
            刷新会话列表
          </MenuItem>
          <MenuSeparator />
          <MenuGroup aria-label="聊天宽度">
            <MenuLabel>聊天宽度</MenuLabel>
            {CHAT_WIDTH_OPTIONS.map(({ value, label }) => (
              <MenuItem
                key={value}
                role="menuitemradio"
                aria-checked={chatWidth === value}
                hint={chatWidth === value ? <Check size={14} aria-hidden /> : undefined}
                onSelect={() => setChatWidth(value)}
              >
                {label}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuContent>
      </Menu>
    </div>
  )
}
