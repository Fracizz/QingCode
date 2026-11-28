import { t, sessionStatus } from '@qn/codex-client'
import { Check, FileText, FolderGit2, ListTree, MessageCircleMore, MoreHorizontal, PanelRightOpen, Plug, RotateCw, SquarePen, Terminal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useFiles } from '../../features/files'
import { useTerminalDock } from '../../features/terminal/dockState'
import { useDock } from '../../store/dock'
import { sideChatExcerpt } from '../../lib/annotations'
import { sessionKey } from '../../lib/agents'
import { threadKey } from '../../lib/threads'
import { currentSideChat, currentThreads, useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useThreadPrefs } from '../../store/threadPrefs'
import { useUi } from '../../store/ui'
import { AgentIcon } from '../AgentIcon'
import { McpStatusDialog } from '../McpStatusDialog'
import { Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from '../primitives'
import { IconButton } from '../ui'
import { SessionStatusBadge } from './SessionStatusBadge'
import { DOCK_TOOLS } from './WorkspaceDock'

const CHAT_WIDTH_OPTIONS = [
  { value: 'default', label: t('默认') },
  { value: 'wide', label: t('宽屏') },
] as const

/** 主区顶栏（参考 Codex）：当前会话标题 + 所在项目，右侧会话级操作。 */
export function MainHeader({ subagents }: { subagents?: ReactNode }) {
  const projects = useProjects((s) => s.projects)
  const projectId = useProjects((s) => s.selectedId)
  const targetId = useCodex((s) => s.currentTargetId)
  const cwd = useCodex((s) => s.currentCwd)
  const agent = useCodex((s) => s.currentAgent)
  const threadId = useCodex((s) => s.currentThreadId)
  const mcpRpc = useCodex((s) => {
    const session = targetId ? s.sessions[sessionKey(targetId, agent)] : undefined
    return session?.opened && session.openedConfig?.mcpStatus ? session.rpc : null
  })
  const [mcpOpen, setMcpOpen] = useState<string | null>(null)
  const mcpKey = targetId && threadId ? JSON.stringify([targetId, agent, threadId]) : null
  const side = useCodex(currentSideChat)
  const sideStatus = useCodex((s) => {
    if (!side || side.open) return null
    if (side.expired) return t('侧聊已结束')
    const view = side.threadId ? s.sessions[sessionKey(side.targetId, side.agent)]?.state.threads[side.threadId] : undefined
    if (view?.pendingApprovals.length) {
      return view.pendingApprovals.every((item) => item.questions?.length) ? t('侧聊待回答') : t('侧聊待审批')
    }
    return view?.status === 'running' ? t('侧聊运行中') : null
  })
  const threads = useCodex(currentThreads)
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
  const key = threadId ? threadKey(agent, threadId) : null
  const localName = useThreadPrefs((s) => targetId && key ? s.byTarget[targetId]?.names[key] : undefined)
  const project = projects.find((item) => item.id === projectId && item.targetId === targetId && item.path === cwd)
  const thread = threads.find((item) => item.id === threadId && item.agent === agent)
  const title = localName ?? thread?.title ?? (threadId ? t('未命名会话') : t('新会话'))
  const listLabel = threadId ? t('在侧栏定位当前会话') : t('打开项目会话列表')

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-4 text-ui-md">
      {project ? (
        <Tip label={listLabel} side="bottom" align="start">
          <button
            type="button"
            aria-label={t('{label}：{title}', { label: listLabel, title })}
            className="-ml-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left font-medium text-qn-text outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-outline-hover"
            onClick={() => {
              useProjects.getState().setExpanded(project, true)
              useUi.getState().revealThreadList({ targetId: project.targetId, projectId: project.id, threadKey: key })
            }}
          >
            <ListTree size={16} strokeWidth={1.75} className="shrink-0 text-qn-muted" aria-hidden />
            <span className="truncate">{title}</span>
          </button>
        </Tip>
      ) : (
        <>
          <MessageCircleMore size={16} strokeWidth={1.75} className="shrink-0 text-qn-muted" aria-hidden />
          <span className="min-w-0 truncate font-medium text-qn-text">{title}</span>
        </>
      )}
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
          {sideStatus && <span role="status" className="shrink-0 whitespace-nowrap text-ui-sm text-qn-muted">{sideStatus}</span>}
          <IconButton
            label={t('侧边对话')}
            tooltipSide="bottom"
            aria-expanded={!!side?.open}
            className={side?.open ? 'bg-qn-active text-qn-text' : undefined}
            onClick={() => useCodex.getState().openSideChat(side ? undefined : sideChatExcerpt(view?.items ?? []))}
          >
            <PanelRightOpen size={15} />
          </IconButton>
        </>
      )}
      {fileTabs > 0 && (
        <IconButton
          label={filesOpen ? t('收起文件面板') : t('打开文件面板')}
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
          label={t('{label}（{hint}）', { label: tool.label, hint: tool.hint })}
          tooltipSide="bottom"
          onClick={() => useDock.getState().toggleTool(tool.id)}
          className={dockTool === tool.id ? 'bg-qn-active text-qn-text' : undefined}
        >
          {tool.icon}
        </IconButton>
      ))}
      <IconButton
        label={t('打开新终端')}
        tooltipSide="bottom"
        aria-expanded={terminalOpen}
        className={terminalOpen ? 'bg-qn-active text-qn-text' : undefined}
        onClick={() => useTerminalDock.getState().openNew(targetId && cwd ? { targetId, cwd } : null)}
      >
        <Terminal size={15} />
      </IconButton>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t('会话操作')} tooltipSide="bottom">
            <MoreHorizontal size={16} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<SquarePen size={14} />} hint="Ctrl N" onSelect={() => startDraft()}>
            {t('新会话')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<RotateCw size={14} />} onSelect={() => void refreshThreads()}>
            {t('刷新会话列表')}
          </MenuItem>
          {mcpRpc && mcpKey && <MenuItem icon={<Plug size={14} />} onSelect={() => setMcpOpen(mcpKey)}>
            {t('MCP 服务状态')}
          </MenuItem>}
          <MenuSeparator />
          <MenuGroup aria-label={t('聊天宽度')}>
            <MenuLabel>{t('聊天宽度')}</MenuLabel>
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
      {mcpRpc && threadId && mcpKey === mcpOpen && <McpStatusDialog key={mcpKey} threadId={threadId} agent={agent}
        rpc={mcpRpc} onClose={() => setMcpOpen(null)} />}
    </div>
  )
}
