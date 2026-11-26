import type { ReactNode } from 'react'
import { FolderPlus, MessageSquarePlus, PlugZap, ServerCog } from 'lucide-react'
import { isTargetActive, isTargetBusy, targetStateLabel } from '../../lib/targetStatus'
import { useProjects } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { useCodex } from '../../store/codex'
import { Logo } from './Logo'

/**
 * 未打开会话时的主区（参考 Codex 桌面版 / t3code 的空态）：
 * 一句话说明当前上下文，再给出"下一步"只有一个主操作——未连接就连接，没项目就加项目，否则新建会话。
 */
export function WelcomePane({ onConnect, onAddTarget }: { onConnect: (id: string) => void; onAddTarget: () => void }) {
  const targets = useTargets((s) => s.targets)
  const selectedId = useTargets((s) => s.selectedId)
  const state = useTargets((s) => s.states[s.selectedId]?.state ?? 'idle')
  const projects = useProjects((s) => s.projects)
  const projectId = useProjects((s) => s.selectedId)
  const openPicker = useUi((s) => s.openDirectoryPicker)
  const newThread = useCodex((s) => s.newThread)

  const target = targets.find((item) => item.id === selectedId)
  const project = projects.find((item) => item.id === projectId)
  const ready = state === 'ready'

  const primary: 'connect' | 'project' | 'thread' = !isTargetActive(state)
    ? 'connect'
    : projects.length === 0
      ? 'project'
      : 'thread'

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-10">
      <div className="relative">
        <div
          className="pointer-events-none absolute -inset-16 -z-10"
          style={{ background: 'radial-gradient(circle, rgba(78,205,181,0.14) 0%, rgba(78,205,181,0) 65%)' }}
        />
        <Logo size={44} />
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-wide text-qn-text">和 Codex 一起工作</h1>
      <p className="mt-2 max-w-md text-center text-[13px] leading-6 text-qn-muted">
        {target?.name ?? '本机'}
        <span className="mx-1.5 text-qn-dim">·</span>
        {project ? <span className="font-mono text-xs">{project.path}</span> : '未选择项目'}
        {!ready && (
          <>
            <span className="mx-1.5 text-qn-dim">·</span>
            <span className={state === 'error' ? 'text-qn-danger' : ''}>{targetStateLabel[state]}</span>
          </>
        )}
      </p>

      <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-3">
        <ActionCard
          icon={<PlugZap size={16} />}
          title={isTargetBusy(state) ? '正在连接…' : ready ? '已连接' : `连接${target?.name ?? '本机'}`}
          hint={ready ? '目标已就绪' : '部署并启动 server'}
          primary={primary === 'connect'}
          disabled={isTargetActive(state)}
          onClick={() => onConnect(selectedId)}
        />
        <ActionCard
          icon={<FolderPlus size={16} />}
          title="添加项目"
          hint="浏览目标上的目录"
          primary={primary === 'project'}
          onClick={openPicker}
        />
        <ActionCard
          icon={<MessageSquarePlus size={16} />}
          title="新建会话"
          hint={project ? `在 ${project.name} 中` : '不选项目也可以'}
          kbd="Ctrl N"
          primary={primary === 'thread'}
          onClick={() => void newThread()}
        />
      </div>

      <button
        type="button"
        className="mt-6 flex items-center gap-1.5 text-xs text-qn-muted hover:text-qn-text"
        onClick={onAddTarget}
      >
        <ServerCog size={13} /> 添加 SSH 连接，在远端主机上使用 Codex
      </button>
    </div>
  )
}

function ActionCard({
  icon,
  title,
  hint,
  kbd,
  primary,
  disabled,
  onClick,
}: {
  icon: ReactNode
  title: string
  hint: string
  kbd?: string
  primary?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`group flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-default ${
        primary
          ? 'border-qn-accent/50 bg-qn-accent/[0.08] hover:bg-qn-accent/[0.14]'
          : 'border-qn-border bg-qn-panel/60 hover:border-qn-border-strong hover:bg-qn-panel'
      }`}
      onClick={onClick}
    >
      <span className="flex w-full items-center justify-between">
        <span className={primary ? 'text-qn-accent' : 'text-qn-muted group-hover:text-qn-text'}>{icon}</span>
        {kbd && (
          <kbd className="rounded border border-qn-border-strong px-1 font-sans text-[10px] text-qn-dim">{kbd}</kbd>
        )}
      </span>
      <span>
        <span className="block text-[13px] font-medium text-qn-text">{title}</span>
        <span className="mt-0.5 block text-[11px] text-qn-muted">{hint}</span>
      </span>
    </button>
  )
}
