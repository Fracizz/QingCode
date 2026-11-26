import { useEffect, useState } from 'react'
import { Bot, FolderGit2, Monitor, Server } from 'lucide-react'
import { isTargetActive, targetDotClass, targetStateLabel } from '../../lib/targetStatus'
import { useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useTargets } from '../../store/targets'

/**
 * 底部状态栏（参考 Orca / VS Code）：只放"一眼可知"的运行信息——目标连接、Agent 进程、当前目录、版本。
 * 可点的项（未连接时点击连接）用 hover 底色提示，不用强调色抢注意力。
 */
export function StatusBar({ onConnect }: { onConnect: (id: string) => void }) {
  const targets = useTargets((s) => s.targets)
  const selectedId = useTargets((s) => s.selectedId)
  const targetEvent = useTargets((s) => s.states[s.selectedId])
  const projects = useProjects((s) => s.projects)
  const projectId = useProjects((s) => s.selectedId)
  const session = useCodex((s) => (s.currentTargetId ? s.sessions[s.currentTargetId] : undefined))
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.qn?.version().then(setVersion).catch(() => undefined)
  }, [])

  const target = targets.find((item) => item.id === selectedId)
  const state = targetEvent?.state ?? 'idle'
  const project = projects.find((item) => item.id === projectId)
  const TargetIcon = target?.kind === 'ssh' ? Server : Monitor

  const agentText = session?.opening
    ? '启动中…'
    : session?.opened
      ? '已就绪'
      : session?.openError
        ? '不可用'
        : '未启动'
  const agentClass = session?.openError && !session.opened ? 'text-qn-danger' : ''

  return (
    <footer
      className="qn-enter flex h-6 shrink-0 items-center gap-0.5 border-t border-qn-border bg-qn-chrome px-1.5 text-[11px] text-qn-muted select-none"
      style={{ ['--qn-enter-order' as string]: 3 }}
    >
      <button
        type="button"
        className="flex h-full items-center gap-1.5 rounded px-1.5 hover:bg-qn-hover hover:text-qn-text"
        title={isTargetActive(state) ? targetEvent?.detail : '点击连接'}
        onClick={() => {
          if (!isTargetActive(state)) onConnect(selectedId)
        }}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${targetDotClass[state]}`} />
        <TargetIcon size={12} />
        <span className="text-qn-text/85">{target?.name ?? '本机'}</span>
        <span className={state === 'error' ? 'text-qn-danger' : ''}>{targetStateLabel[state]}</span>
        {targetEvent?.detail && state !== 'error' && state !== 'ready' && (
          <span className="max-w-[18rem] truncate">· {targetEvent.detail}</span>
        )}
      </button>

      <span className="flex h-full items-center gap-1 px-1.5" title="当前目标上的 Codex 进程">
        <Bot size={12} />
        Codex <span className={agentClass}>{agentText}</span>
      </span>

      {project && (
        <span className="flex h-full min-w-0 items-center gap-1 px-1.5" title={project.path}>
          <FolderGit2 size={12} className="shrink-0 text-qn-brand" />
          <span className="truncate font-mono text-[10.5px]">{project.path}</span>
        </span>
      )}

      <span className="ml-auto flex h-full shrink-0 items-center gap-3 px-1.5">
        <span className="hidden lg:inline">Ctrl+B 侧栏 · Ctrl+N 新会话</span>
        {version && <span>v{version}</span>}
      </span>
    </footer>
  )
}
