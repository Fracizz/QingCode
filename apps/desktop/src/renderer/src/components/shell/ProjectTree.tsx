import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Copy, Ellipsis, FolderPlus, Pencil, Pin, PinOff, SquarePen, X } from 'lucide-react'
import { copyText } from '../../lib/clipboard'
import type { Project } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { applyThreadPrefs } from '../../lib/threadPrefs'
import { threadKey } from '../../lib/threads'
import { formatRelative } from '../../lib/time'
import { useCodex } from '../../store/codex'
import { projectListOf, useProjects } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { useThreadPrefs } from '../../store/threadPrefs'
import { useUi } from '../../store/ui'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../primitives'
import { ErrorNote, IconButton, Spinner } from '../ui'
import { ThreadRow } from './ThreadRow'

const THREAD_PREVIEW_LIMIT = 8

/**
 * 某个目标下的项目 → 会话两级树（参考 Codex 侧栏）：侧栏里每个铺开的目标各渲染一份。
 * 会话列表按当前项目 cwd 加载（codex store 一次只持有一个 cwd 的列表），所以全局只展开当前项目。
 */
export function ProjectTree({ targetId, onSelectTarget }: { targetId: string; onSelectTarget: (id: string) => void }) {
  const { projects, loading, error: projectError } = useProjects((s) => projectListOf(s, targetId))
  const selectedId = useProjects((s) => (s.targetId === targetId ? s.selectedId : null))
  const load = useProjects((s) => s.load)
  const select = useProjects((s) => s.select)
  const openPicker = useUi((s) => s.openDirectoryPicker)
  const activeTarget = useTargets((s) => s.selectedId)

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

  /** 切到项目所在目标（未连接时会发起连接），再打开项目。 */
  const open = (project: Project) => {
    if (activeTarget !== targetId) onSelectTarget(targetId)
    void select(project)
  }

  const onProjectClick = (project: Project) => {
    if (project.id === selectedId) {
      setCollapsed((value) => !value)
      return
    }
    setCollapsed(false)
    open(project)
  }

  const newDraftIn = (project: Project) => {
    // 先切到该项目再进入草稿态：会话在发第一条消息时才创建，不留空会话。
    if (project.id !== selectedId) open(project)
    useCodex.getState().startDraft()
    setCollapsed(false)
  }

  return (
    <div className="pb-1">
      {loading && projects.length === 0 && (
        <div className="space-y-1.5 py-1 pl-6 pr-2">
          {[0, 1].map((key) => (
            <div key={key} className="h-7 animate-pulse rounded-lg bg-qn-panel" />
          ))}
        </div>
      )}

      {!loading && projects.length === 0 && !projectError && (
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2 rounded-lg pl-[30px] text-left text-ui text-qn-dim hover:bg-qn-hover hover:text-qn-text"
          onClick={() => openPicker(targetId)}
        >
          <FolderPlus size={14} /> 添加项目
        </button>
      )}

      {projects.map((project) => {
        const active = project.id === selectedId
        const expanded = active && !collapsed
        return (
          <div key={project.id} className="mb-0.5 pl-5">
            <ProjectRow
              project={project}
              active={active}
              expanded={expanded}
              now={now}
              onOpen={() => onProjectClick(project)}
              onNewDraft={() => newDraftIn(project)}
            />
            {expanded && <ThreadList now={now} />}
          </div>
        )
      })}

      <ErrorNote message={projectError} variant="compact" className="mx-1 mt-1" onRetry={() => void load(targetId)} />
    </div>
  )
}

/** 项目行：悬停显示"新建会话"与"更多"菜单（置顶 / 重命名 / 复制路径 / 移除）。 */
function ProjectRow({
  project,
  active,
  expanded,
  now,
  onOpen,
  onNewDraft,
}: {
  project: Project
  active: boolean
  expanded: boolean
  now: number
  onOpen: () => void
  onNewDraft: () => void
}) {
  const pinned = useProjects((s) => s.pinned.includes(project.id))
  const togglePin = useProjects((s) => s.togglePin)
  const rename = useProjects((s) => s.rename)
  const remove = useProjects((s) => s.remove)
  // 菜单打开时保持操作区可见，否则鼠标移进浮层后触发器隐藏、菜单会失去锚点。
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    // 等菜单关闭、焦点归还后再聚焦，否则会被 Radix 抢回去。
    const timer = setTimeout(() => inputRef.current?.select(), 0)
    return () => clearTimeout(timer)
  }, [editing])

  const commit = () => {
    setEditing(false)
    void rename(project, draft)
  }

  if (editing) {
    return (
      <div className="flex h-8 items-center gap-2 pl-2 pr-1">
        <ProjectInitial name={project.name} />
        <input
          ref={inputRef}
          value={draft}
          aria-label="项目名称"
          className="qn-input h-7 min-w-0 flex-1 px-1.5 py-0 text-ui"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') setEditing(false)
          }}
        />
      </div>
    )
  }

  const shortcut = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    const action =
      key === 'p' ? () => togglePin(project.id) : key === 'e' ? () => beginRename() : key === 'c' ? copyPath : null
    if (!action) return
    event.preventDefault()
    setMenuOpen(false)
    action()
  }
  const beginRename = () => {
    setDraft(project.name)
    setEditing(true)
  }
  const copyPath = () => void copyText(project.path)

  return (
    <div
      className={`group flex h-8 items-center gap-1 rounded-lg pl-2 pr-1 text-ui-md ${
        active ? 'text-qn-text' : 'text-qn-text/85 hover:bg-qn-hover'
      } ${(active && !expanded) || menuOpen ? 'bg-qn-hover' : ''}`}
      title={project.path}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
        aria-expanded={expanded}
        onClick={onOpen}
      >
        <ProjectInitial name={project.name} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {pinned && <Pin size={11} className="shrink-0 text-qn-dim" aria-label="已置顶" />}
      </button>
      <span className={`shrink-0 pr-1.5 text-ui-sm text-qn-dim group-hover:hidden ${menuOpen ? 'hidden' : ''}`}>
        {formatRelative(project.lastOpenedAt, now)}
      </span>
      <span className={`shrink-0 items-center group-hover:flex ${menuOpen ? 'flex' : 'hidden'}`}>
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="更多操作"
              className="flex h-7 w-7 items-center justify-center rounded-md text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text data-[state=open]:text-qn-text"
            >
              <Ellipsis size={15} />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-52" onKeyDown={shortcut}>
            <MenuItem icon={pinned ? <PinOff size={14} /> : <Pin size={14} />} hint="P" onSelect={() => togglePin(project.id)}>
              {pinned ? '取消置顶' : '置顶'}
            </MenuItem>
            <MenuItem icon={<Pencil size={14} />} hint="E" onSelect={beginRename}>
              重命名
            </MenuItem>
            <MenuItem icon={<Copy size={14} />} hint="C" onSelect={copyPath}>
              复制路径
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} title="不删除磁盘文件" onSelect={() => void remove(project.id)}>
              移除项目
            </MenuItem>
          </MenuContent>
        </Menu>
        <IconButton label="在此项目新建会话" className="h-7 w-7" onClick={onNewDraft}>
          <SquarePen size={14} />
        </IconButton>
      </span>
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

function ProjectInitial({ name }: { name: string }) {
  const ch = (Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? Array.from(name)[0] ?? '?').toUpperCase()
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)!) | 0
  const color = INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length]
  // 用 SVG 按字形几何居中：CSS 行盒按 ascent/descent 居中，Segoe UI 的大写字母会明显偏上。
  // 拉丁字母/数字以基线 + 约 0.36em 让大写字高居中；中日韩字符用 central 基线。
  const latin = /^[\p{Script=Latin}\p{N}]$/u.test(ch)
  return (
    <span aria-hidden className={`inline-flex h-[18px] w-[18px] shrink-0 rounded-[5px] ${color}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" className="block">
        <text
          x="9"
          y={latin ? 13 : 9}
          textAnchor="middle"
          dominantBaseline={latin ? 'alphabetic' : 'central'}
          fontSize="11"
          fontWeight="600"
          fill="currentColor"
        >
          {ch}
        </text>
      </svg>
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
    <div className="flex flex-col gap-0.5 pt-0.5 pb-1.5">
      {threadsLoading && threads.length === 0 && (
        <div className="py-1.5 pl-[31px]">
          <Spinner label="加载会话…" />
        </div>
      )}

      {!threadsLoading && threads.length === 0 && !threadsError && (
        <button
          type="button"
          className="flex h-8 w-full items-center rounded-lg pl-[31px] text-left text-ui text-qn-dim hover:bg-qn-hover hover:text-qn-text"
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
            view={view}
          />
        )
      })}

      {hidden > 0 && (
        <button
          type="button"
          className="h-7 w-full rounded-lg pl-[31px] text-left text-ui-sm text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          onClick={() => setShowAll(true)}
        >
          显示其余 {hidden} 个会话
        </button>
      )}

      {/* 打开失败的原因已在对话区横幅展示，这里只在两者不同时补充。 */}
      {threadsError && threadsError !== openError && (
        <ErrorNote
          message={threadsError}
          variant="compact"
          className="mx-1 mt-1"
          retryIcon
          onRetry={() => void refreshThreads()}
        />
      )}
      {threadsError && threadsError === openError && currentTargetId && (
        <div className="py-1 pl-[31px] text-ui-sm text-qn-dim">会话列表不可用</div>
      )}
    </div>
  )
}
