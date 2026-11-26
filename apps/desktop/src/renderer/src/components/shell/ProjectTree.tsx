import { useEffect, useMemo, useState } from 'react'
import { FolderPlus, RotateCw, SquarePen, Trash2 } from 'lucide-react'
import type { Project } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { applyThreadPrefs } from '../../lib/threadPrefs'
import { threadKey } from '../../lib/threads'
import { formatRelative } from '../../lib/time'
import { useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { useThreadPrefs } from '../../store/threadPrefs'
import { useUi } from '../../store/ui'
import { IconButton, Spinner } from '../ui'
import { ThreadRow } from './ThreadRow'

const THREAD_PREVIEW_LIMIT = 8

/**
 * 项目 → 会话两级树（参考 Codex 侧栏）：会话直接缩进挂在项目下面，不再单独占一栏。
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

  const newDraftIn = (project: Project) => {
    // 先切到该项目再进入草稿态：会话在发第一条消息时才创建，不留空会话。
    if (project.id !== selectedId) void select(project).then(() => useCodex.getState().startDraft())
    else useCodex.getState().startDraft()
    setCollapsed(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between pb-1 pl-4 pr-2 pt-3">
        <span className="text-[13px] text-qn-muted">项目</span>
        <IconButton label="添加项目" className="h-7 w-7" onClick={openPicker}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      <div className="qn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && projects.length === 0 && (
          <div className="space-y-1.5 px-2 py-2">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-8 animate-pulse rounded-lg bg-qn-panel" />
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && !projectError && (
          <div className="mx-2 mt-2 rounded-xl border border-dashed border-qn-border-strong px-3 py-5 text-center">
            <FolderPlus size={20} className="mx-auto text-qn-dim" />
            <p className="mt-2 text-[13px] leading-5 text-qn-muted">还没有项目。添加一个目录，会话会按目录组织。</p>
            <button type="button" className="qn-button-subtle mt-3" onClick={openPicker}>
              添加项目
            </button>
          </div>
        )}

        {projects.map((project) => {
          const active = project.id === selectedId
          const expanded = active && !collapsed
          return (
            <div key={project.id} className="mb-0.5">
              <div
                className={`group flex h-8 items-center gap-1 rounded-lg pl-2 pr-1 text-[14px] ${
                  active ? 'text-qn-text' : 'text-qn-text/85 hover:bg-qn-hover'
                } ${active && !expanded ? 'bg-qn-hover' : ''}`}
                title={project.path}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
                  aria-expanded={expanded}
                  onClick={() => onProjectClick(project)}
                >
                  <ProjectInitial name={project.name} active={expanded} />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </button>
                <span className="shrink-0 pr-1.5 text-[12px] text-qn-dim group-hover:hidden">
                  {formatRelative(project.lastOpenedAt, now)}
                </span>
                <span className="hidden shrink-0 items-center group-hover:flex">
                  <IconButton label="在此项目新建会话" className="h-7 w-7" onClick={() => newDraftIn(project)}>
                    <SquarePen size={14} />
                  </IconButton>
                  <IconButton
                    label="移除项目（不删除磁盘文件）"
                    danger
                    className="h-7 w-7"
                    onClick={() => void remove(project.id)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </span>
              </div>
              {expanded && <ThreadList now={now} />}
            </div>
          )
        })}

        {projectError && (
          <div className="mx-1 mt-2 flex items-start gap-2 rounded-lg bg-qn-danger/10 px-2.5 py-1.5 text-[12px] text-qn-danger">
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

// 首字母头像配色：按项目名哈希取色，保证同名项目颜色稳定。
const INITIAL_COLORS = [
  'bg-sky-500/20 text-sky-300',
  'bg-emerald-500/20 text-emerald-300',
  'bg-amber-500/20 text-amber-300',
  'bg-violet-500/20 text-violet-300',
  'bg-rose-500/20 text-rose-300',
  'bg-teal-500/20 text-teal-300',
  'bg-orange-500/20 text-orange-300',
  'bg-indigo-500/20 text-indigo-300',
]

function ProjectInitial({ name, active }: { name: string; active: boolean }) {
  const ch = Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? Array.from(name)[0] ?? '?'
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)!) | 0
  const color = INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length]
  return (
    <span
      aria-hidden
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold leading-none ${color} ${
        active ? 'ring-1 ring-qn-brand/70' : ''
      }`}
    >
      {ch.toUpperCase()}
    </span>
  )
}

function ThreadList({ now }: { now: number }) {
  const rawThreads = useCodex((s) => s.threads)
  const threadsLoading = useCodex((s) => s.threadsLoading)
  const threadsError = useCodex((s) => s.threadsError)
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentAgent = useCodex((s) => s.currentAgent)
  const currentTargetId = useCodex((s) => s.currentTargetId)
  const sessions = useCodex((s) => s.sessions)
  const openError = useCodex((s) =>
    s.currentTargetId ? s.sessions[sessionKey(s.currentTargetId, s.currentAgent)]?.openError : null,
  )
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const startDraft = useCodex((s) => s.startDraft)
  const openThread = useCodex((s) => s.openThread)
  const [showAll, setShowAll] = useState(false)
  const prefs = useThreadPrefs((s) => (currentTargetId ? s.byTarget[currentTargetId] : undefined))
  // 本地偏好：置顶在前、隐藏本地归档、套用本地名称。
  const threads = useMemo(() => applyThreadPrefs(rawThreads, prefs), [rawThreads, prefs])

  const shown = showAll ? threads : threads.slice(0, THREAD_PREVIEW_LIMIT)
  const hidden = threads.length - shown.length

  return (
    <div className="pb-1.5">
      {threadsLoading && threads.length === 0 && (
        <div className="py-1.5 pl-[31px]">
          <Spinner label="加载会话…" />
        </div>
      )}

      {!threadsLoading && threads.length === 0 && !threadsError && (
        <button
          type="button"
          className="flex h-8 w-full items-center rounded-lg pl-[31px] text-left text-[13px] text-qn-dim hover:bg-qn-hover hover:text-qn-text"
          onClick={() => startDraft()}
        >
          暂无会话，开始一个
        </button>
      )}

      {shown.map((thread) => {
        const view = currentTargetId
          ? sessions[sessionKey(currentTargetId, thread.agent)]?.state.threads[thread.id]
          : undefined
        return (
          <ThreadRow
            key={threadKey(thread.agent, thread.id)}
            thread={thread}
            now={now}
            current={thread.id === currentThreadId && thread.agent === currentAgent}
            running={view?.status === 'running'}
            waiting={(view?.pendingApprovals.length ?? 0) > 0}
          />
        )
      })}

      {hidden > 0 && (
        <button
          type="button"
          className="h-7 w-full rounded-lg pl-[31px] text-left text-[12px] text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          onClick={() => setShowAll(true)}
        >
          显示其余 {hidden} 个会话
        </button>
      )}

      {/* 打开失败的原因已在对话区横幅展示，这里只在两者不同时补充。 */}
      {threadsError && threadsError !== openError && (
        <div className="mx-1 mt-1 flex items-start gap-2 rounded-lg bg-qn-danger/10 px-2.5 py-1.5 text-[12px] text-qn-danger">
          <span className="min-w-0 flex-1 break-words">{threadsError}</span>
          <button type="button" className="shrink-0" aria-label="重试" onClick={() => void refreshThreads()}>
            <RotateCw size={13} />
          </button>
        </div>
      )}
      {threadsError && threadsError === openError && currentTargetId && (
        <div className="py-1 pl-[31px] text-[12px] text-qn-dim">会话列表不可用</div>
      )}
    </div>
  )
}
