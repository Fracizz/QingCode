import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { Project } from '../../../../shared/backendApi'
import { formatRelative } from '../../lib/time'
import { useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useUi } from '../../store/ui'
import { Spinner } from '../ui'

const THREAD_PREVIEW_LIMIT = 8

/**
 * 项目 → 会话两级树（参考 t3code 侧栏）：会话直接挂在项目下面，不再单独占一栏。
 * 会话列表按当前项目 cwd 加载（codex store 一次只持有一个 cwd 的列表），所以同一时间只展开当前项目。
 */
export function ProjectTree({ targetId }: { targetId: string }) {
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const loading = useProjects((s) => s.loading)
  const projectError = useProjects((s) => s.error)
  const load = useProjects((s) => s.load)
  const select = useProjects((s) => s.select)
  const remove = useProjects((s) => s.remove)
  const openPicker = useUi((s) => s.openDirectoryPicker)

  const [collapsed, setCollapsed] = useState(false)
  // 相对时间每分钟刷新一次即可。
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void load(targetId)
  }, [targetId, load])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const onProjectClick = (project: Project) => {
    if (project.id === selectedId) {
      setCollapsed((value) => !value)
      return
    }
    setCollapsed(false)
    void select(project)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[11px] font-medium tracking-wider text-qn-dim">项目</span>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          title="添加项目"
          aria-label="添加项目"
          onClick={openPicker}
        >
          <FolderPlus size={14} />
        </button>
      </div>

      <div className="qn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && projects.length === 0 && (
          <div className="space-y-1.5 px-2 py-2">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-7 animate-pulse rounded-md bg-qn-panel" />
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && !projectError && (
          <div className="mx-2 mt-2 rounded-lg border border-dashed border-qn-border-strong px-3 py-5 text-center">
            <FolderPlus size={20} className="mx-auto text-qn-dim" />
            <p className="mt-2 text-xs leading-5 text-qn-muted">还没有项目。添加一个目录，会话会按目录组织。</p>
            <button type="button" className="qn-button-subtle mt-3" onClick={openPicker}>
              添加项目
            </button>
          </div>
        )}

        {projects.map((project) => {
          const active = project.id === selectedId
          const expanded = active && !collapsed
          return (
            <div key={project.id} className="mb-px">
              <div
                className={`group flex h-8 items-center gap-1 rounded-md pl-1 pr-1 text-[13px] ${
                  active ? 'text-qn-text' : 'text-qn-text/85 hover:bg-qn-hover'
                } ${active && !expanded ? 'bg-qn-hover' : ''}`}
                title={project.path}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-expanded={expanded}
                  onClick={() => onProjectClick(project)}
                >
                  <ChevronRight
                    size={13}
                    className={`shrink-0 text-qn-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
                  />
                  {expanded ? (
                    <FolderOpen size={14} className="shrink-0 text-qn-brand" />
                  ) : (
                    <Folder size={14} className="shrink-0 text-qn-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </button>
                <span className="shrink-0 pr-1 text-[10px] text-qn-dim group-hover:hidden">
                  {formatRelative(project.lastOpenedAt, now)}
                </span>
                <span className="hidden shrink-0 items-center group-hover:flex">
                  <TreeButton
                    label="在此项目新建会话"
                    onClick={() => {
                      if (!active) void select(project).then(() => void useCodex.getState().newThread())
                      else void useCodex.getState().newThread()
                      setCollapsed(false)
                    }}
                  >
                    <MessageSquarePlus size={13} />
                  </TreeButton>
                  <TreeButton label="移除项目（不删除磁盘文件）" danger onClick={() => void remove(project.id)}>
                    <Trash2 size={13} />
                  </TreeButton>
                </span>
              </div>
              {expanded && <ThreadList now={now} />}
            </div>
          )
        })}

        {projectError && (
          <div className="mx-1 mt-2 flex items-start gap-2 rounded-md bg-qn-danger/10 px-2 py-1.5 text-[11px] text-qn-danger">
            <span className="min-w-0 flex-1">{projectError}</span>
            <button type="button" className="shrink-0 underline" onClick={() => void load(targetId)}>
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ThreadList({ now }: { now: number }) {
  const threads = useCodex((s) => s.threads)
  const threadsLoading = useCodex((s) => s.threadsLoading)
  const threadsError = useCodex((s) => s.threadsError)
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentTargetId = useCodex((s) => s.currentTargetId)
  const threadViews = useCodex((s) => (s.currentTargetId ? s.sessions[s.currentTargetId]?.state.threads : undefined))
  const openError = useCodex((s) => (s.currentTargetId ? s.sessions[s.currentTargetId]?.openError : null))
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const newThread = useCodex((s) => s.newThread)
  const openThread = useCodex((s) => s.openThread)
  const [showAll, setShowAll] = useState(false)

  const shown = showAll ? threads : threads.slice(0, THREAD_PREVIEW_LIMIT)
  const hidden = threads.length - shown.length

  return (
    <div className="relative ml-[13px] border-l border-qn-border pb-1 pl-1.5">
      {threadsLoading && threads.length === 0 && (
        <div className="px-2 py-1.5">
          <Spinner label="加载会话…" />
        </div>
      )}

      {!threadsLoading && threads.length === 0 && !threadsError && (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          onClick={() => void newThread()}
        >
          <MessageSquarePlus size={13} /> 暂无会话，新建一个
        </button>
      )}

      {shown.map((thread) => {
        const current = thread.id === currentThreadId
        const running = threadViews?.[thread.id]?.status === 'running'
        const waiting = (threadViews?.[thread.id]?.pendingApprovals.length ?? 0) > 0
        return (
          <button
            key={thread.id}
            type="button"
            className={`relative flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-1.5 text-left text-xs ${
              current ? 'bg-qn-active text-qn-text' : 'text-qn-text/75 hover:bg-qn-hover hover:text-qn-text'
            }`}
            title={thread.preview || thread.title}
            onClick={() => void openThread(thread.id)}
          >
            {/* 青轨：当前会话的唯一强调，沿用旧版 QingCode 的 Qing Rail。 */}
            {current && <span className="absolute -left-[7px] top-1.5 bottom-1.5 w-[2px] rounded-full bg-qn-brand" />}
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            {waiting ? (
              <span className="shrink-0 rounded bg-qn-warn/15 px-1 text-[10px] text-qn-warn">待审批</span>
            ) : running ? (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-qn-brand" title="运行中" />
            ) : (
              <span className="shrink-0 text-[10px] text-qn-dim">{formatRelative(thread.updatedAt, now)}</span>
            )}
          </button>
        )
      })}

      {hidden > 0 && (
        <button
          type="button"
          className="w-full rounded-md px-2 py-1 text-left text-[11px] text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          onClick={() => setShowAll(true)}
        >
          显示其余 {hidden} 个会话
        </button>
      )}

      {/* 打开失败的原因已在对话区横幅展示，这里只在两者不同时补充。 */}
      {threadsError && threadsError !== openError && (
        <div className="mx-1 mt-1 flex items-start gap-2 rounded-md bg-qn-danger/10 px-2 py-1.5 text-[11px] text-qn-danger">
          <span className="min-w-0 flex-1 break-words">{threadsError}</span>
          <button type="button" className="shrink-0" title="重试" onClick={() => void refreshThreads()}>
            <RefreshCw size={12} />
          </button>
        </div>
      )}
      {threadsError && threadsError === openError && currentTargetId && (
        <div className="px-2 py-1 text-[11px] text-qn-dim">会话列表不可用</div>
      )}
    </div>
  )
}

function TreeButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`inline-flex h-6 w-6 items-center justify-center rounded text-qn-muted hover:bg-white/10 ${
        danger ? 'hover:text-qn-danger' : 'hover:text-qn-text'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
