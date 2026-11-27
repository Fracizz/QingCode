import { FolderTree, GitBranch, Play, Search, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { FileExplorer, SearchPanel } from '../../features/explorer'
import { FilePane, useFiles } from '../../features/files'
import { GitPanel } from '../../features/git'
import { RunPanel } from '../../features/run'
import { cn } from '../../lib/cn'
import { useCodex } from '../../store/codex'
import { FILES_MAX, FILES_MIN, TOOL_MAX, TOOL_MIN, useDock, type DockTool } from '../../store/dock'
import { useTargets } from '../../store/targets'
import { ResizeHandle } from '../ResizeHandle'
import { IconButton } from '../ui'

export const DOCK_TOOLS: Array<{ id: DockTool; label: string; hint: string; icon: ReactNode }> = [
  { id: 'explorer', label: '资源管理器', hint: 'Ctrl Shift E', icon: <FolderTree size={15} /> },
  { id: 'search', label: '搜索', hint: 'Ctrl Shift F', icon: <Search size={15} /> },
  { id: 'git', label: '源代码管理', hint: 'Ctrl Shift G', icon: <GitBranch size={15} /> },
  { id: 'run', label: '运行', hint: 'Ctrl Shift R', icon: <Play size={15} /> },
]

/** 文件/Git 功能作用于当前项目；未选项目或目标未连接时给出提示。 */
export function useWorkspaceScope(): { targetId: string; cwd: string } | { reason: string } {
  const targetId = useCodex((s) => s.currentTargetId)
  const cwd = useCodex((s) => s.currentCwd)
  const ready = useTargets((s) => (targetId ? s.states[targetId]?.state === 'ready' : false))
  if (!targetId || !cwd) return { reason: '先在左侧选择一个项目' }
  if (!ready) return { reason: '目标未连接' }
  return { targetId, cwd }
}

function ToolBody({ tool }: { tool: DockTool }) {
  const scope = useWorkspaceScope()
  if ('reason' in scope) {
    return <div className="px-4 py-6 text-center text-ui text-qn-dim">{scope.reason}</div>
  }
  // key 按项目区分，切换项目时重建内部状态。
  const key = `${scope.targetId}:${scope.cwd}`
  if (tool === 'explorer') return <FileExplorer key={key} targetId={scope.targetId} root={scope.cwd} className="min-h-0 flex-1" />
  if (tool === 'search') return <SearchPanel key={key} targetId={scope.targetId} root={scope.cwd} className="min-h-0 flex-1" />
  if (tool === 'run') return <RunPanel key={key} targetId={scope.targetId} cwd={scope.cwd} />
  return <GitPanel key={key} targetId={scope.targetId} cwd={scope.cwd} />
}

/** 右侧停靠栏：工具列（资源管理器 / 搜索 / Git）+ 文件查看面板，各自可拖动宽度。 */
export function WorkspaceDock() {
  const scope = useWorkspaceScope()
  const tool = useDock((s) => s.tool)
  const filesWidth = useDock((s) => s.filesWidth)
  const toolWidth = useDock((s) => s.toolWidth)
  const filesOpen = useFiles((s) => s.open)
  if (!tool && !filesOpen) return null
  const meta = DOCK_TOOLS.find((item) => item.id === tool)

  return (
    <div className="flex min-h-0 shrink-0 border-l border-qn-border bg-qn-bg">
      {filesOpen && (
        <div className="relative flex min-h-0 flex-col" style={{ width: filesWidth }}>
          <ResizeHandle
            orientation="vertical"
            direction={-1}
            value={filesWidth}
            min={FILES_MIN}
            max={FILES_MAX}
            onChange={(width) => useDock.getState().setFilesWidth(width)}
            label="调整文件面板宽度"
            className="absolute inset-y-0 -left-1 z-10"
          />
          <FilePane scope={'reason' in scope ? undefined : scope} className="min-h-0 flex-1" />
        </div>
      )}
      {tool && meta && (
        <div
          className={cn('relative flex min-h-0 flex-col bg-qn-sidebar', filesOpen && 'border-l border-qn-border')}
          style={{ width: toolWidth }}
        >
          <ResizeHandle
            orientation="vertical"
            direction={-1}
            value={toolWidth}
            min={TOOL_MIN}
            max={TOOL_MAX}
            onChange={(width) => useDock.getState().setToolWidth(width)}
            label="调整工具栏宽度"
            className="absolute inset-y-0 -left-1 z-10"
          />
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-qn-border px-2">
            {DOCK_TOOLS.map((item) => (
              <IconButton
                key={item.id}
                label={`${item.label}（${item.hint}）`}
                aria-pressed={item.id === tool}
                onClick={() => useDock.getState().toggleTool(item.id)}
                className={item.id === tool ? 'bg-qn-active text-qn-text' : undefined}
              >
                {item.icon}
              </IconButton>
            ))}
            <span className="ml-1 min-w-0 flex-1 truncate text-ui-sm text-qn-muted">{meta.label}</span>
            <IconButton label="收起" onClick={() => useDock.getState().hideTool()}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ToolBody tool={tool} />
          </div>
        </div>
      )}
    </div>
  )
}

export function ProjectFilesView({ onQuickOpen }: { onQuickOpen: () => void }) {
  const scope = useWorkspaceScope()
  const tool = useDock((s) => s.fileTool)
  const width = useDock((s) => s.toolWidth)
  if ('reason' in scope) return <div className="m-auto text-ui-md text-qn-muted">{scope.reason}</div>
  return (
    <main aria-label="项目文件" className="flex min-h-0 min-w-0 flex-1">
      <aside className="relative flex min-h-0 max-w-[45%] flex-col border-r border-qn-border bg-qn-sidebar" style={{ width }}>
        <div className="flex flex-wrap items-center gap-1 border-b border-qn-border p-1.5 text-ui-sm">
          <button type="button" className="qn-button-subtle aria-pressed:bg-qn-active" aria-pressed={tool === 'explorer'}
            onClick={() => useDock.getState().toggleTool('explorer')}>目录</button>
          <button type="button" className="qn-button-subtle" onClick={onQuickOpen} title="Ctrl+P">找文件</button>
          <button type="button" className="qn-button-subtle aria-pressed:bg-qn-active" aria-pressed={tool === 'search'}
            onClick={() => useDock.getState().toggleTool('search')}>搜内容</button>
        </div>
        <ToolBody tool={tool} />
        <ResizeHandle orientation="vertical" value={width} min={TOOL_MIN} max={TOOL_MAX}
          label="调整文件导航宽度" className="absolute inset-y-0 -right-1" onChange={useDock.getState().setToolWidth} />
      </aside>
      <FilePane primary scope={scope} className="min-w-0 flex-1" />
    </main>
  )
}
